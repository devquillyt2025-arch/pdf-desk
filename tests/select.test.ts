import assert from 'node:assert/strict'
import { test } from 'node:test'
import { overlayBounds } from '../src/engine/overlay.ts'
import { tableBounds } from '../src/engine/table.ts'
import type { Edit, FontStyle, Overlay, TableCell, TextRun } from '../src/engine/types.ts'
import { allKeysOnPage, clampMove, editMarkRect, insideEditedTable, isDeletable, itemRect, moveItems, moveRunIn, resolveSelection, unionRect } from '../src/ui/select.ts'
import { emptySnapshot, type Snapshot } from '../src/ui/store.ts'
import { selId, type SelKey } from '../src/ui/types.ts'

const style: FontStyle = { family: 'sans', bold: false, italic: false, size: 12, color: [0, 0, 0] }
const run = (id: string, x = 50, y = 100, page = 0): TextRun => ({ id, page, source: 'pdf', text: `line ${id}`, rect: [x, y - 10, x + 80, y + 3], x, baseline: y, xs: [], size: 12, fontName: 'Helvetica', style, hidden: false })
const rect: Overlay = { type: 'rect', rect: [10, 10, 60, 40], stroke: [0, 0, 0], fill: null, width: 1, opacity: 1 }
const overlayEdit = (id: string, o: Overlay = rect, page = 0): Edit => ({ id, page, kind: 'overlay', text: '', style, overlay: o })
const added = (id: string, page = 0): Edit => ({ id, page, kind: 'add', text: 'new text', style, x: 30, baseline: 200 })
const cell: TableCell = { text: 'a', fill: null, color: [0, 0, 0], family: 'sans', bold: false, italic: false, size: 10, align: 'left' }
const table = (id: string, page = 0, deleted = false): Edit => ({
  id,
  page,
  kind: 'table',
  text: '',
  style,
  table: { model: { xs: [100, 200, 300], ys: [300, 320, 340], cells: [[cell, cell], [cell, cell]], borders: { color: [0, 0, 0], width: 0.5, outer: true, innerH: true, innerV: true } }, clear: [[95, 295, 305, 345]], deleted },
})
const shift = (r: [number, number, number, number], dx: number, dy: number): [number, number, number, number] => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
const snap = (edits: Edit[], more: Partial<Snapshot> = {}): Snapshot => ({ ...emptySnapshot(), edits, ...more })
const key = (kind: SelKey['kind'], id: string, page = 0): SelKey => ({ kind, id, page })
const pageRuns = (runs: TextRun[]) => (page: number) => runs.filter((r) => r.page === page)

test('"select all, then move" moves every kind of thing by the same amount, in one new snapshot', () => {
  const r1 = run('r1')
  const s0 = snap([overlayEdit('o1'), added('a1'), table('t1')])
  const all = allKeysOnPage(s0, 0, pageRuns([r1]))
  assert.deepEqual(all.map(selId).sort(), ['edit:a1', 'overlay:o1', 'run:r1', 'table:t1'])

  const s1 = moveItems(s0, all, pageRuns([r1]), 15, -8)
  assert.notEqual(s1, s0)
  const by = (id: string) => s1.edits.find((e) => e.id === id)!
  assert.deepEqual(overlayBounds(by('o1').overlay!), shift(overlayBounds(rect), 15, -8), 'the shape moved')
  assert.deepEqual([by('a1').x, by('a1').baseline], [45, 192], 'the added text moved')
  assert.deepEqual(tableBounds(by('t1').table!.model), [115, 292, 315, 332], 'the table moved')
  assert.deepEqual(by('t1').table!.clear, [[95, 295, 305, 345]], 'its old place is still what gets cleared')
  const moved = s1.edits.find((e) => e.kind === 'replace')!
  assert.deepEqual(moved.move, [15, -8], 'a line of the page’s own text becomes an edit that carries the move')
  assert.equal(moved.run!.id, 'r1')
  assert.equal(s1.edits.length, 4)
  assert.deepEqual(s0.edits.map((e) => e.id), ['o1', 'a1', 't1'], 'the old snapshot is untouched (undo)')
})

test('moving by nothing returns the very same snapshot', () => {
  const s = snap([overlayEdit('o1')])
  assert.equal(moveItems(s, [key('overlay', 'o1')], pageRuns([]), 0, 0), s)
})

test('a line moved twice adds up; moved back to where it was, the edit goes away', () => {
  const r = run('r1')
  let s = moveRunIn(snap([]), r, 10, 5)
  s = moveRunIn(s, r, 5, 5)
  assert.equal(s.edits.length, 1)
  assert.deepEqual(s.edits[0].move, [15, 10])
  assert.deepEqual(editMarkRect(s.edits[0]), [65, 100, 145, 113], 'the box follows the line')
  s = moveRunIn(s, r, -15, -10)
  assert.equal(s.edits.length, 0, 'nothing left to save')
})

test('a moved line keeps the text you changed in it', () => {
  const r = run('r1')
  const edited: Edit = { id: 'e1', page: 0, kind: 'replace', run: r, text: 'changed words', style }
  const s = moveItems(snap([edited]), [key('edit', 'e1')], pageRuns([r]), 4, 0)
  assert.equal(s.edits[0].text, 'changed words')
  assert.deepEqual(s.edits[0].move, [4, 0])
})

test('things that are not in the selection stay where they are', () => {
  const s0 = snap([overlayEdit('o1'), overlayEdit('o2', { ...rect, rect: [100, 100, 130, 130] })])
  const s1 = moveItems(s0, [key('overlay', 'o2')], pageRuns([]), 10, 10)
  assert.equal(s1.edits[0], s0.edits[0], 'the other shape is the same object')
  assert.deepEqual(overlayBounds(s1.edits[1].overlay!), shift(overlayBounds({ ...rect, rect: [100, 100, 130, 130] }), 10, 10))
})

test('a selection follows a line to its edit once it has been moved, and drops what is gone', () => {
  const r = run('r1')
  const runsOf = pageRuns([r])
  const picked = [key('run', 'r1'), key('overlay', 'o1'), key('overlay', 'ghost'), key('run', 'missing')]
  const before = resolveSelection(picked, snap([overlayEdit('o1')]), runsOf)
  assert.deepEqual(before.map(selId), ['run:r1', 'overlay:o1'])

  const moved = moveRunIn(snap([overlayEdit('o1')]), r, 10, 0)
  const after = resolveSelection(picked, moved, runsOf)
  assert.deepEqual(after.map(selId), [`edit:${moved.edits.find((e) => e.kind === 'replace')!.id}`, 'overlay:o1'])

  const twice = resolveSelection([...picked, ...after], moved, runsOf)
  assert.equal(twice.length, 2, 'the run and its edit are one thing, not two')
})

test('a deleted table or an erased area is not selectable; edits of other kinds cannot be picked as another kind', () => {
  const s = snap([table('t1', 0, true), { id: 'x1', page: 0, kind: 'erase', text: '', style, rect: [0, 0, 20, 20] }, added('a1')])
  assert.deepEqual(allKeysOnPage(s, 0, pageRuns([])).map(selId), ['edit:a1'])
  assert.deepEqual(resolveSelection([key('table', 't1'), key('overlay', 'a1'), key('edit', 'x1'), key('edit', 'a1')], s, pageRuns([])).map(selId), ['edit:a1'])
})

test('select all takes one page only, and skips lines that already have an edit', () => {
  const r1 = run('r1')
  const r2 = run('r2', 50, 130)
  const other = run('r9', 50, 100, 1)
  const edit: Edit = { id: 'e1', page: 0, kind: 'replace', run: r1, text: 'x', style }
  const s = snap([edit, overlayEdit('o1'), overlayEdit('o2', rect, 1)])
  const keys = allKeysOnPage(s, 0, pageRuns([r1, r2, other]))
  assert.deepEqual(keys.map(selId).sort(), ['edit:e1', 'overlay:o1', 'run:r2'])
  assert.ok(keys.every((k) => k.page === 0))
})

test('boxes: where each thing is, and how far a group may move before it leaves the page', () => {
  const r = run('r1')
  const s = snap([overlayEdit('o1'), added('a1'), table('t1')])
  assert.deepEqual(itemRect(s, key('run', 'r1'), pageRuns([r])), r.rect)
  assert.deepEqual(itemRect(s, key('overlay', 'o1'), pageRuns([])), overlayBounds(rect))
  assert.deepEqual(itemRect(s, key('table', 't1'), pageRuns([])), [100, 300, 300, 340])
  assert.equal(itemRect(s, key('overlay', 'nope'), pageRuns([])), null)

  const box = unionRect([[10, 10, 60, 40], [100, 300, 300, 340]])
  assert.deepEqual(box, [10, 10, 300, 340])
  const page = { width: 595, height: 842 }
  assert.deepEqual(clampMove(box, -50, -50, page), [-10, -10], 'stops at the top-left corner of the page')
  assert.deepEqual(clampMove(box, 400, 900, page), [295, 502], 'stops at the bottom-right')
  assert.deepEqual(clampMove(box, 20, 30, page), [20, 30], 'free movement is left alone')
})

test('page text inside a table you edited is part of that table, not a separate thing to pick', () => {
  const inside = run('in', 110, 315) // within the table's old box [95,295,305,345]
  const outside = run('out', 110, 400)
  const s = snap([table('t1')])
  const runsOf = pageRuns([inside, outside])
  assert.deepEqual(allKeysOnPage(s, 0, runsOf).map(selId).sort(), ['run:out', 'table:t1'])
  assert.deepEqual(resolveSelection([key('run', 'in'), key('run', 'out'), key('table', 't1')], s, runsOf).map(selId).sort(), ['run:out', 'table:t1'])
  assert.equal(insideEditedTable(inside.rect, 0, s.edits), true)
  assert.equal(insideEditedTable(inside.rect, 1, s.edits), false, 'only on the same page')
  assert.equal(insideEditedTable(outside.rect, 0, s.edits), false)
  assert.equal(insideEditedTable(inside.rect, 0, snap([]).edits), false, 'with no table edit, the text is free')
})

test('Delete only removes what you added yourself', () => {
  const s = snap([overlayEdit('o1'), added('a1'), { id: 'e1', page: 0, kind: 'replace', run: run('r1'), text: 'x', style }, table('t1')])
  assert.equal(isDeletable(s, key('overlay', 'o1')), true)
  assert.equal(isDeletable(s, key('edit', 'a1')), true)
  assert.equal(isDeletable(s, key('edit', 'e1')), false, 'the page’s own text is changed with Erase, not Delete')
  assert.equal(isDeletable(s, key('table', 't1')), false)
  assert.equal(isDeletable(s, key('run', 'r1')), false)
})
