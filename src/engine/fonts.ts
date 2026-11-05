import * as mupdf from 'mupdf'
import type { Family, FontStyle } from './types.ts'

/** Loads a bundled font file by name (e.g. "DejaVuSans.ttf"). Injected so the engine runs in Node and in a worker. */
export type FontLoader = (file: string) => Promise<Uint8Array>

/**
 * A usable font face.
 *  - simple faces (the PDF base-14 fonts) are written with WinAnsi single-byte codes
 *  - CID faces (embedded TrueType) are written as glyph ids
 */
export interface Face {
  key: string
  font: mupdf.Font
  simple: boolean
}

const BASE14: Record<Family, string[]> = {
  sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  serif: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  mono: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
}
const DEJAVU: Record<Family, string[]> = {
  sans: ['DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSans-Oblique', 'DejaVuSans-BoldOblique'],
  serif: ['DejaVuSerif', 'DejaVuSerif-Bold', 'DejaVuSerif-Italic', 'DejaVuSerif-BoldItalic'],
  mono: ['DejaVuSansMono', 'DejaVuSansMono-Bold', 'DejaVuSansMono-Oblique', 'DejaVuSansMono-BoldOblique'],
}

const variant = (s: FontStyle) => (s.bold ? 1 : 0) | (s.italic ? 2 : 0)

// Unicode -> WinAnsi (cp1252) for the 0x80-0x9F block; 0x20-0x7E and 0xA0-0xFF map straight through.
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}

export function toCp1252(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return cp
  if (cp >= 0xa0 && cp <= 0xff) return cp
  return CP1252_HIGH[cp] ?? null
}

export class FontBook {
  private loader: FontLoader
  private cache = new Map<string, Face>()
  private user: Face[] = []

  constructor(loader: FontLoader) {
    this.loader = loader
  }

  /** Register an extra font (e.g. a Tamil/Devanagari TTF) used for glyphs the built-in fonts lack. */
  addUserFont(name: string, bytes: Uint8Array) {
    const font = new mupdf.Font(name, bytes.slice())
    this.user.push({ key: `user:${name}`, font, simple: false })
  }

  private base14(style: FontStyle): Face {
    const name = BASE14[style.family][variant(style)]
    let f = this.cache.get(name)
    if (!f) {
      f = { key: name, font: new mupdf.Font(name), simple: true }
      this.cache.set(name, f)
    }
    return f
  }

  private async dejavu(style: FontStyle): Promise<Face> {
    const name = DEJAVU[style.family][variant(style)]
    let f = this.cache.get(name)
    if (!f) {
      const bytes = await this.loader(`${name}.ttf`)
      f = { key: name, font: new mupdf.Font(name, bytes.slice()), simple: false }
      this.cache.set(name, f)
    }
    return f
  }

  /** Faces to try, in priority order, for a style. */
  async facesFor(style: FontStyle, needFallback: boolean): Promise<Face[]> {
    // `style.dejavu`: the text came from a DejaVu document, so keep that look instead of switching to Helvetica
    const out: Face[] = style.dejavu ? [await this.dejavu(style)] : [this.base14(style)]
    if (needFallback && !style.dejavu) out.push(await this.dejavu(style))
    out.push(...this.user)
    return out
  }

  supports(face: Face, ch: string): boolean {
    const cp = ch.codePointAt(0)!
    if (face.simple && toCp1252(cp) === null) return false
    return face.font.encodeCharacter(cp) > 0
  }

  /**
   * Split text into runs that each use one face. Whitespace stays with the previous run.
   * `missing` lists characters no face could draw (they will render blank).
   */
  async segment(text: string, style: FontStyle): Promise<{ segments: { face: Face; text: string }[]; missing: string[] }> {
    let faces = await this.facesFor(style, false)
    const needsMore = [...text].some((ch) => ch.trim() !== '' && !this.supports(faces[0], ch))
    if (needsMore) faces = await this.facesFor(style, true)

    const segments: { face: Face; text: string }[] = []
    const missing: string[] = []
    for (const ch of text) {
      const last: { face: Face; text: string } | undefined = segments[segments.length - 1]
      let face: Face | undefined
      if (ch.trim() === '') face = last?.face ?? faces[0]
      else face = faces.find((f) => this.supports(f, ch))
      if (!face) {
        if (!missing.includes(ch)) missing.push(ch)
        face = last?.face ?? faces[0]
      }
      if (last && last.face === face) last.text += ch
      else segments.push({ face, text: ch })
    }
    return { segments, missing }
  }

  /** Natural advance width of text in points (no kerning), measured across fallback faces. */
  async measure(text: string, style: FontStyle): Promise<number> {
    const { segments } = await this.segment(text, style)
    return segments.reduce((w, s) => w + segmentWidth(s.face, s.text, style.size), 0)
  }
}

export function segmentWidth(face: Face, text: string, size: number): number {
  let w = 0
  for (const ch of text) {
    const gid = face.font.encodeCharacter(ch.codePointAt(0)!)
    w += face.font.advanceGlyph(gid) * size
  }
  return w
}

/** Encode text for a `Tj` operator in the given face. */
export function encodeForFace(face: Face, text: string): string {
  if (!face.simple) {
    let hex = ''
    for (const ch of text) hex += face.font.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, '0')
    return `<${hex}>`
  }
  let out = ''
  for (const ch of text) {
    const code = toCp1252(ch.codePointAt(0)!) ?? 0x20
    if (code === 0x5c || code === 0x28 || code === 0x29) out += '\\' + String.fromCharCode(code)
    else if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code)
    else out += '\\' + code.toString(8).padStart(3, '0')
  }
  return `(${out})`
}

/** Per-document registry of the PDF font objects we add. */
export class DocFonts {
  private doc: mupdf.PDFDocument
  private refs = new Map<string, { name: string; ref: mupdf.PDFObject }>()
  /** Resource names must not collide with those of an earlier edit session (a file we exported before, opened again). */
  private tag = Math.random().toString(36).slice(2, 6)
  usedCid = false

  constructor(doc: mupdf.PDFDocument) {
    this.doc = doc
  }

  resource(face: Face): string {
    let r = this.refs.get(face.key)
    if (!r) {
      const ref = face.simple ? this.doc.addSimpleFont(face.font, 'Latin') : this.doc.addFont(face.font)
      if (!face.simple) this.usedCid = true
      r = { name: `PDEdF${this.tag}${this.refs.size + 1}`, ref }
      this.refs.set(face.key, r)
    }
    return r.name
  }

  entries(): [string, mupdf.PDFObject][] {
    return [...this.refs.values()].map((r) => [r.name, r.ref])
  }
}
