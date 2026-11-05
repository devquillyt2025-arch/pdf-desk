// Tables in a PDF are not objects: they are lines, filled boxes and loose text that happen to line up. This module
// finds that grid (detectGrid / inferGrid), and edits it as a model (insert, delete, resize, restyle). Pure TypeScript
// with no MuPDF, so it runs in the browser, in the worker and in the tests.
import type { FontStyle, Pt, Rect, Rgb, TableBorders, TableCell, TableEdit, TableModel, TextRun } from './types.ts'

export const CELL_PAD_X = 4
export const CELL_PAD_Y = 3
/** line height as a multiple of the font size */
export const LINE_HEIGHT = 1.25
export const MIN_ROW = 12
export const MIN_COL = 14

// ----------------------------------------------------------------------------------------- input

/** A ruled line found on the page: `at` is its y (horizontal) or x (vertical), `a`..`b` how far it runs. */
export interface Line {
  at: number
  a: number
  b: number
  width: number
  color: Rgb
}
export interface FillRect {
  rect: Rect
  color: Rgb
}
/** Everything drawn on a page that could belong to a table. `fills` are in painting order (later = on top). */
export interface Graphics {
  h: Line[]
  v: Line[]
  fills: FillRect[]
}

// ------------------------------------------------------------------------------------ small tools

const inRect = (r: Rect, x: number, y: number, d = 0) => x >= r[0] - d && x <= r[2] + d && y >= r[1] - d && y <= r[3] + d
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])
const intersect = (a: Rect, b: Rect): Rect => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
const unionRect = (rs: Rect[]): Rect => rs.reduce<Rect>((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity])
const isWhite = (c: Rgb) => c[0] > 250 && c[1] > 250 && c[2] > 250

export const cellRect = (m: TableModel, r: number, c: number): Rect => [m.xs[c], m.ys[r], m.xs[c + 1], m.ys[r + 1]]
export const tableBounds = (m: TableModel): Rect => [m.xs[0], m.ys[0], m.xs[m.xs.length - 1], m.ys[m.ys.length - 1]]
export const rowCount = (m: TableModel) => m.ys.length - 1
export const colCount = (m: TableModel) => m.xs.length - 1

export function cellStyle(c: TableCell): FontStyle {
  return { family: c.family, bold: c.bold, italic: c.italic, size: c.size, color: c.color, ...(c.dejavu ? { dejavu: true } : {}) }
}

/** Words of `text` packed into lines no wider than `maxW` (a single longer word keeps its own line). */
export async function wrapLines(text: string, maxW: number, measure: (s: string) => Promise<number> | number): Promise<string[]> {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean)
    if (!words.length) {
      out.push('')
      continue
    }
    let line = words[0]
    for (let i = 1; i < words.length; i++) {
      const next = `${line} ${words[i]}`
      if ((await measure(next)) <= maxW) line = next
      else {
        out.push(line)
        line = words[i]
      }
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

/** Border lines to draw for a model, from its three flags. */
export function tableLines(m: TableModel): { h: { y: number; x0: number; x1: number }[]; v: { x: number; y0: number; y1: number }[] } {
  const [x0, y0, x1, y1] = tableBounds(m)
  const h: { y: number; x0: number; x1: number }[] = []
  const v: { x: number; y0: number; y1: number }[] = []
  m.ys.forEach((y, i) => {
    const edge = i === 0 || i === m.ys.length - 1
    if (edge ? m.borders.outer : m.borders.innerH) h.push({ y, x0, x1 })
  })
  m.xs.forEach((x, i) => {
    const edge = i === 0 || i === m.xs.length - 1
    if (edge ? m.borders.outer : m.borders.innerV) v.push({ x, y0, y1 })
  })
  return { h, v }
}

// ------------------------------------------------------------------------------------- detection

/** Join collinear, overlapping or touching segments into long ones (a table border is often drawn in pieces). */
export function mergeLines(lines: Line[], tol = 1.2, gap = 2.5): Line[] {
  const sorted = [...lines].sort((p, q) => p.at - q.at || p.a - q.a)
  const out: Line[] = []
  for (const l of sorted) {
    const m = out.find((o) => Math.abs(o.at - l.at) <= tol && l.a <= o.b + gap && l.b >= o.a - gap)
    if (m) {
      if (l.b - l.a > m.b - m.a) {
        m.width = l.width
        m.color = l.color
      }
      m.a = Math.min(m.a, l.a)
      m.b = Math.max(m.b, l.b)
    } else out.push({ ...l })
  }
  return out.length === lines.length ? out : mergeLines(out, tol, gap)
}

/** Group sorted numbers that are within `tol` of each other; each group becomes its mean. */
export function cluster(values: number[], tol = 1.5): number[] {
  const out: number[][] = []
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = out[out.length - 1]
    if (last && v - last[last.length - 1] <= tol) last.push(v)
    else out.push([v])
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length)
}

/** Fraction of [a0, a1] covered by lines lying on `at`. */
function coverage(lines: Line[], at: number, a0: number, a1: number, tol = 2): number {
  const spans = lines
    .filter((l) => Math.abs(l.at - at) <= tol)
    .map((l) => [Math.max(a0, l.a), Math.min(a1, l.b)] as const)
    .filter(([s, e]) => e > s)
    .sort((p, q) => p[0] - q[0])
  let covered = 0
  let end = a0
  for (const [s, e] of spans) {
    const from = Math.max(s, end)
    if (e > from) covered += e - from
    end = Math.max(end, e)
  }
  return a1 > a0 ? covered / (a1 - a0) : 0
}

/** The text of one cell: its runs, line by line, left to right. */
function cellContent(runs: TextRun[]): { text: string; main: TextRun | null; extent: Rect | null } {
  if (!runs.length) return { text: '', main: null, extent: null }
  const sorted = [...runs].sort((a, b) => a.baseline - b.baseline || a.x - b.x)
  const lines: TextRun[][] = []
  for (const r of sorted) {
    const last = lines[lines.length - 1]
    if (last && Math.abs(last[0].baseline - r.baseline) <= Math.max(2, r.size * 0.45)) last.push(r)
    else lines.push([r])
  }
  const text = lines
    .map((l) =>
      l
        .sort((a, b) => a.x - b.x)
        .reduce((s, r, i) => (i === 0 ? r.text : s + (r.rect[0] - l[i - 1].rect[2] > r.size * 0.2 && !/\s$/.test(s) && !/^\s/.test(r.text) ? ' ' : '') + r.text), '')
        .trim(),
    )
    .join(' ')
  const main = runs.reduce((best, r) => (r.text.trim().length > best.text.trim().length ? r : best), runs[0])
  return { text, main, extent: unionRect(runs.map((r) => r.rect)) }
}

function alignOf(main: TextRun, cell: Rect): TableCell['align'] {
  const left = main.rect[0] - cell[0]
  const right = cell[2] - main.rect[2]
  const s = main.size
  if (right < 0 || left < 0) return 'left'
  if (left > CELL_PAD_X + s * 0.6 && Math.abs(left - right) <= s * 0.3 + 1.5) return 'center'
  if (right + s * 0.8 < left && right < s * 1.4) return 'right'
  return 'left'
}

const NO_BORDERS: TableBorders = { color: [90, 90, 90], width: 0.75, outer: false, innerH: false, innerV: false }

interface Built {
  edit: TableEdit
  runsUsed: number
}

/** Fill a grid with the text and backgrounds found inside its cells. */
function fillCells(xs: number[], ys: number[], runs: TextRun[], fills: FillRect[], bounds: Rect, borders: TableBorders): Built {
  const model: TableModel = { xs, ys, cells: [], borders }
  const extents: Rect[] = []
  let overflow = false
  const boundsArea = area(bounds)
  const usable = fills.filter((f) => area(f.rect) <= boundsArea * 1.3 && Math.min(f.rect[2] - f.rect[0], f.rect[3] - f.rect[1]) >= 2.5)
  let used = 0
  for (let r = 0; r < ys.length - 1; r++) {
    const row: TableCell[] = []
    for (let c = 0; c < xs.length - 1; c++) {
      const rect: Rect = [xs[c], ys[r], xs[c + 1], ys[r + 1]]
      const mine = runs.filter((t) => inRect(rect, (t.rect[0] + t.rect[2]) / 2, (t.rect[1] + t.rect[3]) / 2))
      used += mine.length
      const { text, main, extent } = cellContent(mine)
      if (extent) {
        extents.push(extent)
        if (extent[2] > rect[2] + 0.5 || extent[0] < rect[0] - 0.5) overflow = true
      }
      // the topmost fill that really covers this cell
      let fill: Rgb | null = null
      for (const f of usable) {
        const cx = (rect[0] + rect[2]) / 2
        const cy = (rect[1] + rect[3]) / 2
        if (inRect(f.rect, cx, cy) && area(intersect(f.rect, rect)) >= area(rect) * 0.5) fill = isWhite(f.color) ? null : f.color
      }
      row.push({
        text,
        fill,
        color: main?.style.color ?? [0, 0, 0],
        family: main?.style.family ?? 'sans',
        bold: main?.style.bold ?? false,
        italic: main?.style.italic ?? false,
        size: main?.style.size ?? 10,
        ...(main && /dejavu|bitstream.?vera/i.test(main.fontName) ? { dejavu: true } : {}),
        align: main ? alignOf(main, rect) : 'left',
      })
    }
    model.cells.push(row)
  }
  if (overflow) model.wrap = false // keep the original look: its long text ran past the border on one line
  // fill in empty cells' text style from a neighbour so a new text typed there looks like the rest
  const donor = model.cells.flat().find((c) => c.text) ?? model.cells[0][0]
  for (const row of model.cells) for (const c of row) if (!c.text) Object.assign(c, { family: donor.family, bold: false, italic: false, size: donor.size, color: donor.color, ...(donor.dejavu ? { dejavu: true } : {}) })

  const pad = Math.max(borders.width / 2, 0.5) + 1.5
  const box: Rect = [bounds[0] - pad, bounds[1] - pad, bounds[2] + pad, bounds[3] + pad]
  // text that sticks out of its cell must go too, or it would be left behind as ghost glyphs
  const clear: Rect[] = [box, ...extents.filter((e) => e[0] < box[0] || e[1] < box[1] || e[2] > box[2] || e[3] > box[3])]
  return { edit: { model, clear, deleted: false }, runsUsed: used }
}

/** The line colour and thickness used most (by length) in a set of lines. */
function dominant(lines: Line[]): { color: Rgb; width: number } | null {
  const tally = new Map<string, { color: Rgb; width: number; len: number }>()
  for (const l of lines) {
    const key = `${l.color.join(',')}|${l.width.toFixed(2)}`
    const t = tally.get(key) ?? { color: l.color, width: l.width, len: 0 }
    t.len += l.b - l.a
    tally.set(key, t)
  }
  const best = [...tally.values()].sort((a, b) => b.len - a.len)[0]
  return best ? { color: best.color, width: best.width } : null
}

/**
 * Find the ruled table at page point `pt`: lines that touch each other form a grid; its cells take the text and
 * background that lie inside them. Returns null when no grid (≥ 2 rows and 2 columns of lines) surrounds the point.
 */
export function detectGrid(g: Graphics, runs: TextRun[], pt: Pt): TableEdit | null {
  const H = mergeLines(g.h)
  const V = mergeLines(g.v)
  const all = [...H.map((l) => ({ l, h: true })), ...V.map((l) => ({ l, h: false }))]
  const parent = all.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const T = 1.8
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].h === all[j].h) continue
      const [hh, vv] = all[i].h ? [all[i].l, all[j].l] : [all[j].l, all[i].l]
      if (vv.at >= hh.a - T && vv.at <= hh.b + T && hh.at >= vv.a - T && hh.at <= vv.b + T) parent[find(i)] = find(j)
    }
  }
  const groups = new Map<number, typeof all>()
  all.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]))

  let best: { h: Line[]; v: Line[]; box: Rect } | null = null
  for (const members of groups.values()) {
    const h = members.filter((m) => m.h).map((m) => m.l)
    const v = members.filter((m) => !m.h).map((m) => m.l)
    if (h.length < 2 || v.length < 2) continue
    const box: Rect = [Math.min(...v.map((l) => l.at)), Math.min(...h.map((l) => l.at)), Math.max(...v.map((l) => l.at)), Math.max(...h.map((l) => l.at))]
    if (!inRect(box, pt[0], pt[1], 2)) continue
    if (!best || area(box) < area(best.box)) best = { h, v, box }
  }
  if (!best) return null

  const xs = cluster(best.v.map((l) => l.at))
  const ys = cluster(best.h.map((l) => l.at))
  if (xs.length < 2 || ys.length < 2) return null
  const bounds: Rect = [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]]

  const lines = [...best.h, ...best.v]
  const dom = dominant(lines) ?? { color: NO_BORDERS.color, width: NO_BORDERS.width }
  const edgeCov = [coverage(best.h, ys[0], bounds[0], bounds[2]), coverage(best.h, ys[ys.length - 1], bounds[0], bounds[2]), coverage(best.v, xs[0], bounds[1], bounds[3]), coverage(best.v, xs[xs.length - 1], bounds[1], bounds[3])]
  const inner = (ls: Line[], edges: number[], a0: number, a1: number) => edges.slice(1, -1).some((e) => coverage(ls, e, a0, a1) >= 0.7)
  const borders: TableBorders = {
    color: dom.color,
    width: Math.max(0.25, dom.width),
    outer: edgeCov.filter((c) => c >= 0.7).length >= 3,
    innerH: ys.length > 2 ? inner(best.h, ys, bounds[0], bounds[2]) : true,
    innerV: xs.length > 2 ? inner(best.v, xs, bounds[1], bounds[3]) : true,
  }
  return fillCells(xs, ys, runs, g.fills, bounds, borders).edit
}

/**
 * For tables with no ruled grid: infer columns and rows from where the text sits inside `area` (a box the user
 * dragged). Columns are the stretches of x that hold text; rows are the lines of text.
 */
export function inferGrid(g: Graphics, runs: TextRun[], areaRect: Rect): TableEdit | null {
  const inside = runs.filter((r) => inRect(areaRect, (r.rect[0] + r.rect[2]) / 2, (r.rect[1] + r.rect[3]) / 2) && r.text.trim())
  if (inside.length < 2) return null

  // rows = lines of text
  const sorted = [...inside].sort((a, b) => a.baseline - b.baseline)
  const rows: { top: number; bottom: number; base: number }[] = []
  for (const r of sorted) {
    const last = rows[rows.length - 1]
    if (last && Math.abs(last.base - r.baseline) <= Math.max(2, r.size * 0.5)) {
      last.top = Math.min(last.top, r.rect[1])
      last.bottom = Math.max(last.bottom, r.rect[3])
    } else rows.push({ top: r.rect[1], bottom: r.rect[3], base: r.baseline })
  }
  // columns = x stretches that hold text, with gutters between them
  const spans = inside.map((r) => [r.rect[0], r.rect[2]] as [number, number]).sort((a, b) => a[0] - b[0])
  const cols: [number, number][] = []
  const gutter = 6
  for (const s of spans) {
    const last = cols[cols.length - 1]
    if (last && s[0] <= last[1] + gutter) last[1] = Math.max(last[1], s[1])
    else cols.push([s[0], s[1]])
  }
  if (rows.length < 1 || cols.length < 2) return null

  const padX = 4
  const padY = 3
  let ys = [rows[0].top - padY, ...rows.slice(1).map((r, i) => (rows[i].bottom + r.top) / 2), rows[rows.length - 1].bottom + padY]

  // How is each column's text aligned? The edge between two columns hugs the text it belongs to, so that drawing the
  // text again (padded from its own edge) puts it back where it was.
  const aligns: TableCell['align'][] = cols.map((col) => {
    const mine = inside.filter((r) => (r.rect[0] + r.rect[2]) / 2 >= col[0] - 0.1 && (r.rect[0] + r.rect[2]) / 2 <= col[1] + 0.1)
    if (mine.length < 2) return 'left'
    const spread = (f: (r: TextRun) => number) => Math.max(...mine.map(f)) - Math.min(...mine.map(f))
    const l = spread((r) => r.rect[0])
    const rr = spread((r) => r.rect[2])
    const c = spread((r) => (r.rect[0] + r.rect[2]) / 2)
    if (l <= 1.5) return 'left'
    if (rr <= 1.5) return 'right'
    if (c <= 1.5) return 'center'
    return l <= rr && l <= c ? 'left' : rr <= c ? 'right' : 'center'
  })
  const lo = cols.map((col) => Math.min(...inside.filter((r) => (r.rect[0] + r.rect[2]) / 2 >= col[0] - 0.1 && (r.rect[0] + r.rect[2]) / 2 <= col[1] + 0.1).map((r) => r.rect[0])))
  const hi = cols.map((col) => Math.max(...inside.filter((r) => (r.rect[0] + r.rect[2]) / 2 >= col[0] - 0.1 && (r.rect[0] + r.rect[2]) / 2 <= col[1] + 0.1).map((r) => r.rect[2])))
  const xs = [
    lo[0] - padX,
    ...cols.slice(1).map((_, i) => {
      const j = i + 1 // the edge between column i and column j
      if (aligns[i] === 'right') return hi[i] + padX
      if (aligns[j] === 'left') return lo[j] - padX
      return (hi[i] + lo[j]) / 2
    }),
    hi[hi.length - 1] + padX,
  ]

  // ruled lines that run along the rows (a "rules only" table): snap to them and keep their look
  const bounds: Rect = [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]]
  const wide = mergeLines(g.h).filter((l) => l.b - l.a >= (bounds[2] - bounds[0]) * 0.7 && l.at >= bounds[1] - 6 && l.at <= bounds[3] + 6 && l.a <= bounds[0] + 8 + (bounds[2] - bounds[0]) * 0.15)
  let borders: TableBorders = { ...NO_BORDERS }
  if (wide.length) {
    const dom = dominant(wide)!
    ys = ys.map((y) => wide.find((l) => Math.abs(l.at - y) <= 5)?.at ?? y)
    borders = { color: dom.color, width: Math.max(0.25, dom.width), outer: wide.some((l) => Math.abs(l.at - ys[0]) <= 1.5) && wide.some((l) => Math.abs(l.at - ys[ys.length - 1]) <= 1.5), innerH: ys.length > 2 && wide.some((l) => ys.slice(1, -1).some((y) => Math.abs(l.at - y) <= 1.5)), innerV: false }
  }
  const finalBounds: Rect = [xs[0], ys[0], xs[xs.length - 1], ys[ys.length - 1]]
  const built = fillCells(xs, ys, runs, g.fills, finalBounds, borders).edit
  // one alignment per column, as the text is really set (not guessed cell by cell)
  built.model.cells.forEach((row) => row.forEach((cell, c) => (cell.align = aligns[c])))
  return built
}

// ---------------------------------------------------------------------------------- editing model

const cloneCell = (c: TableCell): TableCell => ({ ...c })
const blank = (c: TableCell): TableCell => ({ ...cloneCell(c), text: '' })
const withModel = (m: TableModel, patch: Partial<TableModel>): TableModel => ({ ...m, ...patch })

/** A new row before row `at` (`at` = rows to add at the end), styled like row `like`. */
export function insertRow(m: TableModel, at: number, like: number, height?: number): TableModel {
  const n = rowCount(m)
  const src = Math.min(Math.max(like, 0), n - 1)
  const h = height ?? Math.max(MIN_ROW, m.ys[src + 1] - m.ys[src])
  const a = Math.min(Math.max(at, 0), n)
  const ys = [...m.ys.slice(0, a + 1), m.ys[a] + h, ...m.ys.slice(a + 1).map((y) => y + h)]
  const cells = [...m.cells.slice(0, a), m.cells[src].map(blank), ...m.cells.slice(a)]
  return withModel(m, { ys, cells })
}

/** A new column before column `at`, styled like column `like`. */
export function insertColumn(m: TableModel, at: number, like: number, width?: number): TableModel {
  const n = colCount(m)
  const src = Math.min(Math.max(like, 0), n - 1)
  const w = width ?? Math.max(MIN_COL, m.xs[src + 1] - m.xs[src])
  const a = Math.min(Math.max(at, 0), n)
  const xs = [...m.xs.slice(0, a + 1), m.xs[a] + w, ...m.xs.slice(a + 1).map((x) => x + w)]
  const cells = m.cells.map((row) => [...row.slice(0, a), blank(row[src]), ...row.slice(a)])
  return withModel(m, { xs, cells })
}

/** Remove rows r0..r1 (inclusive); the rows below move up. Returns null if no row would be left. */
export function deleteRows(m: TableModel, r0: number, r1: number): TableModel | null {
  const n = rowCount(m)
  const a = Math.max(0, Math.min(r0, r1))
  const b = Math.min(n - 1, Math.max(r0, r1))
  if (b - a + 1 >= n) return null
  const dh = m.ys[b + 1] - m.ys[a]
  return withModel(m, { ys: [...m.ys.slice(0, a + 1), ...m.ys.slice(b + 2).map((y) => y - dh)], cells: [...m.cells.slice(0, a), ...m.cells.slice(b + 1)] })
}

export function deleteColumns(m: TableModel, c0: number, c1: number): TableModel | null {
  const n = colCount(m)
  const a = Math.max(0, Math.min(c0, c1))
  const b = Math.min(n - 1, Math.max(c0, c1))
  if (b - a + 1 >= n) return null
  const dw = m.xs[b + 1] - m.xs[a]
  return withModel(m, { xs: [...m.xs.slice(0, a + 1), ...m.xs.slice(b + 2).map((x) => x - dw)], cells: m.cells.map((row) => [...row.slice(0, a), ...row.slice(b + 1)]) })
}

/**
 * Drag an edge: boundary `i` of columns (`axis` 'x') or rows ('y') moves to `pos`, never closer than the minimum size
 * to its neighbours. The first and last boundary have one neighbour only, so the table grows or shrinks.
 */
export function moveBoundary(m: TableModel, axis: 'x' | 'y', i: number, pos: number): TableModel {
  const list = axis === 'x' ? m.xs : m.ys
  const min = axis === 'x' ? MIN_COL : MIN_ROW
  const lo = i > 0 ? list[i - 1] + min : 0
  const hi = i < list.length - 1 ? list[i + 1] - min : Infinity
  const v = Math.min(Math.max(pos, lo), hi)
  const next = list.map((x, j) => (j === i ? v : x))
  return withModel(m, axis === 'x' ? { xs: next } : { ys: next })
}

/** The whole table, dragged by (dx, dy). */
export function translateTable(m: TableModel, dx: number, dy: number): TableModel {
  return withModel(m, { xs: m.xs.map((x) => x + dx), ys: m.ys.map((y) => y + dy) })
}

/** If the table runs past `maxRight`, squeeze its columns (all in the same proportion) until it fits. */
export function fitWidth(m: TableModel, maxRight: number): TableModel {
  const left = m.xs[0]
  const right = m.xs[m.xs.length - 1]
  if (right <= maxRight || right <= left) return m
  const k = Math.max(0.2, (maxRight - left) / (right - left))
  return withModel(m, { xs: m.xs.map((x) => left + (x - left) * k) })
}

/** Make all columns the same width, keeping the table's overall width. */
export function distributeColumns(m: TableModel): TableModel {
  const n = colCount(m)
  const w = (m.xs[n] - m.xs[0]) / n
  return withModel(m, { xs: m.xs.map((_, i) => m.xs[0] + w * i) })
}

export interface CellRange {
  r0: number
  r1: number
  c0: number
  c1: number
}
export const normRange = (a: [number, number], b: [number, number]): CellRange => ({ r0: Math.min(a[0], b[0]), r1: Math.max(a[0], b[0]), c0: Math.min(a[1], b[1]), c1: Math.max(a[1], b[1]) })

export function mapCells(m: TableModel, range: CellRange, fn: (c: TableCell, r: number, col: number) => TableCell): TableModel {
  return withModel(m, { cells: m.cells.map((row, r) => row.map((c, col) => (r >= range.r0 && r <= range.r1 && col >= range.c0 && col <= range.c1 ? fn(c, r, col) : c))) })
}

export const setBorders = (m: TableModel, patch: Partial<TableBorders>): TableModel => withModel(m, { borders: { ...m.borders, ...patch } })

/** Stripe the body rows (every second one from `first`) in `color`; null clears the stripes. */
export function zebra(m: TableModel, color: Rgb | null, first = 1): TableModel {
  return withModel(m, { cells: m.cells.map((row, r) => (r < first ? row : row.map((c) => ({ ...c, fill: (r - first) % 2 === 1 ? color : null })))) })
}
