import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDraft, draftEditCount, encodeDraft, imagesUsedBy, parseDraft, summarizeEdits, toRestore } from '../src/cloud/draft.ts'
import type { Edit, TextRun } from '../src/engine/types.ts'
import type { Snapshot } from '../src/ui/store.ts'

const style = { family: 'sans', bold: false, italic: false, size: 12, color: [0, 0, 0] } as Edit['style']
const run = (id: string, page = 0, words = true): TextRun =>
  ({ id, page, text: 'hello world', x: 10, baseline: 20, rect: [10, 8, 90, 24], size: 12, style, source: 'ocr', ...(words ? { words: [{ text: 'hello', x0: 10, x1: 40 }] } : {}) }) as unknown as TextRun
const text = (id: string, page = 0): Edit => ({ id, page, kind: 'add', text: 'hi', style, x: 5, baseline: 9 })
const picture = (id: string, imageId: string, page = 0): Edit => ({ id, page, kind: 'overlay', text: '', style, overlay: { type: 'image', rect: [0, 0, 10, 10], imageId, opacity: 1 } })
const snap = (edits: Edit[], corrections: Record<string, string> = {}): Snapshot => ({ edits, corrections, verified: {} })

test('a draft survives the trip to JSON and back, with the recognised text of scanned pages', () => {
  const s = snap([text('a'), picture('b', 'img1')], { r1: 'fixed' })
  const d = buildDraft(s, { 2: { lang: 'eng', ms: 900 } }, { 0: [run('x')], 2: [run('r1', 2)] }, { img1: { documentId: 'doc-1', width: 4, height: 3, type: 'image/png' } })
  assert.deepEqual(Object.keys(d.ocrRuns), ['2'], 'only pages that were recognised keep their lines (the others come from the PDF itself)')
  const back = parseDraft(JSON.parse(encodeDraft(d)!.json))!
  assert.deepEqual(back, d)
  assert.equal(draftEditCount(s), 3, 'two edits and one correction')
})

test('anything that is not a draft we wrote is "no draft"', () => {
  for (const bad of [null, undefined, 'x', 3, {}, { v: 2, snapshot: { edits: [] } }, { v: 1 }, { v: 1, snapshot: { edits: 'no' } }]) assert.equal(parseDraft(bad), null)
  const ok = parseDraft({ v: 1, snapshot: { edits: [] } })!
  assert.deepEqual(ok.snapshot, { edits: [], corrections: {}, verified: {} }, 'missing parts get empty defaults')
  assert.deepEqual([ok.ocr, ok.ocrRuns, ok.images], [{}, {}, {}])
})

test('a draft that is too big first drops word boxes, and is refused only if it is still too big', () => {
  const many = Array.from({ length: 60 }, (_, i) => run(`r${i}`))
  const d = buildDraft(snap([]), { 0: { lang: 'eng', ms: 1 } }, { 0: many }, {})
  const full = encodeDraft(d, 1e9)!
  assert.ok(full.draft.ocrRuns[0].every((r) => r.words))
  const limit = full.json.length - 200
  const lean = encodeDraft(d, limit)!
  assert.ok(lean.json.length <= limit, 'fits now')
  assert.ok(lean.draft.ocrRuns[0].every((r) => !r.words), 'the word boxes went, the lines stayed')
  assert.equal(lean.draft.ocrRuns[0].length, 60)
  assert.equal(encodeDraft(d, 50), null, 'nothing left to drop: refuse rather than send something broken')
})

test('the size limit counts bytes on the wire, not characters (Tamil text takes three bytes a letter)', () => {
  const tamil = { ...run('t1', 0, false), text: 'த'.repeat(2000) }
  const d = buildDraft(snap([]), { 0: { lang: 'tam', ms: 1 } }, { 0: [tamil] }, {})
  const chars = JSON.stringify(d).length
  assert.ok(encodeDraft(d, chars * 3), 'a limit above its size in bytes accepts it')
  assert.equal(encodeDraft(d, chars + 100), null, 'a limit that only the character count would meet is refused: the bytes are over it')
})

test('only the pictures the edits still use are listed', () => {
  assert.deepEqual(imagesUsedBy([text('a'), picture('b', 'i1'), picture('c', 'i1'), picture('d', 'i2')]).sort(), ['i1', 'i2'])
  assert.deepEqual(imagesUsedBy([text('a')]), [])
})

test('restoring leaves out marks whose picture is gone and pages the file no longer has', () => {
  const d = buildDraft(snap([text('a'), picture('b', 'gone'), picture('c', 'kept'), text('far', 9)]), { 0: { lang: 'eng', ms: 1 }, 9: { lang: 'eng', ms: 1 } }, { 0: [run('x')], 9: [run('y', 9)] }, {})
  const r = toRestore(d, new Set(['gone']), 3)
  assert.deepEqual(r.snapshot.edits.map((e) => e.id), ['a', 'c'])
  assert.deepEqual(Object.keys(r.ocr), ['0'])
  assert.deepEqual(Object.keys(r.ocrRuns), ['0'])
  assert.equal(toRestore(d).snapshot.edits.length, 4, 'with nothing missing, everything comes back')
})

test('the save history counts edits per kind, and corrections apart', () => {
  assert.deepEqual(summarizeEdits(snap([text('a'), text('b'), picture('c', 'i')], { r: 'x', q: 'y' })), { add: 2, overlay: 1, corrections: 2 })
  assert.deepEqual(summarizeEdits(snap([])), {})
})
