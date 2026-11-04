// Shared types for the PDF engine, the worker RPC and the UI.
// All geometry is in PDF points in "page space": origin top-left, y grows down,
// page rotation already applied (this is MuPDF's coordinate space).

export type Rect = [x0: number, y0: number, x1: number, y1: number]
export type Rgb = [r: number, g: number, b: number] // 0..255

export type Family = 'sans' | 'serif' | 'mono'

export interface FontStyle {
  family: Family
  bold: boolean
  italic: boolean
  /** font size in points */
  size: number
  color: Rgb
}

/**
 * How a page is edited.
 *  - `text`   : has real, visible text. Edits are true content-stream edits
 *               (old text is removed, new text is written).
 *  - `scan`   : a picture of a page with no text. Needs OCR before it can be edited.
 *  - `scan-ocr`: a picture with an invisible text layer already attached.
 *  - `outlined`: no text objects at all, but lots of vector shapes — typically a web page "printed" to PDF with
 *               the letters converted to outlines. Looks like text, behaves like a scan (OCR first).
 *  - `blank`  : nothing detectable (you can still add text / erase).
 */
export type PageKind = 'text' | 'scan' | 'scan-ocr' | 'outlined' | 'blank'

export interface PageInfo {
  index: number
  width: number
  height: number
  kind: PageKind
  visibleChars: number
  hiddenChars: number
  /** 0..1 fraction of the page covered by the largest image */
  imageCoverage: number
  /** native resolution of the dominant image in DPI (scans only) */
  imageDpi: number | null
  /** true if the dominant image is grayscale / 1-bit */
  imageGray: boolean
}

export interface OcrWord {
  text: string
  conf: number // 0..100
  x0: number
  x1: number
}

/** A contiguous piece of same-styled text on one line: the unit you click to edit. */
export interface TextRun {
  id: string
  page: number
  source: 'pdf' | 'ocr'
  text: string
  rect: Rect
  /** origin of the first glyph */
  x: number
  baseline: number
  /** x of every UTF-16 unit of `text` plus the end of the run (length = text.length + 1) */
  xs: number[]
  size: number
  fontName: string
  style: FontStyle
  /** true for text that is invisible in the page (OCR layer of a scan) */
  hidden: boolean
  /** OCR only */
  conf?: number
  words?: OcrWord[]
}

export type EditKind = 'replace' | 'add' | 'erase'

export interface Edit {
  id: string
  page: number
  kind: EditKind
  /** replace: the run being rewritten */
  run?: TextRun
  /** replace / add: the full new text */
  text: string
  style: FontStyle
  /** add: where the text starts (origin of first glyph) */
  x?: number
  baseline?: number
  /** erase: the area to clear */
  rect?: Rect
  /** erase: 'auto' samples the page background (scans) / leaves the page as is (text pages) */
  fill?: 'auto' | Rgb
  /** erase: true = a black redaction box that also destroys the pixels underneath */
  redact?: boolean
  /** replace: keep unchanged leading words in their original font/pixels (default true) */
  keepPrefix?: boolean
}

/** What the engine will do for one edit. Pure data, computed by plan.ts */
export interface EditPlan {
  /** area whose original content is removed */
  clear: Rect | null
  /** text to draw afterwards */
  draw: { text: string; x: number; baseline: number; style: FontStyle } | null
  /** number of leading characters of the original run that are left untouched */
  keep: number
  /** true when nothing would change */
  noop: boolean
}

/** Invisible-text description used to make scanned pages searchable on export. */
export interface TextLayerLine {
  text: string
  rect: Rect
  baseline: number
  size: number
  /** per-word boxes, only when the text is unchanged from what OCR saw */
  words?: { text: string; x0: number; x1: number }[]
}

export interface TextLayer {
  page: number
  lines: TextLayerLine[]
}

export interface RenderResult {
  width: number
  height: number
  rgba: Uint8ClampedArray
}

export interface PngResult {
  width: number
  height: number
  /** page-space position (pt) of the top-left pixel */
  x0: number
  y0: number
  scale: number
  png: Uint8Array
}

export interface PageSize {
  width: number
  height: number
}

export type OpenResult =
  | { status: 'ok'; sizes: PageSize[]; title: string }
  | { status: 'password' }
  | { status: 'error'; message: string }

export interface EditVerdict {
  id: string
  ok: boolean
  expected: string
  actual: string
  /** non-fatal visual problem, e.g. new text collides with existing text */
  warning?: string
}

export interface PageVerdict {
  page: number
  ok: boolean
  edits: EditVerdict[]
  /** characters (or pixels, for scans) that changed outside any edit */
  collateral: number
  notes: string[]
}

export interface VerifyReport {
  ok: boolean
  editCount: number
  passed: number
  collateral: number
  pages: PageVerdict[]
}

export interface ExportResult {
  bytes: Uint8Array
  report: VerifyReport
}

export interface ExportOptions {
  /** add an invisible, searchable text layer to scanned pages (default true) */
  textLayer: boolean
  /** JPEG quality for re-rendered scanned pages, 0-100 */
  jpegQuality: number
}
