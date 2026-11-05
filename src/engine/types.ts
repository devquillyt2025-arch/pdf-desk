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
  /** use the bundled DejaVu face instead of the PDF base-14 equivalent (keeps a DejaVu document looking like itself) */
  dejavu?: boolean
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

export type EditKind = 'replace' | 'add' | 'erase' | 'overlay' | 'table'

export type Pt = [x: number, y: number]

export type TableAlign = 'left' | 'center' | 'right'

export interface TableCell {
  text: string
  /** background; null = none (the page shows through) */
  fill: Rgb | null
  /** text colour */
  color: Rgb
  family: Family
  bold: boolean
  italic: boolean
  size: number
  /** the original font was DejaVu: keep using the bundled DejaVu so the table keeps its look */
  dejavu?: boolean
  align: TableAlign
}

export interface TableBorders {
  color: Rgb
  /** pt */
  width: number
  /** the frame around the table */
  outer: boolean
  /** lines between rows */
  innerH: boolean
  /** lines between columns */
  innerV: boolean
}

/** A table as a grid: column edges, row edges, and one cell per row × column. Page space, pt. */
export interface TableModel {
  /** column edges, left to right (columns + 1 values) */
  xs: number[]
  /** row edges, top to bottom (rows + 1 values) */
  ys: number[]
  cells: TableCell[][]
  borders: TableBorders
  /**
   * Wrap long text inside its cell (rows grow to fit). Off = one line per cell, as many PDFs have it, even if it runs
   * past the border. A table that came with overflowing text starts with this off, so redrawing it changes nothing
   * you did not ask for. Missing = on.
   */
  wrap?: boolean
}

/**
 * Editing a table redraws it: the old text and lines inside `clear` are removed and the model is drawn in their
 * place. `clear` holds the old table box and any text that stuck out of its cells.
 */
export interface TableEdit {
  model: TableModel
  clear: Rect[]
  /** the table is removed altogether */
  deleted: boolean
}

/**
 * Something drawn *on top of* a page without touching what is already there: markup, shapes, pen strokes,
 * signatures and pictures. Geometry is in page space (pt). Unlike text edits they never remove content.
 */
export type Overlay =
  | { type: 'highlight'; rects: Rect[]; color: Rgb; opacity: number }
  | { type: 'underline' | 'strike'; rects: Rect[]; color: Rgb; width: number }
  | { type: 'rect' | 'ellipse'; rect: Rect; stroke: Rgb | null; fill: Rgb | null; width: number; opacity: number }
  | { type: 'line' | 'arrow'; a: Pt; b: Pt; color: Rgb; width: number }
  /** freehand pen and signatures: each stroke is a list of points */
  | { type: 'ink'; strokes: Pt[][]; color: Rgb; width: number }
  | { type: 'image'; rect: Rect; imageId: string; opacity: number }

export interface Edit {
  id: string
  page: number
  kind: EditKind
  /** overlay: what to draw */
  overlay?: Overlay
  /** table: the redrawn table */
  table?: TableEdit
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
  /** replace: the line was dragged somewhere else — how far in x and y, in pt. The whole line is then set down anew. */
  move?: [dx: number, dy: number]
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
