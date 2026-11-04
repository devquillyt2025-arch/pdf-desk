import * as mupdf from 'mupdf'
import { DocFonts, FontBook, encodeForFace, segmentWidth, type FontLoader } from './fonts.ts'
import { planEdit, rectsOverlap } from './plan.ts'
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
  Rect,
  RenderResult,
  Rgb,
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

  constructor(loader: FontLoader) {
    this.book = new FontBook(loader)
  }

  // ---------------------------------------------------------------------------------------- open

  open(bytes: Uint8Array, password?: string): OpenResult {
    this.dispose()
    let d: mupdf.Document
    try {
      d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf')
    } catch (e) {
      return { status: 'error', message: `Could not open this file: ${String((e as Error).message ?? e)}` }
    }
    if (!d.isPDF()) return { status: 'error', message: 'This file is not a PDF.' }
    if (d.needsPassword()) {
      if (!password || !d.authenticatePassword(password)) return { status: 'password' }
    }
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
    if (!plans.length) return
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

    // 2. Write what replaces it.
    const fonts = new DocFonts(doc)
    const ops: string[] = []
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
    if (ops.length) this.appendContent(doc, page, ops.join('\n'), fonts)
    page.destroy()
    return fonts
  }

  /** Append content (written in page space, y down) on top of the page, without disturbing existing content. */
  private appendContent(doc: mupdf.PDFDocument, page: mupdf.PDFPage, content: string, fonts: DocFonts) {
    const pobj = page.getObject()
    const old = pobj.getInheritable('Resources')
    const res = doc.newDictionary()
    const fd = doc.newDictionary()
    if (!old.isNull()) {
      old.forEach((v, k) => {
        if (k !== 'Font') res.put(k, v)
      })
      const oldFonts = old.get('Font')
      if (!oldFonts.isNull()) oldFonts.forEach((v, k) => fd.put(k, v))
    }
    for (const [name, ref] of fonts.entries()) fd.put(name, ref)
    res.put('Font', fd)
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

    if (edits.length === 0) {
      // Original picture stays byte-for-byte; only the invisible text layer is replaced.
      if (info.kind === 'scan-ocr' || info.kind === 'outlined') {
        page.createAnnotation('Redact').setRect([bx0 - 1, by0 - 1, bx1 + 1, by1 + 1])
        page.applyRedactions(false, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE)
      }
      if (layer?.lines.length) this.appendContent(doc, page, await this.hiddenTextOps(layer, fonts), fonts)
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

    let content = `q ${num(W)} 0 0 ${num(-H)} ${num(bx0)} ${num(by0 + H)} cm /PDEdImg Do Q`
    if (layer?.lines.length) content += '\n' + (await this.hiddenTextOps(layer, fonts))

    const pobj = page.getObject()
    const res = doc.newDictionary()
    const xo = doc.newDictionary()
    xo.put('PDEdImg', imgRef)
    res.put('XObject', xo)
    const fd = doc.newDictionary()
    for (const [name, ref] of fonts.entries()) fd.put(name, ref)
    res.put('Font', fd)
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
    }
    const zones: Zone[] = []
    for (const { e, p } of plans) {
      if (e.kind === 'erase' && p.clear) {
        zones.push({ e, rect: p.clear, box: true, expected: '', drawBox: null })
        continue
      }
      const baseline = p.draw?.baseline ?? e.run?.baseline ?? 0
      const size = p.draw?.style.size ?? e.run?.size ?? 10
      let x0 = Infinity
      let x1 = -Infinity
      if (p.clear) {
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
      zones.push({ e, rect: [x0 - 0.3, baseline - size * 0.55, x1 - 0.05, baseline + size * 0.3], box: false, expected: (p.draw?.text ?? '').replace(/\s+/g, ''), drawBox })
    }
    const inside = (c: Ch2, z: Zone) => (z.box ? rectsOverlap(c.q, z.rect) : c.x >= z.rect[0] && c.x < z.rect[2] && c.y >= z.rect[1] && c.y <= z.rect[3])
    const inAnyZone = (c: Ch2) => zones.some((z) => inside(c, z))

    const verdicts: EditVerdict[] = []
    for (const z of zones) {
      const got = after
        .filter((c) => inside(c, z))
        .sort((a, b) => (z.box ? a.y - b.y || a.x - b.x : a.x - b.x))
        .map((c) => c.c)
        .join('')
      let ok = got === z.expected
      let warning: string | undefined
      if (!ok && got.length > z.expected.length && z.expected.length > 0) warning = 'New text runs into neighbouring text — shorten it or reduce the size.'
      if (z.drawBox && ok) {
        // new text must not sit on top of text that was already there
        const clash = after.find((c) => !inAnyZone(c) && rectsOverlap([c.q[0] + 0.5, c.q[1] + 1, c.q[2] - 0.5, c.q[3] - 1], z.drawBox!))
        if (clash) warning = 'New text overlaps existing text — shorten it or reduce the size.'
      }
      const expectedLabel = z.expected || (z.e.kind === 'erase' ? '(area cleared)' : '(text removed)')
      const actualLabel = got || (z.expected ? '' : expectedLabel)
      if (z.expected === '' && got !== '') ok = false
      verdicts.push({ id: z.e.id, ok, expected: expectedLabel, actual: ok ? expectedLabel : got === '' ? '(nothing found)' : actualLabel, warning })
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
    return { page: index, ok: collateral === 0 && verdicts.every((v) => v.ok), edits: verdicts, collateral, notes }
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
    if (plans.length) {
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
      const zones = plans.map(({ e, p }) => {
        let r: Rect | null = p.clear
        if (p.draw) {
          const d = p.draw
          const wd = d.text.length * d.style.size * 0.6
          const dr: Rect = [d.x, d.baseline - d.style.size, d.x + wd, d.baseline + d.style.size * 0.3]
          r = r ? [Math.min(r[0], dr[0]), Math.min(r[1], dr[1]), Math.max(r[2], dr[2]), Math.max(r[3], dr[3])] : dr
        }
        return { e, r: r! }
      })
      // mask of everything the user was allowed to change (zone + a small safety margin)
      const mask = new Uint8Array(w * h)
      const margin = Math.ceil(2 * scale)
      for (const { r } of zones) {
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

      for (const { e, r } of zones) {
        let diff = 0
        const x0 = clamp(Math.floor(r[0] * scale), 0, w)
        const x1 = clamp(Math.ceil(r[2] * scale), 0, w)
        const y0 = clamp(Math.floor(r[1] * scale), 0, h)
        const y1 = clamp(Math.ceil(r[3] * scale), 0, h)
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) diff += Math.abs(A[y * stride + x * n + 1] - B[y * stride + x * n + 1])
        const changed = diff > 40 * scale
        const label = e.kind === 'erase' ? '(area cleared)' : e.text
        verdicts.push({ id: e.id, ok: changed, expected: label, actual: changed ? label : '(no visible change)' })
        if (!changed) ok = false
      }
    }
    return { page: index, ok: ok && verdicts.every((v) => v.ok), edits: verdicts, collateral, notes }
  }
}
