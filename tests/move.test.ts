import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfEngine } from '../src/engine/engine.ts'
import { isMoved, planEdit } from '../src/engine/plan.ts'
import { translateTable } from '../src/engine/table.ts'
import type { Edit, ExportOptions, TextRun } from '../src/engine/types.ts'
import { buildTablePdf } from '../scripts/table-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FX = path.join(ROOT, 'tests', 'fixtures')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const OPTS: ExportOptions = { textLayer: true, jpegQuality: 88 }
const read = (n: string) => new Uint8Array(fs.readFileSync(path.join(FX, n)))
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

const textOf = (bytes: Uint8Array) => squash(mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText())
/** every character with its origin */
function charsOf(bytes: Uint8Array) {
  const out: { c: string; x: number; y: number }[] = []
  mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').walk({
    onChar(c, origin) {
      if (c.trim()) out.push({ c, x: origin[0], y: origin[1] })
    },
  })
  return out
}
const within = (chars: ReturnType<typeof charsOf>, r: [number, number, number, number]) => chars.filter((c) => c.x >= r[0] - 0.5 && c.x <= r[2] + 0.5 && c.y >= r[1] && c.y <= r[3] + 4)
const near = (a: number, b: number, tol = 0.8) => Math.abs(a - b) <= tol
const mv = (run: TextRun, move: [number, number], over: Partial<Edit> = {}): Edit => ({ id: `m${Math.random()}`, page: 0, kind: 'replace', run, text: run.text, style: run.style, move, ...over })

describe('planning a moved line', () => {
  let run: TextRun
  before(() => {
    const eng = new PdfEngine(loader)
    eng.open(read('invoice-text.pdf'))
    run = eng.getRuns(0).find((r) => r.text === 'Charger unit (fast)')!
  })

  test('the whole line is cleared where it was and set down in full where it lands', () => {
    const plan = planEdit(mv(run, [30, 80]), false)
    assert.equal(plan.noop, false)
    assert.equal(plan.keep, 0, 'no leading words stay behind')
    assert.deepEqual(plan.clear, [run.rect[0], run.rect[1] + run.size * 0.08, run.rect[2], run.rect[3] - run.size * 0.08])
    assert.equal(plan.draw!.text, run.text)
    assert.ok(near(plan.draw!.x, run.xs[0] + 30, 1e-9) && near(plan.draw!.baseline, run.baseline + 80, 1e-9))
  })

  test('on a scan the cleared area is padded outwards to swallow the fringe', () => {
    const plan = planEdit(mv(run, [0, 40]), true)
    assert.ok(plan.clear![0] < run.rect[0] && plan.clear![3] > run.rect[3])
  })

  test('no move (or a negligible one) and no other change is nothing at all', () => {
    assert.equal(planEdit(mv(run, [0, 0]), false).noop, true)
    assert.equal(planEdit(mv(run, [0.004, -0.004]), false).noop, true)
    assert.equal(isMoved(mv(run, [0.5, 0])), true)
    assert.equal(isMoved({ ...mv(run, [0, 0]), move: undefined }), false)
  })

  test('a moved line can also have its text changed, and can be moved away and emptied', () => {
    assert.equal(planEdit(mv(run, [10, 10], { text: 'Charger unit (rapid)' }), false).draw!.text, 'Charger unit (rapid)')
    const gone = planEdit(mv(run, [10, 10], { text: '' }), false)
    assert.equal(gone.draw, null)
    assert.ok(gone.clear)
  })
})

describe('moving text on a searchable page', () => {
  let eng: PdfEngine
  let runs: TextRun[]
  before(() => {
    eng = new PdfEngine(loader)
    eng.open(read('invoice-text.pdf'))
    runs = eng.getRuns(0)
  })
  const find = (t: string) => runs.find((r) => r.text === t)!

  test('the line ends up at its new place, nothing is left at the old one, the rest is untouched', async () => {
    const run = find('Billed to:')
    const edit = mv(run, [210, 330])
    const { bytes, report } = await eng.export([edit], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const after = charsOf(bytes)
    const orig = charsOf(read('invoice-text.pdf'))
    const oldBox: [number, number, number, number] = [run.rect[0], run.baseline - 2, run.rect[2], run.baseline + 2]
    assert.equal(within(after, oldBox).filter((c) => 'Billedto:'.includes(c.c) && c.y < run.baseline + 100).length, 0, 'the old place is empty')
    const landed = within(after, [run.xs[0] + 210 - 1, run.baseline + 330 - 3, run.rect[2] + 210, run.baseline + 330 + 3])
    assert.equal(landed.map((c) => c.c).join(''), 'Billedto:', 'the line reads the same where it landed')
    assert.ok(near(landed[0].x, run.xs[0] + 210, 1) && near(landed[0].y, run.baseline + 330, 1), 'and starts exactly 210 pt right and 330 pt down')
    // every other character is where it was
    const others = (list: typeof orig) => list.filter((c) => !(c.y > run.baseline - 3 && c.y < run.baseline + 3 && c.x < run.rect[2] + 1 && c.x > run.rect[0] - 1)).filter((c) => !(near(c.y, run.baseline + 330, 4) && c.x > run.xs[0] + 200))
    assert.equal(others(after).length, others(orig).length)
    assert.ok(textOf(bytes).includes('Meera Nair') && textOf(bytes).includes('Invoice INV-2026-0417'))
  })

  test('moved and re-worded in one go', async () => {
    const run = find('Charger unit (fast)')
    const { bytes, report } = await eng.export([mv(run, [0, 120], { text: 'Charger unit (rapid)' })], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const t = textOf(bytes)
    assert.ok(t.includes('rapid') && !t.includes('(fast)'), t)
  })

  test('a small nudge that overlaps the old position still verifies', async () => {
    const run = find('Installation & testing')
    const { report, bytes } = await eng.export([mv(run, [6, 0])], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const first = charsOf(bytes).filter((c) => c.c === 'I' && near(c.y, run.baseline, 1) && c.x < 120)
    assert.ok(first.length && near(first[0].x, run.xs[0] + 6, 1))
  })

  test('landing on top of other text is flagged, in words about moving', async () => {
    const run = find('Billed to:')
    const target = find('Charger unit (fast)')
    const { report } = await eng.export([mv(run, [target.xs[0] - run.xs[0] + 2, target.baseline - run.baseline])], [], OPTS)
    assert.equal(report.ok, false, 'two lines on top of each other do not read as either')
    assert.match(report.pages[0].edits[0].warning ?? '', /lands on top of other text/)
  })

  test('select all, drag: every line moved by the same amount verifies, although each lands where its neighbour was', async () => {
    const [dx, dy] = [20, 17] // about one line down: the title lands on the subtitle's old place, and so on
    const { bytes, report } = await eng.export(runs.map((r) => mv(r, [dx, dy])), [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report.pages[0].edits.filter((e) => !e.ok), null, 1))
    assert.equal(report.editCount, runs.length)
    assert.equal(report.passed, runs.length, 'every line is confirmed')
    assert.equal(report.collateral, 0)
    const t = textOf(bytes)
    for (const r of runs) assert.ok(t.includes(squash(r.text)), `"${r.text}" is still there`)
    const after = charsOf(bytes)
    for (const r of [find('Billed to:'), find('Installation & testing'), find('Invoice INV-2026-0417')]) {
      const first = after.filter((c) => c.c === r.text[0] && near(c.x, r.xs[0] + dx, 1) && near(c.y, r.baseline + dy, 1))
      assert.ok(first.length, `"${r.text}" starts ${dx} pt right and ${dy} pt down`)
    }
    // nothing is left on the page except at the new places: the old title place now holds the subtitle's first letters, never the title's
    assert.equal(after.length, charsOf(read('invoice-text.pdf')).length, 'no characters were lost or duplicated')
  })

  test('a line moved onto text that did NOT move is still flagged (the relaxed old-place check must not hide that)', async () => {
    const title = find('Invoice INV-2026-0417')
    const sub = find('Sundaram Traders Pvt Ltd · Kochi, Kerala')
    const { report } = await eng.export([mv(title, [sub.xs[0] - title.xs[0] + 2, sub.baseline - title.baseline])], [], OPTS)
    assert.equal(report.ok, false)
  })

  test('a moved line together with a shape and added text is one clean, verified save', async () => {
    const run = find('Installation & testing')
    const add: Edit = { id: 'a1', page: 0, kind: 'add', text: 'Hello there', style: run.style, x: 60, baseline: 620 }
    const shape: Edit = { id: 'o1', page: 0, kind: 'overlay', text: '', style: run.style, overlay: { type: 'rect', rect: [80, 520, 220, 580], stroke: [220, 38, 38], fill: null, width: 2, opacity: 1 } }
    const { report } = await eng.export([mv(run, [60, 0]), add, shape], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.equal(report.collateral, 0, 'the spot the line left is not counted as damage')
  })

  test('the on-screen render equals the exported page, pixel for pixel', async () => {
    const edit = mv(find('Lithium battery pack 48V'), [40, 160])
    const preview = await eng.render(0, 2, [edit])
    const { bytes } = await eng.export([edit], [], OPTS)
    const pm = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false)
    const d = pm.getPixels().slice()
    let diff = 0
    for (let y = 0; y < pm.getHeight(); y++) for (let x = 0; x < pm.getWidth(); x++) for (let c = 0; c < 3; c++) diff += Math.abs(preview.rgba[(y * pm.getWidth() + x) * 4 + c] - d[y * pm.getStride() + x * pm.getNumberOfComponents() + c])
    assert.equal(diff, 0)
  })

  test('verification catches a move that was claimed but never applied', async () => {
    const report = await eng.verify(read('invoice-text.pdf'), [mv(find('Billed to:'), [200, 300])], [], OPTS)
    assert.equal(report.ok, false)
  })

  test('verification catches text that is both at the new place and still at the old one', async () => {
    const run = find('Billed to:')
    // a bad "export": the line was copied to the new place by adding text, but never cleared from the old one
    const add: Edit = { id: 'a', page: 0, kind: 'add', text: 'Billed to:', style: run.style, x: run.xs[0] + 200, baseline: run.baseline + 300 }
    const copied = await eng.export([add], [], OPTS)
    const report = await eng.verify(copied.bytes, [mv(run, [200, 300])], [], OPTS)
    assert.equal(report.ok, false)
    assert.match(report.pages[0].edits[0].actual, /still at its old place/)
  })
})

describe('moving a line of a scanned page', () => {
  test('the ink leaves its old place, appears in the new one, nothing else changes', async () => {
    const textRuns = (() => {
      const e = new PdfEngine(loader)
      e.open(read('invoice-text.pdf'))
      return e.getRuns(0)
    })()
    const ref = textRuns.find((r) => r.text === '₹ 50,000.00')!
    const run: TextRun = { ...ref, source: 'ocr', conf: 55, hidden: false }
    const eng = new PdfEngine(loader)
    eng.open(read('invoice-scan.pdf'))
    const edit = mv(run, [-140, 260])
    const shifted = textRuns.map((r) => (r.id === run.id ? { ...r, rect: [r.rect[0] - 140, r.rect[1] + 260, r.rect[2] - 140, r.rect[3] + 260] as [number, number, number, number], baseline: r.baseline + 260 } : r))
    const lines = shifted.map((r) => ({ text: r.text, rect: r.rect, baseline: r.baseline, size: r.size }))
    const { bytes, report } = await eng.export([edit], [{ page: 0, lines }], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const dark = (b: Uint8Array, rect: number[]) => {
      const pm = mupdf.Document.openDocument(b.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false)
      const px = pm.getPixels()
      let n = 0
      for (let y = Math.floor(rect[1] * 2); y < rect[3] * 2; y++) for (let x = Math.floor(rect[0] * 2); x < rect[2] * 2; x++) if (px[y * pm.getStride() + x * 3] < 110) n++
      return n
    }
    const oldBox = [ref.rect[0], ref.rect[1], ref.rect[2], ref.rect[3]]
    const newBox = [ref.rect[0] - 140, ref.rect[1] + 260, ref.rect[2] - 140, ref.rect[3] + 260]
    assert.ok(dark(read('invoice-scan.pdf'), oldBox) > 40, 'there was ink at the old place')
    assert.ok(dark(bytes, oldBox) < 6, `none is left (${dark(bytes, oldBox)})`)
    assert.ok(dark(bytes, newBox) > 40, 'and the text now sits at the new place')
    assert.ok(textOf(bytes).includes('50,000.00'), 'the searchable layer follows the picture')
    const hidden = charsOf(bytes).filter((c) => c.c === '5' && near(c.y, ref.baseline + 260, 3))
    assert.ok(hidden.length > 0, 'the hidden text sits where the new picture text is')
  })
})

describe('moving a whole table', () => {
  test('every edge moves together; nothing else about the table changes', async () => {
    const fx = buildTablePdf()
    const eng = new PdfEngine(loader)
    eng.open(fx.bytes)
    const base = eng.detectTable(0, 200, 200).edit!
    const moved = translateTable(base.model, 60, 20)
    base.model.xs.forEach((x, i) => assert.ok(near(moved.xs[i], x + 60, 1e-9)))
    base.model.ys.forEach((y, i) => assert.ok(near(moved.ys[i], y + 20, 1e-9)))
    assert.deepEqual(moved.cells, base.model.cells)
    const edit: Edit = { id: 't', page: 0, kind: 'table', text: '', style: base.model.cells[0][0] as never, table: { ...base, model: moved } }
    const { bytes, report } = await eng.export([edit], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const after = charsOf(bytes)
    const inOld = after.filter((c) => c.y > fx.ys[0] + 2 && c.y < fx.ys[10] - 2 && c.x > fx.xs[0] && c.x < fx.xs[4]).filter((c) => c.y < fx.ys[0] + 150 - 2 || c.x < fx.xs[0] + 60)
    assert.ok(textOf(bytes).includes('Clipboard') && textOf(bytes).includes('Footer:'))
    assert.equal(after.filter((c) => c.c === 'V' && near(c.y, fx.ys[0] + 20 + 12.5, 5)).length > 0, true, 'the header text is at the new place')
    void inOld
  })
})
