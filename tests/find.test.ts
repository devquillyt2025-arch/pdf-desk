import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfEngine } from '../src/engine/engine.ts'
import { findAll, findMatches, replaceIn } from '../src/engine/find.ts'
import type { Edit } from '../src/engine/types.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const CASE = { matchCase: false, wholeWord: false }

describe('find in a line of text', () => {
  test('finds every non-overlapping match, ignoring case by default', () => {
    assert.deepEqual(findAll('Unit unit UNIT', 'unit', CASE), [0, 5, 10])
    assert.deepEqual(findAll('aaaa', 'aa', CASE), [0, 2])
    assert.deepEqual(findAll('Unit unit UNIT', 'unit', { matchCase: true, wholeWord: false }), [5])
  })
  test('whole word only', () => {
    const o = { matchCase: false, wholeWord: true }
    assert.deepEqual(findAll('cat concat cat. cats', 'cat', o), [0, 11])
    assert.deepEqual(findAll('₹ 50,000.00', '50', o), [2])
    assert.deepEqual(findAll('x_cat cat', 'cat', o), [6], '_ and digits count as part of a word')
  })
  test('nothing for an empty query; special characters are literal', () => {
    assert.deepEqual(findAll('abc', '', CASE), [])
    assert.deepEqual(findAll('a.c abc (x)', '.', CASE), [1])
    assert.deepEqual(findAll('a.c abc (x)', '(x)', CASE), [8])
  })
  test('replace all, or just one match', () => {
    assert.equal(replaceIn('ab ab ab', 'ab', 'X', CASE), 'X X X')
    assert.equal(replaceIn('ab ab ab', 'ab', 'X', CASE, 1), 'ab X ab')
    assert.equal(replaceIn('ab ab', 'ab', '', CASE), ' ')
    assert.equal(replaceIn('no match', 'zz', 'X', CASE), 'no match')
    assert.equal(replaceIn('Cost: ₹ 5', '₹', 'Rs.', CASE), 'Cost: Rs. 5')
  })
  test('replacement text containing the query does not loop or re-match', () => {
    assert.equal(replaceIn('a a', 'a', 'aa', CASE), 'aa aa')
  })
})

describe('find across a real page and replace through the engine', () => {
  const eng = new PdfEngine(loader)
  eng.open(new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/invoice-text.pdf'))))
  const runs = eng.getRuns(0)

  test('matches carry a box that sits exactly on the matched characters', () => {
    const ms = findMatches(runs, (r) => r.text, 'battery', CASE)
    assert.equal(ms.length, 1)
    const m = ms[0]
    assert.equal(m.hit, 'battery')
    assert.ok(m.rect[2] - m.rect[0] > 20 && m.rect[2] - m.rect[0] < 80)
    assert.ok(m.before.endsWith('Lithium ') && m.after.startsWith(' pack'))
  })

  test('a run whose text was changed is matched on its new text, with the whole run boxed', () => {
    const run = runs.find((r) => r.text === 'Charger unit (fast)')!
    const ms = findMatches([run], () => 'Charger unit (FAST) fast', 'fast', CASE)
    assert.equal(ms.length, 2)
    assert.deepEqual(ms[0].rect, run.rect)
  })

  test('replace all matches in the file: only those words change, and the export verifies', async () => {
    const hits = findMatches(runs, (r) => r.text, 'unit', CASE)
    assert.ok(hits.length >= 1)
    const edits: Edit[] = hits.map((m, i) => ({ id: `r${i}`, page: 0, kind: 'replace', run: m.run, text: replaceIn(m.run.text, 'unit', 'piece', CASE), style: m.run.style }))
    const { bytes, report } = await eng.export(edits, [], { textLayer: true, jpegQuality: 88 })
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const text = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText()
    // (redrawn words are appended to the page, so compare words, not their order — see README "Known limits")
    const words = text.split(/\s+/)
    assert.ok(words.includes('Charger') && words.includes('piece'), 'the new word is there')
    assert.ok(!words.includes('unit'), 'the old word is really gone, not covered')
    assert.ok(text.includes('Lithium battery pack'), 'unrelated lines are untouched')
  })
})
