import type { CellRange } from '../engine/table.ts'
import type { Overlay, Rect, Rgb, TableModel } from '../engine/types.ts'

/** What a click or drag on the page does. */
export type Tool =
  | 'select'
  | 'edit'
  | 'add'
  | 'erase'
  | 'highlight'
  | 'underline'
  | 'strike'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'pen'
  | 'image'
  | 'sign'
  | 'table'

export type EditingTarget =
  | { page: number; kind: 'run'; runId: string; bg: string }
  | { page: number; kind: 'add'; editId?: string; x: number; baseline: number; bg: string }

/** Colours and widths used by the drawing tools (and edited on the selected shape in the Select tool). */
export interface DrawStyle {
  color: Rgb
  /** pt */
  width: number
  /** shapes: 0 = outline only, 0.25 = tinted, 1 = solid */
  fill: number
  /** colour of the highlighter */
  highlight: Rgb
}

export interface PicInfo {
  url: string
  width: number
  height: number
}

/** One box on the page to show for Find (the current one is drawn stronger). */
export interface FindBox {
  rect: Rect
  current: boolean
}

/** The table being edited, as the page shows it: the model, which cells are selected, which one is being typed into. */
export interface TableView {
  page: number
  model: TableModel
  sel: CellRange | null
  editing: [number, number] | null
}

export interface TableApi {
  onSelect: (range: CellRange | null) => void
  /** an edge was dragged: boundary `i` of the columns ('x') or rows ('y') now sits at `pos` */
  onBoundary: (axis: 'x' | 'y', i: number, pos: number) => void
  onEdit: (cell: [number, number] | null) => void
  /** the cell's text was committed; `move` says where to go next (Tab / Shift+Tab / Enter) */
  onCellText: (r: number, c: number, text: string, move: 'next' | 'prev' | 'down' | null) => void
  /** the whole table was dragged by its move handle */
  onMove: (dx: number, dy: number) => void
}

/**
 * Something the Select tool can pick up and move:
 *  overlay – a mark, shape, pen stroke, signature or picture you drew
 *  edit    – text you added, or text of the page you edited / already moved
 *  table   – a table you edited (the whole table moves)
 *  run     – a line of the page's own text that has not been touched yet
 */
export type SelKind = 'overlay' | 'edit' | 'table' | 'run'
export interface SelKey {
  kind: SelKind
  id: string
  page: number
}
/** A string that identifies a selected thing (for sets and React keys). */
export const selId = (k: Pick<SelKey, 'kind' | 'id'>) => `${k.kind}:${k.id}`

export interface PageCallbacks {
  onVisible: (page: number) => void
  onPickRun: (page: number, runId: string) => void
  onPickEdit: (editId: string) => void
  onAddAt: (page: number, x: number, baseline: number) => void
  onErase: (page: number, rect: Rect) => void
  onRecognize: (page: number) => void
  onCreateOverlay: (page: number, overlay: Overlay) => void
  onUpdateOverlay: (id: string, overlay: Overlay) => void
  onDeleteOverlay: (id: string) => void
  /** Select tool: `set` replaces the selection, `toggle` flips these in or out of it, `add` adds them. */
  onSelect: (page: number, keys: SelKey[], mode: 'set' | 'toggle' | 'add') => void
  /** Select tool: the selected things were dragged together by (dx, dy) pt — one undo step */
  onMoveSelection: (page: number, keys: SelKey[], dx: number, dy: number) => void
  /** a click with the Image / Signature tool: place the pending picture or signature here */
  onPlace: (page: number, x: number, y: number) => void
  /** a line of the page's own text was dragged by its move handle */
  onMoveRun: (page: number, runId: string, dx: number, dy: number) => void
  /** edited or added text was dragged by its move handle */
  onMoveEdit: (editId: string, dx: number, dy: number) => void
  /** a click with the Table tool: find the table at this point */
  onTableDetect: (page: number, x: number, y: number) => void
  /** a drag with the Table tool: read a table from the text inside this box */
  onTableRegion: (page: number, rect: Rect) => void
}
