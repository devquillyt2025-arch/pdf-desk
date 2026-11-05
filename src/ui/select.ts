import { moveOverlay, overlayBounds } from '../engine/overlay.ts'
import { sameStyle } from '../engine/plan.ts'
import { tableBounds, translateTable } from '../engine/table.ts'
import type { Edit, PageSize, Rect, TextRun } from '../engine/types.ts'
import { withText } from '../ocr/ocr.ts'
import { pictureEditFor, removeEdit, uid, updateOverlayEdit, upsertEdit, type Snapshot } from './store.ts'
import { selId, type SelKey } from './types.ts'

// The Select tool: what can be picked, and what moving a pick does. All pure — the page view only decides *which*
// things, and by how much; this module turns that into one new snapshot, so a whole selection is a single undo step.

/** A line of a scanned page (recognised text) rather than the PDF's own text. */
export const isScanRun = (run: TextRun) => run.source === 'ocr' || run.hidden

/** Where the box of edited, moved or added text is (page pt). */
export function editMarkRect(e: Edit): Rect {
  if (e.kind === 'erase') return e.rect!
  if (e.kind === 'replace') {
    const [dx, dy] = e.move ?? [0, 0]
    const r = e.run!.rect
    return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
  }
  const size = e.style.size
  return [e.x!, e.baseline! - size, e.x! + Math.max(size, e.text.length * size * 0.55), e.baseline! + size * 0.3]
}

export const unionRect = (rs: Rect[]): Rect => rs.reduce<Rect>((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity])

/** Keep `rect`, moved by (dx, dy), on the page: the (dx, dy) that is allowed. */
export function clampMove(rect: Rect, dx: number, dy: number, page: Pick<PageSize, 'width' | 'height'>): [number, number] {
  return [Math.min(Math.max(dx, -rect[0]), page.width - rect[2]), Math.min(Math.max(dy, -rect[1]), page.height - rect[3])]
}

/**
 * Page text inside a table you edited belongs to that table now (it is cleared and redrawn with it), so it is not
 * picked up on its own — moving it separately would fight the redrawn table.
 */
export function insideEditedTable(r: Rect, page: number, edits: readonly Edit[]): boolean {
  const cx = (r[0] + r[2]) / 2
  const cy = (r[1] + r[3]) / 2
  return edits.some((e) => e.kind === 'table' && e.page === page && e.table?.clear.some((z) => cx >= z[0] && cx <= z[2] && cy >= z[1] && cy <= z[3]))
}

export const rectsTouch = (a: Rect, b: Rect) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]

// -------------------------------------------------------------------------------------------- moving

/** A line of the page's own text, dragged: it becomes (or updates) a "replace" edit carrying the move. */
export function moveRunIn(s: Snapshot, run: TextRun, dx: number, dy: number): Snapshot {
  const existing = pictureEditFor(s.edits, run.id)
  const base = isScanRun(run) ? withText(run, s.corrections[run.id] ?? run.text) : run
  const mv: [number, number] = [(existing?.move?.[0] ?? 0) + dx, (existing?.move?.[1] ?? 0) + dy]
  const back = Math.abs(mv[0]) < 0.05 && Math.abs(mv[1]) < 0.05 // dragged back to where it was
  const text = existing?.text ?? base.text
  const style = existing?.style ?? run.style
  if (back && text === base.text && sameStyle(style, base.style)) return existing ? removeEdit(existing.id)(s) : s
  return upsertEdit({ id: existing?.id ?? uid(), page: run.page, kind: 'replace', run: existing?.run ?? base, text, style, keepPrefix: existing?.keepPrefix, ...(back ? {} : { move: mv }) })(s)
}

/** Text you edited or added, dragged. */
export function moveEditIn(s: Snapshot, id: string, dx: number, dy: number): Snapshot {
  const e = s.edits.find((x) => x.id === id)
  if (!e) return s
  if (e.kind === 'add') return upsertEdit({ ...e, x: (e.x ?? 0) + dx, baseline: (e.baseline ?? 0) + dy })(s)
  if (e.kind !== 'replace') return s
  const mv: [number, number] = [(e.move?.[0] ?? 0) + dx, (e.move?.[1] ?? 0) + dy]
  const back = Math.abs(mv[0]) < 0.05 && Math.abs(mv[1]) < 0.05
  if (back && e.text === e.run!.text && sameStyle(e.style, e.run!.style)) return removeEdit(e.id)(s)
  const { move: _old, ...rest } = e
  return upsertEdit(back ? rest : { ...rest, move: mv })(s)
}

/** A table you edited, dragged (rows, columns and text keep their shape; only the position changes). */
export function moveTableIn(s: Snapshot, id: string, dx: number, dy: number): Snapshot {
  const e = s.edits.find((x) => x.id === id && x.kind === 'table' && x.table)
  if (!e) return s
  return upsertEdit({ ...e, table: { ...e.table!, model: translateTable(e.table!.model, dx, dy) } })(s)
}

/** Move every picked thing by the same amount. Returns `s` itself when there is nothing to do. */
export function moveItems(s: Snapshot, keys: SelKey[], runsOf: (page: number) => TextRun[], dx: number, dy: number): Snapshot {
  if (!dx && !dy) return s
  return keys.reduce((acc, k) => {
    if (k.kind === 'overlay') {
      const e = acc.edits.find((x) => x.id === k.id && x.kind === 'overlay' && x.overlay)
      return e ? updateOverlayEdit(e.id, moveOverlay(e.overlay!, dx, dy))(acc) : acc
    }
    if (k.kind === 'edit') return moveEditIn(acc, k.id, dx, dy)
    if (k.kind === 'table') return moveTableIn(acc, k.id, dx, dy)
    const run = runsOf(k.page).find((r) => r.id === k.id)
    return run ? moveRunIn(acc, run, dx, dy) : acc
  }, s)
}

// ----------------------------------------------------------------------------------------- selecting

/** The box of a picked thing on the page, or null if it no longer exists. */
export function itemRect(s: Snapshot, k: SelKey, runsOf: (page: number) => TextRun[]): Rect | null {
  if (k.kind === 'run') return runsOf(k.page).find((r) => r.id === k.id)?.rect ?? null
  const e = s.edits.find((x) => x.id === k.id)
  if (!e) return null
  if (k.kind === 'overlay') return e.overlay ? overlayBounds(e.overlay) : null
  if (k.kind === 'table') return e.table ? tableBounds(e.table.model) : null
  return editMarkRect(e)
}

/**
 * A selection can outlive what it points at (undo, delete) and a line of page text stops being "untouched" the moment
 * it is moved. This keeps what still exists, follows a moved line to its edit, and drops duplicates.
 */
export function resolveSelection(keys: readonly SelKey[], s: Snapshot, runsOf: (page: number) => TextRun[]): SelKey[] {
  const out = new Map<string, SelKey>()
  for (const k of keys) {
    let key = k
    if (k.kind === 'run') {
      const e = pictureEditFor(s.edits, k.id)
      if (e) key = { kind: 'edit', id: e.id, page: k.page }
      else {
        const r = runsOf(k.page).find((x) => x.id === k.id)
        if (!r || insideEditedTable(r.rect, k.page, s.edits)) continue
      }
    } else {
      const e = s.edits.find((x) => x.id === k.id)
      if (!e) continue
      if (k.kind === 'overlay' && !(e.kind === 'overlay' && e.overlay)) continue
      if (k.kind === 'table' && !(e.kind === 'table' && e.table && !e.table.deleted)) continue
      if (k.kind === 'edit' && e.kind !== 'replace' && e.kind !== 'add') continue
    }
    out.set(selId(key), key)
  }
  return [...out.values()]
}

/** Everything on a page the Select tool can move. */
export function allKeysOnPage(s: Snapshot, page: number, runsOf: (page: number) => TextRun[]): SelKey[] {
  const covered = new Set(s.edits.filter((e) => e.kind === 'replace' && e.run).map((e) => e.run!.id))
  const keys: SelKey[] = runsOf(page)
    .filter((r) => !covered.has(r.id) && !insideEditedTable(r.rect, page, s.edits))
    .map((r) => ({ kind: 'run' as const, id: r.id, page }))
  for (const e of s.edits) {
    if (e.page !== page) continue
    if (e.kind === 'overlay' && e.overlay) keys.push({ kind: 'overlay', id: e.id, page })
    else if ((e.kind === 'replace' && e.run) || e.kind === 'add') keys.push({ kind: 'edit', id: e.id, page })
    else if (e.kind === 'table' && e.table && !e.table.deleted) keys.push({ kind: 'table', id: e.id, page })
  }
  return keys
}

/** What Delete may remove: the things you added yourself (marks, shapes, pictures, text you typed in). */
export const isDeletable = (s: Snapshot, k: SelKey): boolean => k.kind === 'overlay' || (k.kind === 'edit' && s.edits.find((e) => e.id === k.id)?.kind === 'add')
