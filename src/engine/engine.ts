import * as mupdf from 'mupdf'
import { DocFonts, FontBook, encodeForFace, segmentWidth, type FontLoader } from './fonts.ts'
import { OVERLAY_LABEL, overlayBounds, overlayColors, overlayPrims, primsToContent, type ContentContext, type PathPrim, type Prim } from './overlay.ts'
import { isMoved, planEdit, rectsOverlap } from './plan.ts'
import { CELL_PAD_X, CELL_PAD_Y, LINE_HEIGHT, MIN_ROW, cellRect, cellStyle, colCount, detectGrid, inferGrid, rowCount, tableBounds, tableLines, wrapLines, type Graphics } from './table.ts'
import type {
  Edit,
  EditPlan,
  EditVerdict,
  ExportOptions,
  ExportResult,
  FontStyle,
  OpenResult,
  PageInfo,
  PageVerdict,
  PngResult,
  Pt,
  Rect,
  RenderResult,
  Rgb,
  TableEdit,
  TableModel,
  TextLayer,
  TextRun,
  VerifyReport,
} from './types.ts'

// ---------------------------------------------------------------------------------------------
// IMPORTANT (MuPDF WASM): every Uint8Array that MuPDF hands back (asPNG, asJPEG, getPixels,
// saveToBuffer().asUint8Array()) is a *view into WASM memory*. Any later allocation can grow
// that memory and detach the view (it then reads as length 0). Always copy with .slice()
// immediately, and never hold a getPixels() view across another MuPDF call.
// ---------------------------------------------------------------------------------------------

const num = (v: number) => +v.toFixed(4)
const rgb01 = (c: Rgb) => `${num(c[0] / 255)} ${num(c[1] / 255)} ${num(c[2] / 255)}`
const isRaster = (k: PageInfo['kind']) => k === 'scan' || k === 'scan-ocr' || k === 'outlined'
/** A page full of vector shapes and no text objects is almost certainly text converted to outlines. */
const OUTLINE_MIN_SHAPES = 150
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const growRect = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d]

/** What overlay drawing adds to a page: content operators plus the resources they name. */
interface OverlayContent {
  ops: string[]
  gstates: [string, mupdf.PDFObject][]
  xobjects: [string, mupdf.PDFObject][]
}

/** Box around a path primitive (page space), padded for its stroke. */
function pathBounds(p: PathPrim): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const s of p.segs) {
    for (let i = 1; i + 1 < s.length; i += 2) {
      x0 = Math.min(x0, s[i] as number)
      x1 = Math.max(x1, s[i] as number)
      y0 = Math.min(y0, s[i + 1] as number)
      y1 = Math.max(y1, s[i + 1] as number)
    }
  }
  const pad = (p.stroke ? p.width : 0) + 2
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad]
}

function toRgb255(c: number[]): Rgb {
  if (c.length === 1) {
    const g = Math.round(c[0] * 255)
    return [g, g, g]
  }
  if (c.length === 4) {
    const [C, M, Y, K] = c
    return [Math.round(255 * (1 - C) * (1 - K)), Math.round(255 * (1 - M) * (1 - K)), Math.round(255 * (1 - Y) * (1 - K))]
  }
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)]
}

export function detectStyle(
  fontName: string,
  f: { bold: boolean; italic: boolean; serif: boolean; mono: boolean },
  size: number,
  color: Rgb,
): FontStyle {
  const name = fontName.replace(/^[A-Z]{6}\+/, '')
  const mono = f.mono || /mono|courier|consol|typewriter|menlo/i.test(name)
  const serif =
    !mono &&
    !/sans|arial|helvet|calibri|verdana|tahoma|segoe/i.test(name) &&
    (f.serif || /times|georgia|garamond|palatino|cambria|minion|serif|roman|book|didot|baskerville/i.test(name))
  return {
    family: mono ? 'mono' : serif ? 'serif' : 'sans',
    bold: f.bold || /bold|black|heavy|semibold|demi/i.test(name),
    italic: f.italic || /italic|oblique|slanted/i.test(name),
    size: Math.round(size * 100) / 100,
    color,
  }
}

interface Ch {
  c: string
  ox: number
  oy: number
  size: number
  left: number
  right: number
  top: number
  bottom: number
  fname: string
  fl: { bold: boolean; italic: boolean; serif: boolean; mono: boolean }
  color: number[]
}

/** Deterministic PRNG so scan patches (and tests) are reproducible. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class PdfEngine {
  readonly book: FontBook
  private original: Uint8Array | null = null
  private password: string | undefined
  private doc: mupdf.PDFDocument | null = null
  private infos = new Map<number, PageInfo>()
  private runCache = new Map<number, TextRun[]>()
  /** pictures that overlays refer to by id (logos, photos) */
  private images = new Map<string, Uint8Array>()
  private graphicsCache = new Map<number, Graphics>()

  constructor(loader: FontLoader) {
    this.book = new FontBook(loader)
  }

  /** Register a picture (JPEG/PNG/…) so overlays can use it. Returns its pixel size. */
  addImage(id: string, bytes: Uint8Array): { width: number; height: number } {
    const img = new mupdf.Image(bytes.slice()) // throws if MuPDF can't read it
    const size = { width: img.getWidth(), height: img.getHeight() }
    img.destroy()
    this.images.set(id, bytes.slice())
    return size
  }

  // ---------------------------------------------------------------------------------------- open

  /**
   * Open a file. The file that is open now is only let go once the new one has really opened: a file that is broken,
   * not a PDF, or still waiting for its password must leave what you are editing exactly as it was.
   */
  open(bytes: Uint8Array, password?: string): OpenResult {
    let d: mupdf.Document
    try {
      d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf')
    } catch (e) {
      return { status: 'error', message: `Could not open this file: ${String((e as Error).message ?? e)}` }
    }
    const reject = <T,>(r: T): T => {
      try {
        d.destroy()
      } catch {
        /* nothing to free */
      }
      return r
    }
    if (!d.isPDF()) return reject({ status: 'error' as const, message: 'This file is not a PDF.' })
    if (d.needsPassword()) {
      if (!password || !d.authenticatePassword(password)) return reject({ status: 'password' as const })
    }
    this.dispose()
    const pdf = d.asPDF()!
    this.original = bytes.slice()
    this.password = password
    this.doc = pdf
    const sizes = []
    const count = pdf.countPages()
    for (let i = 0; i < count; i++) {
      const p = pdf.loadPage(i)
      const [x0, y0, x1, y1] = p.getBounds()
      sizes.push({ width: x1 - x0, height: y1 - y0 })
      p.destroy()
    }
    return { status: 'ok', sizes, title: pdf.getMetaData('info:Title') ?? '' }
  }

  dispose() {
    this.doc?.destroy()
    this.doc = null
    this.original = null
    this.infos.clear()
    this.runCache.clear()
    this.graphicsCache.clear()
    this.images.clear() // pictures placed on the previous document are not needed any more
  }

  private get d(): mupdf.PDFDocument {
    if (!this.doc) throw new Error('No document open')
    return this.doc
  }

  private openFresh(): mupdf.PDFDocument {
    const doc = mupdf.Document.openDocument(this.original!.slice(), 'application/pdf')
    if (doc.needsPassword()) doc.authenticatePassword(this.password ?? '')
    return doc.asPDF()!
  }

  // ------------------------------------------------------------------------------ page analysis

  analyze(index: number): PageInfo {
    const cached = this.infos.get(index)
    if (cached) return cached
    const page = this.d.loadPage(index)
    const [bx0, by0, bx1, by1] = page.getBounds()
    const pageArea = (bx1 - bx0) * (by1 - by0)
    let visible = 0
    let hidden = 0
    let shapes = 0
    let best = { area: 0, dpi: 0, gray: false }
    const countGlyphs = (t: mupdf.Text, into: 'v' | 'h') =>
      t.walk({
        showGlyph() {
          if (into === 'v') visible++
          else hidden++
        },
      })
    const onImage = (image: mupdf.Image, ctm: mupdf.Matrix) => {
      const wPt = Math.hypot(ctm[0], ctm[1])
      const hPt = Math.hypot(ctm[2], ctm[3])
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])
      if (area > best.area) {
        best = { area, dpi: wPt > 0 ? image.getWidth() / (wPt / 72) : 0, gray: image.getNumberOfComponents() === 1 || image.getImageMask() }
      }
      void hPt
    }
    const dev = new mupdf.Device({
      fillText: (t: mupdf.Text) => countGlyphs(t, 'v'),
      strokeText: (t: mupdf.Text) => countGlyphs(t, 'v'),
      ignoreText: (t: mupdf.Text) => countGlyphs(t, 'h'),
      fillPath: () => void shapes++,
      fillImage: onImage,
      fillImageMask: (image: mupdf.Image, ctm: mupdf.Matrix) => onImage(image, ctm),
    } as never)
    try {
      page.run(dev, mupdf.Matrix.identity)
    } catch {
      /* a broken content stream should not stop us from opening the page */
    }
    dev.close()
    dev.destroy()
    page.destroy()

    const coverage = pageArea > 0 ? Math.min(1, best.area / pageArea) : 0
    let kind: PageInfo['kind']
    if (visible >= 5) kind = 'text'
    else if (coverage >= 0.5) kind = hidden >= 5 ? 'scan-ocr' : 'scan'
    else if (shapes >= OUTLINE_MIN_SHAPES) kind = 'outlined'
    else kind = 'blank'

    const info: PageInfo = {
      index,
      width: bx1 - bx0,
      height: by1 - by0,
      kind,
      visibleChars: visible,
      hiddenChars: hidden,
      imageCoverage: coverage,
      imageDpi: coverage >= 0.5 && best.dpi > 0 ? Math.round(best.dpi) : null,
      imageGray: best.gray,
    }
    this.infos.set(index, info)
    return info
  }

  // -------------------------------------------------------------------------------------- tables

  /** Ruled lines and filled boxes on the page (page space), in painting order. */
  private graphics(index: number): Graphics {
    const hit = this.graphicsCache.get(index)
    if (hit) return hit
    const g: Graphics = { h: [], v: [], fills: [] }
    const page = this.d.loadPage(index)
    const subpaths = (path: mupdf.Path, ctm: number[]): { pts: Pt[]; closed: boolean }[] => {
      const out: { pts: Pt[]; closed: boolean }[] = []
      const tr = (x: number, y: number): Pt => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]
      let cur: { pts: Pt[]; closed: boolean } | null = null
      path.walk({
        moveTo(x, y) {
          cur = { pts: [tr(x, y)], closed: false }
          out.push(cur)
        },
        lineTo(x, y) {
          cur?.pts.push(tr(x, y))
        },
        curveTo(_a, _b, _c, _d, x, y) {
          cur?.pts.push(tr(x, y)) // a curve is no part of a ruled grid; its end point just keeps the path in one piece
          if (cur) cur.closed = false
        },
        closePath() {
          if (cur) {
            cur.pts.push(cur.pts[0])
            cur.closed = true
          }
        },
      })
      return out
    }
    const axis = (a: Pt, b: Pt) => (Math.abs(a[1] - b[1]) < 0.05 ? 'h' : Math.abs(a[0] - b[0]) < 0.05 ? 'v' : null)
    const dev = new mupdf.Device({
      fillPath: (path: mupdf.Path, _eo: boolean, ctm: number[], _cs: mupdf.ColorSpace, color: number[]) => {
        for (const sp of subpaths(path, ctm)) {
          const p = sp.pts
          // only plain boxes: 4 or 5 points, every edge horizontal or vertical
          if (p.length < 4 || p.length > 5 || !p.slice(1).every((q, i) => axis(p[i], q))) continue
          const xs = p.map((q) => q[0])
          const ys = p.map((q) => q[1])
          const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
          const w = r[2] - r[0]
          const h = r[3] - r[1]
          const rgb = toRgb255(color)
          if (Math.min(w, h) <= 2.5) {
            // borders are often drawn as hair-thin filled boxes
            if (w >= h) g.h.push({ at: (r[1] + r[3]) / 2, a: r[0], b: r[2], width: Math.max(0.25, h), color: rgb })
            else g.v.push({ at: (r[0] + r[2]) / 2, a: r[1], b: r[3], width: Math.max(0.25, w), color: rgb })
          } else g.fills.push({ rect: r, color: rgb })
        }
      },
      strokePath: (path: mupdf.Path, stroke: mupdf.StrokeState, ctm: number[], _cs: mupdf.ColorSpace, color: number[]) => {
        const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
        const width = stroke.getLineWidth() * scale
        const rgb = toRgb255(color)
        for (const sp of subpaths(path, ctm)) {
          sp.pts.slice(1).forEach((q, i) => {
            const p0 = sp.pts[i]
            const dir = axis(p0, q)
            if (dir === 'h') g.h.push({ at: (p0[1] + q[1]) / 2, a: Math.min(p0[0], q[0]), b: Math.max(p0[0], q[0]), width, color: rgb })
            else if (dir === 'v') g.v.push({ at: (p0[0] + q[0]) / 2, a: Math.min(p0[1], q[1]), b: Math.max(p0[1], q[1]), width, color: rgb })
          })
        }
      },
    } as never)
    try {
      page.run(dev, mupdf.Matrix.identity)
    } catch {
      /* use whatever was drawn before the stream broke */
    }
    dev.close()
    dev.destroy()
    page.destroy()
    this.graphicsCache.set(index, g)
    return g
  }

  /**
   * Find the table under page point (x, y). Needs a page with real text and lines (not a scan).
   * `reason` says why nothing was found, so the UI can tell the user what to do.
   */
  detectTable(index: number, x: number, y: number): { edit: TableEdit | null; reason?: string } {
    if (isRaster(this.analyze(index).kind)) return { edit: null, reason: 'scan' }
    const edit = detectGrid(this.graphics(index), this.getRuns(index), [x, y])
    return edit ? { edit } : { edit: null, reason: 'no-grid' }
  }

  /** Build a table from the text inside a box the user dragged (for tables without ruled lines). */
  inferTable(index: number, rect: Rect): { edit: TableEdit | null; reason?: string } {
    if (isRaster(this.analyze(index).kind)) return { edit: null, reason: 'scan' }
    const edit = inferGrid(this.graphics(index), this.getRuns(index), rect)
    return edit ? { edit } : { edit: null, reason: 'no-text' }
  }

  /** Lines of text for each cell, wrapped to the column width. */
  private async cellLines(m: TableModel): Promise<string[][][]> {
    const out: string[][][] = []
    for (let r = 0; r < m.cells.length; r++) {
      const row: string[][] = []
      for (let c = 0; c < m.cells[r].length; c++) {
        const cell = m.cells[r][c]
        const style = cellStyle(cell)
        const maxW = Math.max(4, m.xs[c + 1] - m.xs[c] - 2 * CELL_PAD_X)
        row.push(!cell.text ? [''] : m.wrap === false ? [cell.text] : await wrapLines(cell.text, maxW, (s) => this.book.measure(s, style)))
      }
      out.push(row)
    }
    return out
  }

  /**
   * Make rows tall enough for their wrapped text. `grow` only enlarges rows that are too small; `exact` also shrinks
   * rows that are taller than their text needs.
   */
  async fitTable(m: TableModel, mode: 'grow' | 'exact'): Promise<TableModel> {
    const lines = await this.cellLines(m)
    const ys = [m.ys[0]]
    for (let r = 0; r < m.cells.length; r++) {
      const need = Math.max(MIN_ROW, ...m.cells[r].map((cell, c) => (cell.text ? lines[r][c].length * cell.size * LINE_HEIGHT + 2 * CELL_PAD_Y : 0)))
      const have = m.ys[r + 1] - m.ys[r]
      ys.push(ys[r] + (mode === 'exact' ? need : Math.max(have, need)))
    }
    return { ...m, ys }
  }

  /** Paint a table: backgrounds, then the border lines, then each cell's text (page space, y down). */
  private async tableOps(m: TableModel, fonts: DocFonts): Promise<string[]> {
    const ops: string[] = []
    for (let r = 0; r < m.cells.length; r++) {
      for (let c = 0; c < m.cells[r].length; c++) {
        const fill = m.cells[r][c].fill
        if (!fill) continue
        const [x0, y0, x1, y1] = cellRect(m, r, c)
        ops.push(`${rgb01(fill)} rg ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f`)
      }
    }
    const { h, v } = tableLines(m)
    if (h.length || v.length) {
      ops.push(`${rgb01(m.borders.color)} RG ${num(m.borders.width)} w 2 J 0 j`) // projecting caps make the corners meet
      for (const l of h) ops.push(`${num(l.x0)} ${num(l.y)} m ${num(l.x1)} ${num(l.y)} l S`)
      for (const l of v) ops.push(`${num(l.x)} ${num(l.y0)} m ${num(l.x)} ${num(l.y1)} l S`)
    }
    const lines = await this.cellLines(m)
    for (let r = 0; r < m.cells.length; r++) {
      for (let c = 0; c < m.cells[r].length; c++) {
        const cell = m.cells[r][c]
        if (!cell.text.trim()) continue
        const style = cellStyle(cell)
        const [x0, y0, x1, y1] = cellRect(m, r, c)
        const lh = cell.size * LINE_HEIGHT
        const top = y0 + (y1 - y0 - lines[r][c].length * lh) / 2
        ops.push(`${rgb01(cell.color)} rg`)
        for (let i = 0; i < lines[r][c].length; i++) {
          const text = lines[r][c][i]
          if (!text) continue
          const { segments } = await this.book.segment(text, style)
          const width = segments.reduce((s, g) => s + segmentWidth(g.face, g.text, cell.size), 0)
          let cx = cell.align === 'right' ? x1 - CELL_PAD_X - width : cell.align === 'center' ? (x0 + x1) / 2 - width / 2 : x0 + CELL_PAD_X
          const baseline = top + i * lh + (lh - cell.size) / 2 + cell.size * 0.82
          for (const seg of segments) {
            ops.push(`BT /${fonts.resource(seg.face)} ${num(cell.size)} Tf 1 0 0 -1 ${num(cx)} ${num(baseline)} Tm ${encodeForFace(seg.face, seg.text)} Tj ET`)
            cx += segmentWidth(seg.face, seg.text, cell.size)
          }
        }
      }
    }
    return ops
  }

  // ------------------------------------------------------------------------------- text runs

  private chars(page: mupdf.PDFPage): { lines: { dir: mupdf.Point; chars: Ch[] }[] } {
    const st = page.toStructuredText('preserve-whitespace,preserve-spans')
    const lines: { dir: mupdf.Point; chars: Ch[] }[] = []
    let cur: { dir: mupdf.Point; chars: Ch[] } | null = null
    const fontInfo = new Map<number, { name: string; fl: Ch['fl'] }>()
    st.walk({
      beginLine(_bbox, _wmode, dir) {
        cur = { dir, chars: [] }
      },
      onChar(c, origin, font, size, quad, color) {
        if (!cur) return
        let fi = fontInfo.get(font.pointer as number)
        if (!fi) {
          fi = { name: font.getName(), fl: { bold: font.isBold(), italic: font.isItalic(), serif: font.isSerif(), mono: font.isMono() } }
          fontInfo.set(font.pointer as number, fi)
        }
        cur.chars.push({
          c,
          ox: origin[0],
          oy: origin[1],
          size,
          left: Math.min(quad[0], quad[4]),
          right: Math.max(quad[2], quad[6]),
          top: Math.min(quad[1], quad[3]),
          bottom: Math.max(quad[5], quad[7]),
          fname: fi.name,
          fl: fi.fl,
          color: color as number[],
        })
      },
      endLine() {
        if (cur && cur.chars.length) lines.push(cur)
        cur = null
      },
    })
    st.destroy()
    return { lines }
  }

  /** Clickable, editable runs of text on a page (cached so ids stay stable). */
  getRuns(index: number): TextRun[] {
    const cached = this.runCache.get(index)
    if (cached) return cached
    const info = this.analyze(index)
    const page = this.d.loadPage(index)
    const { lines } = this.chars(page)
    page.destroy()
    const runs: TextRun[] = []

    for (const line of lines) {
      if (Math.abs(line.dir[1]) > 0.2 || line.dir[0] < 0) continue // only horizontal, left-to-right text is editable
      let group: Ch[] = []
      const flush = () => {
        while (group.length && group[0].c.trim() === '') group.shift()
        while (group.length && group[group.length - 1].c.trim() === '') group.pop()
        if (group.length) runs.push(this.makeRun(index, runs.length, group, info))
        group = []
      }
      for (const ch of line.chars) {
        const prev = group[group.length - 1]
        if (prev) {
          const colorChanged = ch.color.length !== prev.color.length || ch.color.some((v, i) => Math.abs(v - prev.color[i]) > 0.02)
          const gap = ch.left - prev.right
          if (ch.fname !== prev.fname || Math.abs(ch.size - prev.size) > 0.3 || colorChanged || gap > 0.9 * prev.size || Math.abs(ch.oy - prev.oy) > prev.size * 0.4) {
            flush()
          }
        }
        group.push(ch)
      }
      flush()
    }
    this.runCache.set(index, runs)
    return runs
  }

  private makeRun(page: number, n: number, chars: Ch[], info: PageInfo): TextRun {
    const first = chars[0]
    let text = ''
    const xs: number[] = []
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const ch of chars) {
      text += ch.c
      for (let u = 0; u < ch.c.length; u++) xs.push(ch.ox)
      x0 = Math.min(x0, ch.left)
      y0 = Math.min(y0, ch.top)
      x1 = Math.max(x1, ch.right)
      y1 = Math.max(y1, ch.bottom)
    }
    xs.push(chars[chars.length - 1].right)
    const color = toRgb255(first.color)
    const fontName = first.fname.replace(/^[A-Z]{6}\+/, '')
    return {
      id: `${page}:${n}`,
      page,
      source: 'pdf',
      text,
      rect: [x0, y0, x1, y1],
      x: first.ox,
      baseline: first.oy,
      xs,
      size: Math.round(first.size * 100) / 100,
      fontName,
      style: detectStyle(first.fname, first.fl, first.size, color),
      hidden: info.kind === 'scan-ocr' || info.kind === 'outlined',
    }
  }

  // ------------------------------------------------------------------------------- rendering

  private pixmapToRgba(pm: mupdf.Pixmap): RenderResult {
    const w = pm.getWidth()
    const h = pm.getHeight()
    const n = pm.getNumberOfComponents() + (pm.getAlpha() ? 1 : 0)
    const stride = pm.getStride()
    const src = pm.getPixels()
    const rgba = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      let s = y * stride
      let o = y * w * 4
      for (let x = 0; x < w; x++, s += n, o += 4) {
        if (n >= 3) {
          rgba[o] = src[s]
          rgba[o + 1] = src[s + 1]
          rgba[o + 2] = src[s + 2]
        } else rgba[o] = rgba[o + 1] = rgba[o + 2] = src[s]
        rgba[o + 3] = 255
      }
    }
    return { width: w, height: h, rgba }
  }

  /** Render a page at `scale` (device px per pt) with the given edits applied, exactly as export would. */
  async render(index: number, scale: number, edits: Edit[]): Promise<RenderResult> {
    const info = this.analyze(index)
    const live = edits.filter((e) => e.page === index)
    const matrix = mupdf.Matrix.scale(scale, scale)

    if (live.length === 0) {
      const page = this.d.loadPage(index)
      const pm = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
      const out = this.pixmapToRgba(pm)
      pm.destroy()
      page.destroy()
      return out
    }

    if (isRaster(info.kind)) {
      const page = this.d.loadPage(index)
      const pm = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
      page.destroy()
      await this.applyRasterEdits(pm, scale, live)
      this.paintOverlays(pm, scale, live)
      const out = this.pixmapToRgba(pm)
      pm.destroy()
      return out
    }

    const doc = this.openFresh()
    try {
      await this.applyVectorEdits(doc, index, live)
      const page = doc.loadPage(index)
      const pm = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false)
      const out = this.pixmapToRgba(pm)
      pm.destroy()
      page.destroy()
      return out
    } finally {
      doc.destroy()
    }
  }

  /** A crop of the *original* page (used to show the scan next to its recognised text). */
  renderClip(index: number, rect: Rect, scale: number): RenderResult {
    const page = this.d.loadPage(index)
    const w = Math.max(1, Math.ceil((rect[2] - rect[0]) * scale))
    const h = Math.max(1, Math.ceil((rect[3] - rect[1]) * scale))
    const pm = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false)
    pm.clear(255)
    const dev = new mupdf.DrawDevice(mupdf.Matrix.concat(mupdf.Matrix.translate(-rect[0], -rect[1]), mupdf.Matrix.scale(scale, scale)), pm)
    page.run(dev, mupdf.Matrix.identity)
    dev.close()
    dev.destroy()
    const out = this.pixmapToRgba(pm)
    pm.destroy()
    page.destroy()
    return out
  }

  /** PNG of the whole page for OCR. */
  renderPng(index: number, scale: number): PngResult {
    const page = this.d.loadPage(index)
    const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
    const out: PngResult = { width: pm.getWidth(), height: pm.getHeight(), x0: pm.getX() / scale, y0: pm.getY() / scale, scale, png: pm.asPNG().slice() }
    pm.destroy()
    page.destroy()
    return out
  }

  addUserFont(name: string, bytes: Uint8Array) {
    this.book.addUserFont(name, bytes)
  }

  async measure(items: { text: string; style: FontStyle }[]): Promise<number[]> {
    const out: number[] = []
    for (const it of items) out.push(await this.book.measure(it.text, it.style))
    return out
  }

  // -------------------------------------------------------------------------- vector (text) edits

  private plansFor(edits: Edit[], raster: boolean): { e: Edit; p: EditPlan }[] {
    return edits.map((e) => ({ e, p: planEdit(e, raster) })).filter((x) => !x.p.noop)
  }

  private async applyVectorEdits(doc: mupdf.PDFDocument, index: number, edits: Edit[]) {
    const plans = this.plansFor(edits, false)
    const overlays = edits.filter((e) => e.kind === 'overlay' && e.overlay)
    const tables = edits.filter((e) => e.kind === 'table' && e.table)
    if (!plans.length && !overlays.length && !tables.length) return
    const page = doc.loadPage(index)

    // 1. Remove the old content for real (not just cover it).
    const plain = plans.filter((x) => x.p.clear && !(x.e.kind === 'erase' && x.e.redact))
    const black = plans.filter((x) => x.p.clear && x.e.kind === 'erase' && x.e.redact)
    if (plain.length) {
      for (const { p } of plain) page.createAnnotation('Redact').setRect(p.clear!)
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
    }
    if (black.length) {
      for (const { p } of black) page.createAnnotation('Redact').setRect(p.clear!)
      page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE)
    }
    // A table is wiped (its lines, fills and text) and drawn again from the model.
    const cleared = tables.flatMap((e) => e.table!.clear)
    if (cleared.length) {
      for (const r of cleared) page.createAnnotation('Redact').setRect(r)
      page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE)
    }

    // 2. Write what replaces it.
    const fonts = new DocFonts(doc)
    const ops: string[] = []
    for (const e of tables) if (!e.table!.deleted) ops.push(...(await this.tableOps(e.table!.model, fonts)))
    for (const { e, p } of plans) {
      if (e.kind === 'erase' && !e.redact && e.fill && e.fill !== 'auto' && p.clear) {
        const [x0, y0, x1, y1] = p.clear
        ops.push(`${rgb01(e.fill)} rg ${num(x0)} ${num(y0)} ${num(x1 - x0)} ${num(y1 - y0)} re f`)
      }
    }
    for (const { p } of plans) {
      if (!p.draw) continue
      const { text, x, baseline, style } = p.draw
      const { segments } = await this.book.segment(text, style)
      ops.push(`${rgb01(style.color)} rg`)
      let cx = x
      for (const seg of segments) {
        const res = fonts.resource(seg.face)
        ops.push(`BT /${res} ${num(style.size)} Tf 1 0 0 -1 ${num(cx)} ${num(baseline)} Tm ${encodeForFace(seg.face, seg.text)} Tj ET`)
        cx += segmentWidth(seg.face, seg.text, style.size)
      }
    }
    // 3. Overlays (markup, shapes, pictures) go on top of everything, text included.
    const ov = this.overlayContent(doc, overlays)
    ops.push(...ov.ops)
    if (ops.length) this.appendContent(doc, page, ops.join('\n'), fonts, ov)
    page.destroy()
    return fonts
  }

  /** PDF content + resources for a set of overlay edits. Resource names are unique per call (see DocFonts). */
  private overlayContent(doc: mupdf.PDFDocument, overlays: Edit[]): OverlayContent {
    const tag = Math.random().toString(36).slice(2, 6)
    const gs = new Map<string, { name: string; ref: mupdf.PDFObject }>()
    const xo = new Map<string, { name: string; ref: mupdf.PDFObject }>()
    const ctx: ContentContext = {
      gstate: (alpha, multiply) => {
        const key = `${alpha.toFixed(3)}:${multiply ? 1 : 0}`
        let g = gs.get(key)
        if (!g) {
          const d = doc.newDictionary()
          d.put('Type', doc.newName('ExtGState'))
          d.put('ca', doc.newReal(alpha))
          d.put('CA', doc.newReal(alpha))
          if (multiply) d.put('BM', doc.newName('Multiply'))
          g = { name: `PDOvG${tag}${gs.size + 1}`, ref: doc.addObject(d) }
          gs.set(key, g)
        }
        return g.name
      },
      image: (id) => {
        const bytes = this.images.get(id)
        if (!bytes) return null
        let x = xo.get(id)
        if (!x) {
          x = { name: `PDOvI${tag}${xo.size + 1}`, ref: doc.addImage(new mupdf.Image(bytes.slice())) }
          xo.set(id, x)
        }
        return x.name
      },
    }
    const ops = overlays.flatMap((e) => primsToContent(overlayPrims(e.overlay!), ctx))
    return {
      ops,
      gstates: [...gs.values()].map((g): [string, mupdf.PDFObject] => [g.name, g.ref]),
      xobjects: [...xo.values()].map((x): [string, mupdf.PDFObject] => [x.name, x.ref]),
    }
  }

  /** Paint overlays into a page bitmap (used for the on-screen render of scanned pages). */
  private paintOverlays(pm: mupdf.Pixmap, scale: number, edits: Edit[]) {
    const overlays = edits.filter((e) => e.kind === 'overlay' && e.overlay)
    if (!overlays.length) return
    const rgb = mupdf.ColorSpace.DeviceRGB
    const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pm)
    const draw = (p: Prim) => {
      if (p.kind === 'image') {
        const bytes = this.images.get(p.imageId)
        if (!bytes) return
        const img = new mupdf.Image(bytes.slice())
        const [x0, y0, x1, y1] = p.rect
        dev.fillImage(img, [x1 - x0, 0, 0, -(y1 - y0), x0, y1], p.alpha)
        img.destroy()
        return
      }
      if (!p.segs.length || (!p.fill && !p.stroke)) return
      const path = new mupdf.Path()
      for (const s of p.segs) {
        if (s[0] === 'M') path.moveTo(s[1], s[2])
        else if (s[0] === 'L') path.lineTo(s[1], s[2])
        else if (s[0] === 'C') path.curveTo(s[1], s[2], s[3], s[4], s[5], s[6])
        else path.closePath()
      }
      const stroke = p.stroke ? new mupdf.StrokeState({ lineCap: p.round ? 'Round' : 'Butt', lineJoin: p.round ? 'Round' : 'Miter', lineWidth: p.width, miterLimit: 10 }) : null
      const col = (c: Rgb) => [c[0] / 255, c[1] / 255, c[2] / 255] as never // DeviceRGB takes three components
      const paint = (alpha: number) => {
        if (p.fill) dev.fillPath(path, false, mupdf.Matrix.identity, rgb, col(p.fill), alpha)
        if (p.stroke && stroke) dev.strokePath(path, stroke, mupdf.Matrix.identity, rgb, col(p.stroke), alpha)
      }
      if (p.multiply) {
        // a highlighter: draw the colour into a group that is multiplied onto the page
        dev.beginGroup(pathBounds(p), rgb, true, false, 'Multiply', p.alpha)
        paint(1)
        dev.endGroup()
      } else paint(p.alpha)
      stroke?.destroy()
      path.destroy()
    }
    for (const e of overlays) for (const p of overlayPrims(e.overlay!)) draw(p)
    dev.close()
    dev.destroy()
  }

  /** Append content (written in page space, y down) on top of the page, without disturbing existing content. */
  private appendContent(doc: mupdf.PDFDocument, page: mupdf.PDFPage, content: string, fonts: DocFonts, extras?: Pick<OverlayContent, 'gstates' | 'xobjects'>) {
    const pobj = page.getObject()
    const old = pobj.getInheritable('Resources')
    const res = doc.newDictionary()
    const fd = doc.newDictionary()
    const gd = doc.newDictionary()
    const xd = doc.newDictionary()
    // (PDFObject.length is not reliable for dictionaries, so remember whether each one is needed ourselves)
    let hasG = (extras?.gstates.length ?? 0) > 0
    let hasX = (extras?.xobjects.length ?? 0) > 0
    if (!old.isNull()) {
      old.forEach((v, k) => {
        if (k !== 'Font' && k !== 'ExtGState' && k !== 'XObject') res.put(k, v)
      })
      for (const [key, into] of [['Font', fd], ['ExtGState', gd], ['XObject', xd]] as const) {
        const dict = old.get(key)
        if (dict.isNull()) continue
        dict.forEach((v, k) => into.put(k, v))
        if (key === 'ExtGState') hasG = true
        if (key === 'XObject') hasX = true
      }
    }
    for (const [name, ref] of fonts.entries()) fd.put(name, ref)
    for (const [name, ref] of extras?.gstates ?? []) gd.put(name, ref)
    for (const [name, ref] of extras?.xobjects ?? []) xd.put(name, ref)
    res.put('Font', fd)
    if (hasG) res.put('ExtGState', gd)
    if (hasX) res.put('XObject', xd)
    pobj.put('Resources', res)

    const inv = mupdf.Matrix.invert(page.getTransform())
    const orig = pobj.get('Contents')
    const arr = doc.newArray()
    arr.push(doc.addStream('q\n', doc.newDictionary()))
    if (orig.isArray()) orig.forEach((s) => arr.push(s))
    else if (!orig.isNull()) arr.push(orig)
    arr.push(doc.addStream('Q\n', doc.newDictionary()))
    arr.push(doc.addStream(`q\n${inv.map(num).join(' ')} cm\n${content}\nQ\n`, doc.newDictionary()))
    pobj.put('Contents', arr)
  }

  // ------------------------------------------------------------------------ raster (scan) edits

  /** Paint edits into a page pixmap rendered at `scale`: sample the paper, clear the old ink, draw new text. */
  private async applyRasterEdits(pm: mupdf.Pixmap, scale: number, edits: Edit[]) {
    const plans = this.plansFor(edits, true)
    if (!plans.length) return

    for (const { e, p } of plans) {
      if (!p.clear) continue
      const explicit = e.kind === 'erase' && e.redact ? ([0, 0, 0] as Rgb) : e.kind === 'erase' && e.fill && e.fill !== 'auto' ? e.fill : null
      this.fillRegion(pm, p.clear, scale, explicit)
    }

    const draws = plans.filter((x) => x.p.draw)
    if (!draws.length) return
    const dev = new mupdf.DrawDevice(mupdf.Matrix.scale(scale, scale), pm)
    for (const { p } of draws) {
      const { text, x, baseline, style } = p.draw!
      const { segments } = await this.book.segment(text, style)
      const t = new mupdf.Text()
      let cx = x
      for (const seg of segments) {
        const next = t.showString(seg.face.font, [style.size, 0, 0, -style.size, cx, baseline], seg.text)
        cx = next[4]
      }
      dev.fillText(t, mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, [style.color[0] / 255, style.color[1] / 255, style.color[2] / 255], 1)
      t.destroy()
    }
    dev.close()
    dev.destroy()
  }

  private fillRegion(pm: mupdf.Pixmap, rect: Rect, scale: number, explicit: Rgb | null) {
    const w = pm.getWidth()
    const h = pm.getHeight()
    const n = pm.getNumberOfComponents() + (pm.getAlpha() ? 1 : 0)
    const stride = pm.getStride()
    const px = pm.getPixels() // fresh view; no MuPDF calls below until we are done with it
    const x0 = clamp(Math.floor(rect[0] * scale), 0, w)
    const y0 = clamp(Math.floor(rect[1] * scale), 0, h)
    const x1 = clamp(Math.ceil(rect[2] * scale), 0, w)
    const y1 = clamp(Math.ceil(rect[3] * scale), 0, h)
    if (x1 <= x0 || y1 <= y0) return

    let bg: Rgb = [255, 255, 255]
    let sigma = 0
    if (explicit) bg = explicit
    else {
      // Median of a thin ring just outside the area = the paper colour; its spread = scan noise.
      const gap = 2
      const ring = Math.max(3, Math.round(scale * 2))
      const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
      let count = 0
      const rx0 = clamp(x0 - gap - ring, 0, w)
      const ry0 = clamp(y0 - gap - ring, 0, h)
      const rx1 = clamp(x1 + gap + ring, 0, w)
      const ry1 = clamp(y1 + gap + ring, 0, h)
      for (let y = ry0; y < ry1; y++) {
        const inY = y >= y0 - gap && y < y1 + gap
        for (let x = rx0; x < rx1; x++) {
          if (inY && x >= x0 - gap && x < x1 + gap) continue
          const o = y * stride + x * n
          if (n >= 3) {
            hist[0][px[o]]++
            hist[1][px[o + 1]]++
            hist[2][px[o + 2]]++
          } else {
            hist[0][px[o]]++
            hist[1][px[o]]++
            hist[2][px[o]]++
          }
          count++
        }
      }
      if (count > 0) {
        const med = (hh: Uint32Array) => {
          let acc = 0
          for (let v = 0; v < 256; v++) {
            acc += hh[v]
            if (acc * 2 >= count) return v
          }
          return 255
        }
        bg = [med(hist[0]), med(hist[1]), med(hist[2])]
        // MAD of the green channel -> noise sigma
        const m = bg[1]
        const dev = new Uint32Array(256)
        for (let v = 0; v < 256; v++) dev[Math.abs(v - m)] += hist[1][v]
        let acc = 0
        let mad = 0
        for (let v = 0; v < 256; v++) {
          acc += dev[v]
          if (acc * 2 >= count) {
            mad = v
            break
          }
        }
        sigma = clamp(mad * 1.4826, 0, 10)
      }
    }

    const rnd = mulberry32(x0 * 73856093 + y0 * 19349663 + x1 * 83492791)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = y * stride + x * n
        const noise = sigma > 0 ? (rnd() + rnd() + rnd() - 1.5) * 1.6 * sigma : 0
        if (n >= 3) {
          px[o] = clamp(bg[0] + noise, 0, 255)
          px[o + 1] = clamp(bg[1] + noise, 0, 255)
          px[o + 2] = clamp(bg[2] + noise, 0, 255)
        } else px[o] = clamp(bg[1] + noise, 0, 255)
      }
    }
  }

  // ------------------------------------------------------------------------------ hidden text

  private async hiddenTextOps(layer: TextLayer, fonts: DocFonts): Promise<string> {
    const ops: string[] = ['BT', '3 Tr']
    for (const line of layer.lines) {
      const size = clamp(line.size, 2, 200)
      const style: FontStyle = { family: 'sans', bold: false, italic: false, size, color: [0, 0, 0] }
      const units = line.words?.length ? line.words : [{ text: line.text, x0: line.rect[0], x1: line.rect[2] }]
      for (let i = 0; i < units.length; i++) {
        const u = units[i]
        if (!u.text.trim()) continue
        const { segments } = await this.book.segment(u.text, style)
        const natural = segments.reduce((s, g) => s + segmentWidth(g.face, g.text, size), 0)
        const tz = natural > 0 ? clamp((100 * (u.x1 - u.x0)) / natural, 10, 400) : 100
        let x = u.x0
        segments.forEach((seg, si) => {
          // a real trailing space keeps copied/searched text word-separated
          const withSpace = si === segments.length - 1 && i < units.length - 1 ? seg.text + ' ' : seg.text
          ops.push(`/${fonts.resource(seg.face)} ${num(size)} Tf ${num(tz)} Tz 1 0 0 -1 ${num(x)} ${num(line.baseline)} Tm ${encodeForFace(seg.face, withSpace)} Tj`)
          x += (segmentWidth(seg.face, seg.text, size) * tz) / 100
        })
      }
    }
    ops.push('ET')
    return ops.join('\n')
  }

  // ------------------------------------------------------------------------------------ export

  async export(edits: Edit[], layers: TextLayer[], opts: ExportOptions): Promise<ExportResult> {
    const doc = this.openFresh()
    const byPage = new Map<number, Edit[]>()
    for (const e of edits) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e])
    const layerByPage = new Map(layers.map((l) => [l.page, l]))
    const touched = new Set<number>([...byPage.keys(), ...(opts.textLayer ? layerByPage.keys() : [])])
    let usedCid = false

    for (const index of [...touched].sort((a, b) => a - b)) {
      const info = this.analyze(index)
      const pageEdits = byPage.get(index) ?? []
      const layer = opts.textLayer ? layerByPage.get(index) : undefined

      if (isRaster(info.kind)) {
        const fonts = await this.exportRasterPage(doc, index, info, pageEdits, layer, opts)
        usedCid ||= fonts?.usedCid ?? false
      } else if (pageEdits.length) {
        const fonts = await this.applyVectorEdits(doc, index, pageEdits)
        usedCid ||= fonts?.usedCid ?? false
      }
    }

    if (usedCid) {
      try {
        doc.subsetFonts() // shrink the embedded fallback fonts down to the glyphs we used
      } catch {
        /* keeping full fonts is fine */
      }
    }
    const buf = doc.saveToBuffer('compress,garbage=compact')
    const bytes = buf.asUint8Array().slice()
    buf.destroy()
    doc.destroy()
    const report = await this.verify(bytes, edits, layers, opts)
    return { bytes, report }
  }

  private async exportRasterPage(
    doc: mupdf.PDFDocument,
    index: number,
    info: PageInfo,
    edits: Edit[],
    layer: TextLayer | undefined,
    opts: ExportOptions,
  ): Promise<DocFonts | undefined> {
    const page = doc.loadPage(index)
    const fonts = new DocFonts(doc)
    const [bx0, by0, bx1, by1] = page.getBounds()
    const W = bx1 - bx0
    const H = by1 - by0

    // Overlays (markup, shapes, pictures) are vector content on top of the page; they never force a re-render.
    const overlays = edits.filter((e) => e.kind === 'overlay' && e.overlay)
    const textEdits = edits.filter((e) => e.kind !== 'overlay')

    if (textEdits.length === 0) {
      // Original picture stays byte-for-byte; only the invisible text layer is replaced, and overlays are added.
      if (info.kind === 'scan-ocr' || info.kind === 'outlined') {
        page.createAnnotation('Redact').setRect([bx0 - 1, by0 - 1, bx1 + 1, by1 + 1])
        page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
      }
      const hidden = layer?.lines.length ? await this.hiddenTextOps(layer, fonts) : ''
      const ov = this.overlayContent(doc, overlays)
      const content = [...ov.ops, hidden].filter(Boolean).join('\n')
      if (content) this.appendContent(doc, page, content, fonts, ov)
      page.destroy()
      return fonts
    }

    // Edited scan: re-render at the scan's own resolution, patch the pixels, re-encode.
    const scale = clamp((info.imageDpi ?? (info.kind === 'outlined' ? 300 : 200)) / 72, 1.5, 4.5)
    const pm = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
    await this.applyRasterEdits(pm, scale, edits)
    let image: mupdf.Image
    if (info.imageGray) {
      const gray = pm.convertToColorSpace(mupdf.ColorSpace.DeviceGray, false)
      image = new mupdf.Image(gray)
      gray.destroy()
    } else {
      const jpg = pm.asJPEG(clamp(opts.jpegQuality, 40, 100)).slice()
      image = new mupdf.Image(jpg)
    }
    pm.destroy()
    const imgRef = doc.addImage(image)

    const ov = this.overlayContent(doc, overlays)
    let content = `q ${num(W)} 0 0 ${num(-H)} ${num(bx0)} ${num(by0 + H)} cm /PDEdImg Do Q`
    if (ov.ops.length) content += '\n' + ov.ops.join('\n')
    if (layer?.lines.length) content += '\n' + (await this.hiddenTextOps(layer, fonts))

    const pobj = page.getObject()
    const res = doc.newDictionary()
    const xo = doc.newDictionary()
    xo.put('PDEdImg', imgRef)
    for (const [name, ref] of ov.xobjects) xo.put(name, ref)
    res.put('XObject', xo)
    const fd = doc.newDictionary()
    for (const [name, ref] of fonts.entries()) fd.put(name, ref)
    res.put('Font', fd)
    if (ov.gstates.length) {
      const gd = doc.newDictionary()
      for (const [name, ref] of ov.gstates) gd.put(name, ref)
      res.put('ExtGState', gd)
    }
    pobj.put('Resources', res)
    const inv = mupdf.Matrix.invert(page.getTransform())
    pobj.put('Contents', doc.addStream(`q\n${inv.map(num).join(' ')} cm\n${content}\nQ\n`, doc.newDictionary()))
    page.destroy()
    return fonts
  }

  // ---------------------------------------------------------------------------------- verify

  private pageChars(doc: mupdf.PDFDocument, index: number) {
    const page = doc.loadPage(index)
    const { lines } = this.chars(page)
    page.destroy()
    const out: { c: string; x: number; y: number; q: Rect }[] = []
    for (const l of lines) for (const ch of l.chars) if (ch.c.trim() !== '') out.push({ c: ch.c, x: ch.ox, y: ch.oy, q: [ch.left, ch.top, ch.right, ch.bottom] })
    return out
  }

  /**
   * Re-open the exported bytes and prove what changed. For text pages: every character you did not
   * touch is still there at the same position; every character you changed is exactly what you typed.
   */
  async verify(outBytes: Uint8Array, edits: Edit[], layers: TextLayer[], opts: ExportOptions): Promise<VerifyReport> {
    const out = mupdf.Document.openDocument(outBytes.slice(), 'application/pdf').asPDF()!
    const pages: PageVerdict[] = []
    const byPage = new Map<number, Edit[]>()
    for (const e of edits) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e])
    const layerPages = new Map(layers.map((l) => [l.page, l]))
    const toCheck = new Set<number>([...byPage.keys(), ...(opts.textLayer ? layerPages.keys() : [])])

    for (const index of [...toCheck].sort((a, b) => a - b)) {
      const info = this.analyze(index)
      const pageEdits = byPage.get(index) ?? []
      pages.push(isRaster(info.kind) ? await this.verifyRaster(out, index, pageEdits, layerPages.get(index), opts) : await this.verifyVector(out, index, pageEdits))
    }
    out.destroy()
    const all = pages.flatMap((p) => p.edits)
    return {
      ok: pages.every((p) => p.ok),
      editCount: all.length,
      passed: all.filter((e) => e.ok).length,
      collateral: pages.reduce((s, p) => s + p.collateral, 0),
      pages,
    }
  }

  private async verifyVector(out: mupdf.PDFDocument, index: number, edits: Edit[]): Promise<PageVerdict> {
    const plans = this.plansFor(edits, false)
    const before = this.pageChars(this.d, index)
    const after = this.pageChars(out, index)
    type Ch2 = (typeof before)[number]
    const TOL = 0.75

    // Each edit owns a "zone". Inside it the output must read exactly what the user typed (and nothing
    // else); outside every zone the output must be identical to the original.
    interface Zone {
      e: Edit
      rect: Rect
      box: boolean // erase zones match by glyph box; text zones match by glyph origin
      expected: string
      drawBox: Rect | null
      /** a line that was moved: where it used to be must now hold nothing (apart from what was drawn in the zone) */
      alsoEmpty?: Rect
    }
    const zones: Zone[] = []
    for (const { e, p } of plans) {
      if (e.kind === 'erase' && p.clear) {
        zones.push({ e, rect: p.clear, box: true, expected: '', drawBox: null })
        continue
      }
      const moved = isMoved(e)
      if (moved && !p.draw && p.clear) {
        zones.push({ e, rect: p.clear, box: true, expected: '', drawBox: null }) // moved and emptied: just gone
        continue
      }
      const baseline = p.draw?.baseline ?? e.run?.baseline ?? 0
      const size = p.draw?.style.size ?? e.run?.size ?? 10
      let x0 = Infinity
      let x1 = -Infinity
      if (p.clear && !moved) {
        x0 = p.clear[0]
        x1 = p.clear[2]
      }
      let drawBox: Rect | null = null
      if (p.draw) {
        const width = await this.book.measure(p.draw.text, p.draw.style)
        x0 = Math.min(x0, p.draw.x)
        x1 = Math.max(x1, p.draw.x + width)
        drawBox = [p.draw.x, baseline - size * 0.7, p.draw.x + width, baseline + size * 0.2]
      }
      zones.push({ e, rect: [x0 - 0.3, baseline - size * 0.55, x1 - 0.05, baseline + size * 0.3], box: false, expected: (p.draw?.text ?? '').replace(/\s+/g, ''), drawBox, ...(moved && p.clear ? { alsoEmpty: p.clear } : {}) })
    }
    const inside = (c: Ch2, z: Zone) => (z.box ? rectsOverlap(c.q, z.rect) : c.x >= z.rect[0] && c.x < z.rect[2] && c.y >= z.rect[1] && c.y <= z.rect[3])
    // A redrawn table owns its old box, the text that stuck out of it, and wherever its new box now is.
    const tables = edits.filter((e) => e.kind === 'table' && e.table)
    const tableZones: Rect[] = []
    for (const e of tables) tableZones.push(...(await this.tableZone(e.table!)))
    const inAnyZone = (c: Ch2) => zones.some((z) => inside(c, z) || (z.alsoEmpty ? rectsOverlap(c.q, z.alsoEmpty) : false)) || tableZones.some((r) => rectsOverlap(c.q, r))

    const verdicts: EditVerdict[] = []
    for (const z of zones) {
      const got = after
        .filter((c) => inside(c, z))
        .sort((a, b) => (z.box ? a.y - b.y || a.x - b.x : a.x - b.x))
        .map((c) => c.c)
        .join('')
      let ok = got === z.expected
      let warning: string | undefined
      const lifted = isMoved(z.e)
      if (!ok && got.length > z.expected.length && z.expected.length > 0) warning = lifted ? 'The moved text lands on top of other text — put it somewhere clear.' : 'New text runs into neighbouring text — shorten it or reduce the size.'
      if (z.drawBox && ok) {
        // new text must not sit on top of text that was already there
        const clash = after.find((c) => !inAnyZone(c) && rectsOverlap([c.q[0] + 0.5, c.q[1] + 1, c.q[2] - 0.5, c.q[3] - 1], z.drawBox!))
        if (clash) warning = lifted ? 'The moved text overlaps other text — put it somewhere clear.' : 'New text overlaps existing text — shorten it or reduce the size.'
      }
      const expectedLabel = z.expected || (z.e.kind === 'erase' ? '(area cleared)' : '(text removed)')
      const actualLabel = got || (z.expected ? '' : expectedLabel)
      if (z.expected === '' && got !== '') ok = false
      // a moved line: its old place must be empty — except for lines that were moved *onto* it (moving many lines
      // together drops each one into its neighbour's old spot); those are checked by their own edit
      let stillThere = ''
      if (z.alsoEmpty) {
        stillThere = after
          .filter((c) => rectsOverlap(c.q, z.alsoEmpty!) && !inside(c, z) && !zones.some((o) => o !== z && inside(c, o)))
          .map((c) => c.c)
          .join('')
        if (stillThere) ok = false
      }
      verdicts.push({ id: z.e.id, ok, expected: expectedLabel, actual: ok ? expectedLabel : stillThere ? `“${stillThere.slice(0, 30)}” is still at its old place` : got === '' ? '(nothing found)' : actualLabel, warning })
    }

    // Everything outside the zones must be exactly as it was.
    const afterByChar = new Map<string, number[]>()
    const outsideAfter = after.filter((c) => !inAnyZone(c))
    outsideAfter.forEach((a, i) => afterByChar.set(a.c, [...(afterByChar.get(a.c) ?? []), i]))
    const used = new Set<number>()
    const missing: Ch2[] = []
    for (const b of before.filter((c) => !inAnyZone(c))) {
      const hit = (afterByChar.get(b.c) ?? []).find((i) => !used.has(i) && Math.abs(outsideAfter[i].x - b.x) < TOL && Math.abs(outsideAfter[i].y - b.y) < TOL)
      if (hit === undefined) missing.push(b)
      else used.add(hit)
    }
    const extra = outsideAfter.filter((_, i) => !used.has(i))
    const collateral = missing.length + extra.length
    const notes: string[] = []
    if (missing.length) notes.push(`${missing.length} unrelated character(s) went missing: "${missing.map((c) => c.c).join('')}"`)
    if (extra.length) notes.push(`${extra.length} unexpected character(s) appeared: "${extra.map((c) => c.c).join('')}"`)

    // Tables: every cell must read what the model says, nothing of the old table may be left, and it must look right.
    for (const e of tables) verdicts.push(await this.verifyTable(out, index, e, after, before))

    // Overlays add no characters, so prove them by pixels: they must show up, and nothing else may have moved.
    const overlays = edits.filter((e) => e.kind === 'overlay' && e.overlay)
    let pixelCollateral = 0
    if (overlays.length || tables.length) {
      // (a moved line may also change where it used to be)
      const textZones = zones.flatMap((z) => [z.rect, ...(z.drawBox ? [z.drawBox] : []), ...(z.alsoEmpty ? [z.alsoEmpty] : [])])
      const r = this.verifyOverlayPixels(out, index, overlays, [...textZones, ...tableZones], 1.5)
      verdicts.push(...r.verdicts)
      pixelCollateral = r.stray
      notes.push(...r.notes)
    }
    return { page: index, ok: collateral === 0 && pixelCollateral === 0 && verdicts.every((v) => v.ok), edits: verdicts, collateral: collateral + pixelCollateral, notes }
  }

  /**
   * Everything a table edit may touch on the page: the old table box and any text that stuck out of it, the new box,
   * and text of the new table that runs past its cell (a long line in a table that is not set to wrap).
   */
  private async tableZone(t: TableEdit): Promise<Rect[]> {
    if (t.deleted) return [...t.clear]
    const m = t.model
    const out: Rect[] = [...t.clear, growRect(tableBounds(m), 2)]
    const lines = await this.cellLines(m)
    for (let r = 0; r < m.cells.length; r++) {
      for (let c = 0; c < m.cells[r].length; c++) {
        const cell = m.cells[r][c]
        if (!cell.text) continue
        const [x0, y0, x1, y1] = cellRect(m, r, c)
        let widest = 0
        for (const l of lines[r][c]) widest = Math.max(widest, await this.book.measure(l, cellStyle(cell)))
        if (widest <= x1 - x0 - 2 * CELL_PAD_X + 0.5) continue
        const left = cell.align === 'right' ? x1 - CELL_PAD_X - widest : cell.align === 'center' ? (x0 + x1) / 2 - widest / 2 : x0
        const right = cell.align === 'left' ? x0 + CELL_PAD_X + widest : cell.align === 'center' ? (x0 + x1) / 2 + widest / 2 : x1
        out.push(growRect([Math.min(x0, left), y0, Math.max(x1, right), y1], 1.5))
      }
    }
    return out
  }

  /** Prove a redrawn table: each row reads what the model says, no old text is left behind, fills and borders show. */
  private async verifyTable(out: mupdf.PDFDocument, index: number, e: Edit, after: { c: string; x: number; y: number; q: Rect }[], before: { c: string; x: number; y: number }[]): Promise<EditVerdict> {
    const t = e.table!
    const m = t.model
    const R = rowCount(m)
    const C = colCount(m)
    const label = t.deleted ? '(table removed)' : `${R}×${C} table`
    const zone: Rect[] = await this.tableZone(t)
    const inside = (c: { x: number; y: number }, rs: Rect[]) => rs.some((r) => c.x >= r[0] && c.x <= r[2] && c.y >= r[1] && c.y <= r[3])
    // Text that was already on the page, outside the old table, and that a taller / wider table now runs into.
    const pool = before.filter((c) => !inside(c, t.clear))
    const crowded: typeof after = []
    const inZone: typeof after = []
    for (const c of after) {
      if (!inside(c, zone)) continue
      // one bystander explains at most one character, so a table letter that happens to sit on the same spot survives
      const i = pool.findIndex((b) => b.c === c.c && Math.abs(b.x - c.x) < 0.75 && Math.abs(b.y - c.y) < 0.75)
      if (i >= 0) {
        pool.splice(i, 1)
        crowded.push(c)
      } else inZone.push(c)
    }
    if (t.deleted) {
      const left = inZone.map((c) => c.c).join('')
      return { id: e.id, ok: inZone.length === 0, expected: label, actual: inZone.length ? `“${left.slice(0, 40)}” is still there` : label }
    }

    // Text beyond the page edge is cut off and cannot be read back, so say that plainly.
    const pg = out.loadPage(index)
    const edge = pg.getBounds()
    pg.destroy()
    const [bx0, by0, bx1, by1] = tableBounds(m)
    if (bx1 > edge[2] + 0.5 || by1 > edge[3] + 0.5 || bx0 < edge[0] - 0.5 || by0 < edge[1] - 0.5) {
      return { id: e.id, ok: false, expected: label, actual: 'The table runs off the edge of the page, so part of it is cut off. Make it narrower or shorter, or move it.' }
    }

    const strip = (s: string) => s.replace(/\s+/g, '')
    const lines = await this.cellLines(m)
    const problems: string[] = []
    let warning: string | undefined
    if (crowded.length) warning = `The table now runs into text that was already on the page (“${crowded.map((c) => c.c).join('').slice(0, 24)}…”). Make the table smaller, or move it.`
    const seen = new Set<(typeof after)[number]>()
    for (let r = 0; r < R; r++) {
      const rowChars = inZone.filter((c) => c.y >= m.ys[r] && c.y < m.ys[r + 1])
      rowChars.forEach((c) => seen.add(c))
      let wide = false
      let want = ''
      for (let c = 0; c < C; c++) {
        const cell = m.cells[r][c]
        const maxW = m.xs[c + 1] - m.xs[c] - 2 * CELL_PAD_X
        for (const l of lines[r][c]) if (cell.text && (await this.book.measure(l, cellStyle(cell))) > maxW + 0.5) wide = true
        want += strip(lines[r][c].join(''))
      }
      const have = rowChars.map((c) => c.c).join('')
      const sortChars = (s: string) => [...s].sort().join('')
      if (wide) {
        warning = warning ?? 'A word is wider than its column, so it sticks out of its cell — widen the column.'
        const extra = [...have].filter((ch) => !want.includes(ch))
        if (extra.length) problems.push(`row ${r + 1}: unexpected “${extra.join('')}”`)
        continue
      }
      if (sortChars(have) !== sortChars(want)) {
        problems.push(`row ${r + 1}: expected “${want.slice(0, 30)}”, found “${have.slice(0, 30)}”`)
        continue
      }
      // in the right cells, in the right order
      for (let c = 0; c < C; c++) {
        const [x0, , x1] = cellRect(m, r, c)
        const got = rowChars
          .filter((ch) => ch.x >= x0 && ch.x < x1)
          .sort((a, b) => Math.round(a.y) - Math.round(b.y) || a.x - b.x)
          .map((ch) => ch.c)
          .join('')
        const exp = strip(lines[r][c].join(''))
        if (got !== exp) problems.push(`row ${r + 1}, column ${c + 1}: expected “${exp.slice(0, 24)}”, found “${got.slice(0, 24)}”`)
      }
    }
    const left = inZone.filter((c) => !seen.has(c))
    if (left.length) problems.push(`${left.length} character(s) of the old table are left behind: “${left.map((c) => c.c).join('').slice(0, 30)}”`)
    problems.push(...this.tableLookProblems(out, index, m))
    return { id: e.id, ok: problems.length === 0, expected: label, actual: problems.length ? problems[0] : label, ...(warning ? { warning } : {}) }
  }

  /** Sample the saved page: cell backgrounds and border lines must show in the colours the model asks for. */
  private tableLookProblems(out: mupdf.PDFDocument, index: number, m: TableModel): string[] {
    const s = 3
    const page = out.loadPage(index)
    const pm = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false)
    const d = pm.getPixels().slice()
    const w = pm.getWidth()
    const h = pm.getHeight()
    const n = pm.getNumberOfComponents()
    const stride = pm.getStride()
    const ox = pm.getX() / s
    const oy = pm.getY() / s
    pm.destroy()
    page.destroy()
    const at = (x: number, y: number): Rgb | null => {
      const ix = Math.round((x - ox) * s)
      const iy = Math.round((y - oy) * s)
      if (ix < 0 || iy < 0 || ix >= w || iy >= h) return null
      const o = iy * stride + ix * n
      return [d[o], d[o + 1], d[o + 2]]
    }
    const dist = (a: Rgb, b: Rgb) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
    const problems: string[] = []
    const inset = Math.max(1.2, (m.borders.outer || m.borders.innerH || m.borders.innerV ? m.borders.width / 2 : 0) + 1.2)
    outer: for (let r = 0; r < m.cells.length; r++) {
      for (let c = 0; c < m.cells[r].length; c++) {
        const fill = m.cells[r][c].fill
        if (!fill) continue
        const [x0, y0] = cellRect(m, r, c)
        const px = at(x0 + inset, y0 + inset)
        if (px && dist(px, fill) > 40) {
          problems.push(`the background of row ${r + 1}, column ${c + 1} is not showing`)
          break outer
        }
      }
    }
    if (m.borders.width * s >= 2.2) {
      const { h: hl, v: vl } = tableLines(m)
      const probe = (pts: Pt[]) => pts.some(([x, y]) => [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => { const p = at(x + dx / s, y + dy / s); return p && dist(p, m.borders.color) <= 70 })))
      const tests: { name: string; pts: Pt[] }[] = []
      if (hl.length) tests.push({ name: 'row', pts: [0.1, 0.5, 0.9].map((f): Pt => [hl[0].x0 + (hl[0].x1 - hl[0].x0) * f, hl[0].y]) })
      if (vl.length) tests.push({ name: 'column', pts: [0.1, 0.5, 0.9].map((f): Pt => [vl[0].x, vl[0].y0 + (vl[0].y1 - vl[0].y0) * f]) })
      for (const t of tests) if (!probe(t.pts)) problems.push(`the ${t.name} border lines are not showing in the chosen colour`)
    }
    return problems
  }

  /**
   * Compare the original page with the exported one at `scale`: inside each overlay the page must have changed,
   * and outside every overlay (and every text-edit zone in `excluded`) it must be pixel-identical.
   */
  private verifyOverlayPixels(out: mupdf.PDFDocument, index: number, overlays: Edit[], excluded: Rect[], scale: number): { verdicts: EditVerdict[]; stray: number; notes: string[] } {
    const m = mupdf.Matrix.scale(scale, scale)
    const pageA = this.d.loadPage(index)
    const pageB = out.loadPage(index)
    const pa = pageA.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
    const pb = pageB.toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
    const w = pa.getWidth()
    const h = pa.getHeight()
    const n = pa.getNumberOfComponents()
    const stride = pa.getStride()
    const A = pa.getPixels().slice()
    const B = pb.getPixels().slice()
    const sameSize = pb.getWidth() === w && pb.getHeight() === h
    const ox = pa.getX() / scale // page-space position of the first pixel (non-zero for offset boxes)
    const oy = pa.getY() / scale
    pa.destroy()
    pb.destroy()
    pageA.destroy()
    pageB.destroy()
    if (!sameSize) {
      return { verdicts: overlays.map((e) => ({ id: e.id, ok: false, expected: OVERLAY_LABEL[e.overlay!.type], actual: '(page size changed)' })), stray: 1, notes: ['The exported page has a different size from the original.'] }
    }

    const px = (r: Rect, margin: number): [number, number, number, number] => [
      clamp(Math.floor((r[0] - ox) * scale) - margin, 0, w),
      clamp(Math.floor((r[1] - oy) * scale) - margin, 0, h),
      clamp(Math.ceil((r[2] - ox) * scale) + margin, 0, w),
      clamp(Math.ceil((r[3] - oy) * scale) + margin, 0, h),
    ]
    const mask = new Uint8Array(w * h)
    const margin = Math.ceil(2 * scale)
    for (const r of [...excluded, ...overlays.map((e) => overlayBounds(e.overlay!))]) {
      const [x0, y0, x1, y1] = px(r, margin)
      for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1)
    }
    let stray = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue
        const o = y * stride + x * n
        if (Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2])) > 48) stray++
      }
    }
    const allowed = Math.ceil(w * h * 0.0002)
    const notes = [stray > allowed ? `${stray} pixels changed outside the things you added.` : 'Everything outside the things you added is visually unchanged.']

    const verdicts: EditVerdict[] = overlays.map((e) => {
      const [x0, y0, x1, y1] = px(overlayBounds(e.overlay!), 0)
      let diff = 0
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) diff += Math.abs(A[y * stride + x * n + c] - B[y * stride + x * n + c])
      const changed = diff > 30
      const label = OVERLAY_LABEL[e.overlay!.type]
      // Drawn in white over a page that is white there, nothing changes: pixels cannot prove it, and it is no failure.
      const colours = overlayColors(e.overlay!)
      if (!changed && colours.length > 0 && colours.every((c) => c[0] >= 245 && c[1] >= 245 && c[2] >= 245)) {
        return { id: e.id, ok: true, expected: label, actual: label, warning: 'Drawn in white, and this part of the page is already white — there is nothing visible to check.' }
      }
      return { id: e.id, ok: changed, expected: label, actual: changed ? label : '(no visible change)' }
    })
    return { verdicts, stray: stray > allowed ? stray : 0, notes }
  }

  private async verifyRaster(out: mupdf.PDFDocument, index: number, edits: Edit[], layer: TextLayer | undefined, opts: ExportOptions): Promise<PageVerdict> {
    const notes: string[] = []
    const verdicts: EditVerdict[] = []
    let collateral = 0
    let ok = true

    // 1. The invisible text layer must read exactly what we meant it to.
    if (layer && opts.textLayer) {
      const want = layer.lines.map((l) => l.text).join('').replace(/\s+/g, '')
      const have = this.pageChars(out, index).map((c) => c.c).join('')
      const sortStr = (s: string) => [...s].sort().join('')
      if (sortStr(want) !== sortStr(have)) {
        ok = false
        notes.push(`Text layer mismatch: expected ${want.length} characters, found ${have.length}.`)
      } else notes.push(`Searchable text layer verified (${want.length} characters).`)
    }

    // 2. Pixels outside the edited areas must be unchanged; edited areas must have changed.
    //    Compare at the resolution the page was re-rendered at, where the saved picture is shown 1:1 —
    //    comparing a vector original with a bitmap at a lower resolution flags every anti-aliased edge.
    const plans = this.plansFor(edits, true)
    const overlays = edits.filter((e) => e.kind === 'overlay' && e.overlay)
    if (plans.length || overlays.length) {
      const info = this.analyze(index)
      const scale = clamp((info.imageDpi ?? (info.kind === 'outlined' ? 300 : 200)) / 72, 1.5, 4.5)
      const m = mupdf.Matrix.scale(scale, scale)
      const pa = this.d.loadPage(index).toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
      const pb = out.loadPage(index).toPixmap(m, mupdf.ColorSpace.DeviceRGB, false)
      const w = pa.getWidth()
      const h = pa.getHeight()
      const n = pa.getNumberOfComponents()
      const stride = pa.getStride()
      const A = pa.getPixels().slice()
      const B = pb.getPixels().slice()
      pa.destroy()
      pb.destroy()
      // Each edit owns one area (or two, for a line that was moved: where it was, and where it went).
      const zones: { e: Edit; rs: Rect[] }[] = plans.map(({ e, p }) => {
        let dr: Rect | null = null
        if (p.draw) {
          const d = p.draw
          const wd = d.text.length * d.style.size * 0.6
          dr = [d.x, d.baseline - d.style.size, d.x + wd, d.baseline + d.style.size * 0.3]
        }
        if (isMoved(e) && p.clear && dr) return { e, rs: [p.clear, dr] }
        let r: Rect | null = p.clear
        if (dr) r = r ? [Math.min(r[0], dr[0]), Math.min(r[1], dr[1]), Math.max(r[2], dr[2]), Math.max(r[3], dr[3])] : dr
        return { e, rs: [r!] }
      })
      for (const e of overlays) zones.push({ e, rs: [overlayBounds(e.overlay!)] })
      // mask of everything the user was allowed to change (zone + a small safety margin)
      const mask = new Uint8Array(w * h)
      const margin = Math.ceil(2 * scale)
      for (const r of zones.flatMap((z) => z.rs)) {
        const x0 = clamp(Math.floor(r[0] * scale) - margin, 0, w)
        const x1 = clamp(Math.ceil(r[2] * scale) + margin, 0, w)
        const y0 = clamp(Math.floor(r[1] * scale) - margin, 0, h)
        const y1 = clamp(Math.ceil(r[3] * scale) + margin, 0, h)
        for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1)
      }
      let stray = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (mask[y * w + x]) continue
          const o = y * stride + x * n
          const d = Math.max(Math.abs(A[o] - B[o]), Math.abs(A[o + 1] - B[o + 1]), Math.abs(A[o + 2] - B[o + 2]))
          if (d > 48) stray++
        }
      }
      collateral = stray
      const allowed = Math.ceil(w * h * 0.0002)
      if (stray > allowed) {
        ok = false
        notes.push(`${stray} pixels changed outside the edited areas.`)
      } else notes.push('Everything outside the edited areas is visually unchanged.')

      for (const { e, rs } of zones) {
        // every one of its areas must really have changed (for a moved line: the old place and the new one)
        const changed = rs.every((r) => {
          let diff = 0
          const x0 = clamp(Math.floor(r[0] * scale), 0, w)
          const x1 = clamp(Math.ceil(r[2] * scale), 0, w)
          const y0 = clamp(Math.floor(r[1] * scale), 0, h)
          const y1 = clamp(Math.ceil(r[3] * scale), 0, h)
          if (e.kind === 'overlay') {
            // a highlighter or a coloured shape may leave the green channel alone, so look at all three
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) diff += Math.abs(A[y * stride + x * n + c] - B[y * stride + x * n + c])
          } else {
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) diff += Math.abs(A[y * stride + x * n + 1] - B[y * stride + x * n + 1])
          }
          return diff > (e.kind === 'overlay' ? 30 : 40 * scale)
        })
        const label = e.kind === 'erase' ? '(area cleared)' : e.kind === 'overlay' ? OVERLAY_LABEL[e.overlay!.type] : e.text
        verdicts.push({ id: e.id, ok: changed, expected: label, actual: changed ? label : '(no visible change)' })
        if (!changed) ok = false
      }
    }
    return { page: index, ok: ok && verdicts.every((v) => v.ok), edits: verdicts, collateral, notes }
  }
}
