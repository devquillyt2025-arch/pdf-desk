// Stateless PDF utilities (merge, re-order, rotate, images → PDF, password, stamps).
// Pure TypeScript on MuPDF: runs in the engine worker *and* in Node (that is how it is tested).
// The UI must only `import type` from here, otherwise MuPDF ends up in the main bundle.
import * as mupdf from 'mupdf'
import { encodeForFace, segmentWidth, type Face, type FontBook } from './fonts.ts'
import type { PageSize, Rgb } from './types.ts'

export interface PdfSource {
  bytes: Uint8Array
  password?: string
}

export type InspectResult =
  | { status: 'ok'; pages: number; sizes: PageSize[]; encrypted: boolean; title: string }
  | { status: 'password' }
  | { status: 'error'; message: string }

/** One page of the output: which source page, and how many degrees to turn it (multiples of 90). */
export interface PageOp {
  src: number
  rotate?: number
}

export interface ToolResult {
  bytes: Uint8Array
  pages: number
  warnings?: string[]
}

export interface ImagesToPdfOptions {
  /** `fit`: the page is the picture (shrunk to A4 if bigger). `a4` / `letter`: picture centred on that paper. */
  size: 'fit' | 'a4' | 'letter'
  /** points (1/72 in) of white around the picture */
  margin: number
}

export type NumberPosition = 'bottom-center' | 'bottom-left' | 'bottom-right' | 'top-center' | 'top-left' | 'top-right'

export interface StampNumbers {
  /** `{n}` = this page's number, `{N}` = number of pages */
  format: string
  position: NumberPosition
  size: number
  start: number
  margin: number
  color: Rgb
  skipFirst: boolean
}

export interface StampWatermark {
  text: string
  size: number
  /** 0..1 */
  opacity: number
  /** degrees, counter-clockwise */
  angle: number
  color: Rgb
}

export interface StampOptions {
  numbers?: StampNumbers | null
  watermark?: StampWatermark | null
}

export interface PreviewResult {
  png: Uint8Array
  width: number
  height: number
}

const SAVE = 'garbage=compact,compress'
const num = (n: number) => (Math.round(n * 1000) / 1000).toString()
const rgb01 = (c: Rgb) => c.map((v) => num(v / 255)).join(' ')

function openPdf(src: PdfSource): mupdf.PDFDocument {
  let d: mupdf.Document
  try {
    d = mupdf.Document.openDocument(src.bytes.slice(), 'application/pdf')
  } catch (e) {
    throw new Error(`Could not open this file: ${String((e as Error).message ?? e)}`)
  }
  if (!d.isPDF()) throw new Error('This file is not a PDF.')
  if (d.needsPassword() && !(src.password && d.authenticatePassword(src.password))) {
    throw new Error(src.password ? 'That password didn’t work.' : 'This PDF is password protected.')
  }
  return d.asPDF()!
}

function finish(doc: mupdf.PDFDocument, extra = '', warnings?: string[]): ToolResult {
  const pages = doc.countPages()
  // saveToBuffer().asUint8Array() is a view into WASM memory: copy it before anything else allocates.
  const bytes = doc.saveToBuffer(SAVE + extra).asUint8Array().slice()
  doc.destroy()
  return { bytes, pages, ...(warnings?.length ? { warnings } : {}) }
}

function turnPage(doc: mupdf.PDFDocument, index: number, delta: number) {
  const d = ((Math.round(delta / 90) * 90) % 360 + 360) % 360
  if (!d) return
  const pobj = doc.findPage(index)
  const cur = pobj.getInheritable('Rotate')
  const base = cur.isNumber() ? cur.asNumber() : 0
  pobj.put('Rotate', (((base + d) % 360) + 360) % 360)
}

/** Add content (page space, y down) on top of a page without disturbing what is already there. */
function appendPageContent(doc: mupdf.PDFDocument, page: mupdf.PDFPage, content: string, fonts: [string, mupdf.PDFObject][], gstates: [string, mupdf.PDFObject][]) {
  const pobj = page.getObject()
  const old = pobj.getInheritable('Resources')
  const res = doc.newDictionary()
  const fd = doc.newDictionary()
  const gd = doc.newDictionary()
  if (!old.isNull()) {
    old.forEach((v, k) => {
      if (k !== 'Font' && k !== 'ExtGState') res.put(k, v)
    })
    const oldFonts = old.get('Font')
    if (!oldFonts.isNull()) oldFonts.forEach((v, k) => fd.put(k, v))
    const oldGs = old.get('ExtGState')
    if (!oldGs.isNull()) oldGs.forEach((v, k) => gd.put(k, v))
  }
  for (const [name, ref] of fonts) fd.put(name, ref)
  for (const [name, ref] of gstates) gd.put(name, ref)
  res.put('Font', fd)
  res.put('ExtGState', gd)
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

export class PdfTools {
  private book: FontBook

  constructor(book: FontBook) {
    this.book = book
  }

  // ------------------------------------------------------------------------------------ inspect

  inspect(src: PdfSource): InspectResult {
    let d: mupdf.Document
    try {
      d = mupdf.Document.openDocument(src.bytes.slice(), 'application/pdf')
    } catch (e) {
      return { status: 'error', message: `Could not open this file: ${String((e as Error).message ?? e)}` }
    }
    if (!d.isPDF()) return { status: 'error', message: 'This file is not a PDF.' }
    const encrypted = d.needsPassword()
    if (encrypted && !(src.password && d.authenticatePassword(src.password))) return { status: 'password' }
    const pdf = d.asPDF()!
    const sizes: PageSize[] = []
    const n = pdf.countPages()
    for (let i = 0; i < n; i++) {
      const p = pdf.loadPage(i)
      const [x0, y0, x1, y1] = p.getBounds()
      sizes.push({ width: x1 - x0, height: y1 - y0 })
      p.destroy()
    }
    const title = pdf.getMetaData('info:Title') ?? ''
    pdf.destroy()
    return { status: 'ok', pages: n, sizes, encrypted, title }
  }

  // ------------------------------------------------------------------------ merge / re-arrange

  /** Join several PDFs, in the order given, into one. */
  merge(sources: PdfSource[]): ToolResult {
    if (sources.length < 1) throw new Error('Add at least one PDF.')
    const out = new mupdf.PDFDocument()
    for (const s of sources) {
      const doc = openPdf(s)
      const map = out.newGraftMap() // one map per source so shared fonts/images are copied once
      const n = doc.countPages()
      for (let i = 0; i < n; i++) map.graftPage(-1, doc, i)
      doc.destroy()
    }
    return finish(out)
  }

  /**
   * Build a new PDF from chosen pages of one source: any order, any subset, repeats allowed, each page
   * optionally turned. This one routine is "delete pages", "extract pages", "re-order", "rotate" and "duplicate".
   */
  rebuild(src: PdfSource, ops: PageOp[]): ToolResult {
    if (!ops.length) throw new Error('Keep at least one page.')
    const doc = openPdf(src)
    const count = doc.countPages()
    const out = new mupdf.PDFDocument()
    const map = out.newGraftMap()
    ops.forEach((op, i) => {
      if (!Number.isInteger(op.src) || op.src < 0 || op.src >= count) throw new Error(`Page ${op.src + 1} does not exist (the file has ${count}).`)
      map.graftPage(-1, doc, op.src)
      turnPage(out, i, op.rotate ?? 0)
    })
    doc.destroy()
    return finish(out)
  }

  // ----------------------------------------------------------------------------- images → PDF

  imagesToPdf(images: { name: string; bytes: Uint8Array }[], opts: ImagesToPdfOptions): ToolResult {
    if (!images.length) throw new Error('Add at least one picture.')
    const doc = new mupdf.PDFDocument()
    const m = Math.max(0, opts.margin)
    for (const im of images) {
      let img: mupdf.Image
      try {
        img = new mupdf.Image(im.bytes.slice())
      } catch {
        throw new Error(`Could not read “${im.name}” as a picture. JPG and PNG work best.`)
      }
      const w = img.getWidth()
      const h = img.getHeight()
      if (!(w > 0 && h > 0)) throw new Error(`“${im.name}” has no picture data.`)
      let pw: number, ph: number, x: number, y: number, dw: number, dh: number
      if (opts.size === 'fit') {
        const [bw, bh] = w >= h ? [842, 595] : [595, 842]
        const s = Math.min(0.75, bw / w, bh / h) // 96 dpi, shrunk until it fits A4
        dw = w * s
        dh = h * s
        pw = dw + 2 * m
        ph = dh + 2 * m
        x = m
        y = m
      } else {
        const [sw, sh] = opts.size === 'a4' ? [595.28, 841.89] : [612, 792]
        const landscape = w > h
        pw = landscape ? sh : sw
        ph = landscape ? sw : sh
        const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h)
        dw = w * s
        dh = h * s
        x = (pw - dw) / 2
        y = (ph - dh) / 2
      }
      const ref = doc.addImage(img)
      const page = doc.addPage([0, 0, pw, ph], 0, { XObject: { Im0: ref } }, `q ${num(dw)} 0 0 ${num(dh)} ${num(x)} ${num(y)} cm /Im0 Do Q`)
      doc.insertPage(-1, page)
    }
    return finish(doc)
  }

  // --------------------------------------------------------------------------------- passwords

  /** AES-256 encryption: the file asks for `password` before it opens. */
  protect(src: PdfSource, password: string): ToolResult {
    if (!password) throw new Error('Choose a password.')
    // MuPDF takes its save options as one comma-separated string, so a comma would be read as the next option.
    if (password.includes(',')) throw new Error('The password can’t contain a comma. Use letters, numbers or other symbols.')
    const doc = openPdf(src)
    return finish(doc, `,encrypt=aes-256,user-password=${password},owner-password=${password}`)
  }

  /** Save a copy that no longer asks for a password (the source password must be given). */
  unlock(src: PdfSource): ToolResult {
    const doc = openPdf(src)
    return finish(doc, ',encrypt=no')
  }

  // ------------------------------------------------------------------------------------ stamps

  /** Page numbers and/or a text watermark on every page. */
  async stamp(src: PdfSource, opts: StampOptions): Promise<ToolResult> {
    const doc = openPdf(src)
    const total = doc.countPages()
    const idx = Array.from({ length: total }, (_, i) => i)
    const warnings = await this.overlay(doc, idx, (i) => ({ index: i, total }), opts)
    return finish(doc, '', warnings)
  }

  /** What page `pageIndex` looks like with the stamps on it, as a PNG about `width` px wide. */
  async stampPreview(src: PdfSource, opts: StampOptions, pageIndex: number, width: number): Promise<PreviewResult> {
    const doc = openPdf(src)
    const total = doc.countPages()
    const at = Math.min(Math.max(0, pageIndex), total - 1)
    const out = new mupdf.PDFDocument()
    out.newGraftMap().graftPage(-1, doc, at)
    doc.destroy()
    await this.overlay(out, [0], () => ({ index: at, total }), opts)
    const page = out.loadPage(0)
    const [x0, , x1] = page.getBounds()
    const s = Math.max(0.1, width / Math.max(1, x1 - x0))
    const pm = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false)
    const png = pm.asPNG().slice()
    const res = { png, width: pm.getWidth(), height: pm.getHeight() }
    pm.destroy()
    page.destroy()
    out.destroy()
    return res
  }

  private async overlay(doc: mupdf.PDFDocument, indexes: number[], where: (i: number) => { index: number; total: number }, opts: StampOptions): Promise<string[]> {
    const warnings = new Set<string>()
    // Resource names are unique to this pass: a page that is stamped again keeps the fonts and opacity the first pass used
    const tag = Math.random().toString(36).slice(2, 7)
    const gsName = `PDStG${tag}`
    const fontRefs = new Map<string, { name: string; ref: mupdf.PDFObject }>()
    const fontFor = (face: Face) => {
      let r = fontRefs.get(face.key)
      if (!r) {
        const ref = face.simple ? doc.addSimpleFont(face.font, 'Latin') : doc.addFont(face.font)
        r = { name: `PDStF${tag}${fontRefs.size + 1}`, ref }
        fontRefs.set(face.key, r)
      }
      return r.name
    }
    const wm = opts.watermark && opts.watermark.text.trim() ? opts.watermark : null
    let gsRef: mupdf.PDFObject | null = null
    if (wm) {
      const d = doc.newDictionary()
      d.put('Type', doc.newName('ExtGState'))
      d.put('ca', doc.newReal(Math.min(1, Math.max(0, wm.opacity))))
      d.put('CA', doc.newReal(Math.min(1, Math.max(0, wm.opacity))))
      gsRef = doc.addObject(d)
    }

    const draw = async (text: string, size: number, color: Rgb, bold: boolean, origin: [number, number], angleDeg: number): Promise<{ ops: string[]; width: number }> => {
      const style = { family: 'sans' as const, bold, italic: false, size, color }
      const { segments, missing } = await this.book.segment(text, style)
      for (const ch of missing) warnings.add(`“${ch}” isn’t in the built-in fonts, so it is left blank. Add a font for that script with the A button in the top bar.`)
      const a = (angleDeg * Math.PI) / 180
      const c = Math.cos(a)
      const s = Math.sin(a)
      const ops = [`${rgb01(color)} rg`]
      let [ox, oy] = origin
      let width = 0
      for (const seg of segments) {
        const w = segmentWidth(seg.face, seg.text, size)
        ops.push(`BT /${fontFor(seg.face)} ${num(size)} Tf ${num(c)} ${num(-s)} ${num(-s)} ${num(-c)} ${num(ox)} ${num(oy)} Tm ${encodeForFace(seg.face, seg.text)} Tj ET`)
        ox += w * c
        oy -= w * s
        width += w
      }
      return { ops, width }
    }
    const measure = async (text: string, size: number, bold: boolean) => {
      const { segments } = await this.book.segment(text, { family: 'sans', bold, italic: false, size, color: [0, 0, 0] })
      return segments.reduce((w, s) => w + segmentWidth(s.face, s.text, size), 0)
    }

    for (const i of indexes) {
      const { index, total } = where(i)
      const page = doc.loadPage(i)
      const [bx0, by0, bx1, by1] = page.getBounds()
      const ops: string[] = []

      if (wm) {
        const size = Math.max(6, wm.size)
        const text = wm.text.trim()
        const w = await measure(text, size, true)
        const a = (wm.angle * Math.PI) / 180
        const h = size * 0.35 // roughly half the cap height: centres the text on its middle
        const cx = (bx0 + bx1) / 2
        const cy = (by0 + by1) / 2
        const ox = cx - (w / 2) * Math.cos(a) + h * Math.sin(a)
        const oy = cy + (w / 2) * Math.sin(a) + h * Math.cos(a)
        ops.push('q', `/${gsName} gs`)
        ops.push(...(await draw(text, size, wm.color, true, [ox, oy], wm.angle)).ops)
        ops.push('Q')
      }

      const nb = opts.numbers
      if (nb && !(nb.skipFirst && index === 0)) {
        const text = nb.format.replaceAll('{n}', String(nb.start + index)).replaceAll('{N}', String(total))
        if (text.trim()) {
          const size = Math.max(4, nb.size)
          const w = await measure(text, size, false)
          const [v, hz] = nb.position.split('-') as ['top' | 'bottom', 'left' | 'center' | 'right']
          const x = hz === 'left' ? bx0 + nb.margin : hz === 'right' ? bx1 - nb.margin - w : (bx0 + bx1) / 2 - w / 2
          const y = v === 'bottom' ? by1 - nb.margin : by0 + nb.margin + size * 0.8
          ops.push(...(await draw(text, size, nb.color, false, [x, y], 0)).ops)
        }
      }

      if (ops.length) {
        appendPageContent(doc, page, ops.join('\n'), [...fontRefs.values()].map((r) => [r.name, r.ref]), gsRef ? [[gsName, gsRef]] : [])
      }
      page.destroy()
    }
    return [...warnings]
  }
}
