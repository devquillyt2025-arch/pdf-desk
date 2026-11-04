import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfEngine } from '../src/engine/engine.ts'
import { planEdit } from '../src/engine/plan.ts'
import type { Edit, ExportOptions, FontStyle, TextRun } from '../src/engine/types.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FX = path.join(ROOT, 'tests', 'fixtures')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const OPTS: ExportOptions = { textLayer: true, jpegQuality: 88 }

const readPdf = (name: string) => new Uint8Array(fs.readFileSync(path.join(FX, name)))
function textOf(bytes: Uint8Array, page = 0): string {
  const d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf')
  const p = d.loadPage(page)
  const t = p.toStructuredText('preserve-whitespace').asText()
  return t
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
/** Redrawn text is appended to the content stream, so compare page text as a multiset of words, not in order. */
const words = (s: string) => squash(s).split(' ').sort()

function open(name: string) {
  const eng = new PdfEngine(loader)
  const r = eng.open(readPdf(name))
  assert.equal(r.status, 'ok')
  return eng
}
let n = 0
const mkEdit = (run: TextRun, text: string, over: Partial<Edit> = {}): Edit => ({ id: `e${++n}`, page: 0, kind: 'replace', run, text, style: run.style, ...over })

describe('searchable PDF', () => {
  let eng: PdfEngine
  let runs: TextRun[]
  before(() => {
    eng = open('invoice-text.pdf')
    runs = eng.getRuns(0)
  })

  test('page is classified as text and runs carry real styling', () => {
    const info = eng.analyze(0)
    assert.equal(info.kind, 'text')
    assert.ok(info.visibleChars > 300)
    const billed = runs.find((r) => r.text === 'Billed to:')!
    assert.ok(billed, 'finds the label run')
    assert.equal(billed.style.bold, true)
    assert.equal(billed.style.family, 'sans')
    const title = runs.find((r) => r.text.startsWith('Invoice INV'))!
    assert.equal(title.style.family, 'serif')
    assert.deepEqual(title.style.color, [18, 58, 107])
    const gst = runs.find((r) => r.text === '32ABCDE1234F1Z5')!
    assert.equal(gst.style.family, 'mono')
    assert.ok(Math.abs(runs.find((r) => r.text === 'Billed to:')!.size - 9.75) < 0.01)
  })

  test('planner keeps unchanged leading words and only redraws the tail', () => {
    const run = runs.find((r) => r.text === 'Lithium battery pack 48V')!
    const plan = planEdit(mkEdit(run, 'Lithium battery pack 60V'), false)
    assert.equal(plan.keep, 'Lithium battery pack '.length)
    assert.equal(plan.draw!.text, '60V')
    assert.ok(plan.clear![0] > run.rect[0] + 50, 'the kept words are outside the cleared area')
    const append = planEdit(mkEdit(run, 'Lithium battery pack 48V (new)'), false)
    assert.equal(append.clear, null, 'appending clears nothing')
    assert.equal(append.draw!.text, ' (new)')
    assert.equal(planEdit(mkEdit(run, run.text), false).noop, true)
  })

  test('editing one number: new text present, old text gone, everything else untouched', async () => {
    const run = runs.find((r) => r.text === '₹ 50,000.00')!
    const edit = mkEdit(run, '₹ 52,000.00')
    const { bytes, report } = await eng.export([edit], [], OPTS)
    const before = squash(textOf(readPdf('invoice-text.pdf')))
    const after = squash(textOf(bytes))
    assert.ok(after.includes('52,000.00'))
    assert.ok(!after.includes('50,000.00'), 'old text is really removed, not just covered')
    // every other word identical; only 50,000.00 -> 52,000.00
    const expected = words(before)
    expected.splice(expected.indexOf('50,000.00'), 1, '52,000.00')
    assert.deepEqual(words(after), expected.sort())
    assert.equal(report.ok, true, JSON.stringify(report))
    assert.equal(report.collateral, 0)
    assert.equal(report.passed, 1)
  })

  test('multiple edits incl. characters missing from base fonts (₹, ✓) and bold style', async () => {
    const total = runs.find((r) => r.text === '₹ 60,900.00')!
    const item = runs.find((r) => r.text === 'Charger unit (fast)')!
    const edits = [mkEdit(total, '₹ 61,250.50 ✓'), mkEdit(item, 'Charger unit (fast) + cable')]
    const { bytes, report } = await eng.export(edits, [], OPTS)
    const after = squash(textOf(bytes))
    assert.ok(words(after).includes('61,250.50') && words(after).includes('✓'), after)
    assert.ok(after.includes('Charger unit (fast)'), 'the untouched part of the line stays exactly as it was')
    assert.ok(words(after).includes('cable') && words(after).includes('+'), 'appended words are present')
    assert.ok(!after.includes('60,900.00'))
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.equal(report.passed, 2)
  })

  test('adding new text and erasing an area', async () => {
    const sig = runs.find((r) => r.text === 'Billed to:')!
    const style: FontStyle = { ...sig.style, bold: false, size: 11, color: [200, 0, 0] }
    const add: Edit = { id: 'add1', page: 0, kind: 'add', text: 'PAID — thank you', style, x: 330, baseline: 420 }
    const bank = runs.find((r) => r.text === '00112233445')!
    const erase: Edit = { id: 'er1', page: 0, kind: 'erase', text: '', style, rect: bank.rect, fill: 'auto' }
    const { bytes, report } = await eng.export([add, erase], [], OPTS)
    const after = squash(textOf(bytes))
    assert.ok(after.includes('PAID — thank you'))
    assert.ok(!after.includes('00112233445'))
    assert.ok(after.includes('SBIN0001234'), 'the neighbouring run survives')
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
  })

  test('verification catches a wrong export (edit claimed but not applied)', async () => {
    const run = runs.find((r) => r.text === '₹ 4,500.00')!
    const claimed = mkEdit(run, '₹ 9,999.00')
    const untouched = readPdf('invoice-text.pdf')
    const report = await eng.verify(untouched, [claimed], [], OPTS)
    assert.equal(report.ok, false)
    assert.equal(report.passed, 0)
  })

  test('background fills and graphics survive (no white boxes drawn over the page)', async () => {
    const total = runs.find((r) => r.text === '₹ 60,900.00')!
    const { bytes } = await eng.export([mkEdit(total, '₹ 61,000.00')], [], OPTS)
    // sample the yellow total row far from the text; it must look exactly like the original
    const sample = (bytes: Uint8Array) => {
      const pm = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false)
      const o = Math.round(240 * 2) * pm.getStride() + Math.round(300 * 2) * 3
      const px = pm.getPixels()
      return [px[o], px[o + 1], px[o + 2]]
    }
    assert.deepEqual(sample(bytes), sample(readPdf('invoice-text.pdf')))
  })
})

describe('scanned PDF', () => {
  let eng: PdfEngine
  let textRuns: TextRun[]
  before(() => {
    eng = open('invoice-scan.pdf')
    textRuns = open('invoice-text.pdf').getRuns(0)
  })

  test('page is classified as a scan with its native resolution', () => {
    const info = eng.analyze(0)
    assert.equal(info.kind, 'scan')
    assert.equal(info.visibleChars, 0)
    assert.ok(info.imageCoverage > 0.95)
    assert.ok(Math.abs(info.imageDpi! - 200) < 2)
    assert.deepEqual(eng.getRuns(0), [], 'no text to click until OCR has run')
  })

  test('editing a scan patches pixels, keeps the page searchable and verifies', async () => {
    // Reuse the geometry of the matching run on the text version of the same page as a stand-in for an OCR run.
    const ref = textRuns.find((r) => r.text === '₹ 50,000.00')!
    const run: TextRun = { ...ref, source: 'ocr', conf: 55, hidden: false }
    const edit = mkEdit(run, '₹ 52,000.00')
    const lines = textRuns.map((r) => ({ text: r.id === run.id ? '₹ 52,000.00' : r.text, rect: r.rect, baseline: r.baseline, size: r.size }))
    const { bytes, report } = await eng.export([edit], [{ page: 0, lines }], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const out = squash(textOf(bytes))
    assert.ok(out.includes('52,000.00'), 'hidden text layer carries the corrected value')
    assert.ok(!out.includes('50,000.00'))
    // it is still a picture: no *visible* text was added, the page is one image
    const re = new PdfEngine(loader)
    re.open(bytes)
    const info = re.analyze(0)
    assert.equal(info.kind, 'scan-ocr')
    assert.ok(info.hiddenChars > 100)
  })

  test('layer-only export leaves the original picture byte-identical in appearance', async () => {
    const lines = textRuns.map((r) => ({ text: r.text, rect: r.rect, baseline: r.baseline, size: r.size }))
    const { bytes, report } = await eng.export([], [{ page: 0, lines }], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const a = mupdf.Document.openDocument(readPdf('invoice-scan.pdf'), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false)
    const b = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false)
    const pa = a.getPixels().slice()
    const pb = b.getPixels().slice()
    let diff = 0
    for (let i = 0; i < pa.length; i++) diff += Math.abs(pa[i] - pb[i])
    assert.equal(diff, 0, 'adding a hidden layer must not change a single visible pixel')
    assert.ok(squash(textOf(bytes)).includes('Lithium battery pack 48V'))
  })

  test('replacing an existing hidden text layer does not duplicate it', async () => {
    const lines1 = textRuns.map((r) => ({ text: r.text, rect: r.rect, baseline: r.baseline, size: r.size }))
    const first = await eng.export([], [{ page: 0, lines: lines1 }], OPTS)
    const e2 = new PdfEngine(loader)
    e2.open(first.bytes)
    assert.equal(e2.analyze(0).kind, 'scan-ocr')
    const lines2 = lines1.map((l) => ({ ...l, text: l.text.replace('Charger unit', 'Charger UNIT') }))
    const second = await e2.export([], [{ page: 0, lines: lines2 }], OPTS)
    const text = squash(textOf(second.bytes))
    assert.ok(text.includes('Charger UNIT (fast)'))
    assert.ok(!text.includes('Charger unit (fast)'), 'old hidden text removed')
    assert.equal((text.match(/Lithium battery pack 48V/g) ?? []).length, 1, 'no duplicated lines')
  })
})

describe('rotated and offset pages', () => {
  // Each case draws two lines so that they display upright once the page's /Rotate (or box offset) is applied.
  // `tm(dy)` is the text matrix for a line `dy` points further along the page's "down" direction.
  const cases: { name: string; rotate: 0 | 90 | 180 | 270; box: [number, number, number, number]; tm: (dy: number) => string }[] = [
    { name: '/Rotate 90', rotate: 90, box: [0, 0, 595, 842], tm: (dy) => `0 1 -1 0 ${150 + dy} 150` },
    { name: '/Rotate 270', rotate: 270, box: [0, 0, 595, 842], tm: (dy) => `0 -1 1 0 ${150 + dy} 600` },
    { name: '/Rotate 180', rotate: 180, box: [0, 0, 595, 842], tm: (dy) => `-1 0 0 -1 400 ${150 + dy}` },
    { name: 'a MediaBox with a non-zero origin', rotate: 0, box: [30, 40, 625, 882], tm: (dy) => `1 0 0 1 80 ${700 - dy}` },
  ]

  function build(c: (typeof cases)[number]): Uint8Array {
    const d = new mupdf.PDFDocument()
    const res = d.addObject(d.newDictionary())
    const fonts = d.newDictionary()
    fonts.put('F1', d.addSimpleFont(new mupdf.Font('Helvetica'), 'Latin'))
    res.put('Font', fonts)
    const content = [
      ['Total: 1,250.00 USD', 0],
      ['Second line stays untouched', 22],
    ]
      .map(([text, dy]) => `BT /F1 14 Tf ${c.tm(dy as number)} Tm (${text}) Tj ET`)
      .join('\n')
    d.insertPage(-1, d.addPage(c.box, c.rotate, res, content))
    return new Uint8Array(d.saveToBuffer('compress').asUint8Array().slice())
  }

  for (const c of cases) {
    test(`edit + verify on a page with ${c.name}`, async () => {
      const eng = new PdfEngine(loader)
      assert.equal(eng.open(build(c)).status, 'ok')
      const runs = eng.getRuns(0)
      const run = runs.find((r) => r.text.startsWith('Total'))
      assert.ok(run, `finds the horizontal run, got: ${JSON.stringify(runs.map((r) => r.text))}`)
      const { bytes, report } = await eng.export([mkEdit(run, 'Total: 1,350.00 USD')], [], OPTS)
      assert.equal(report.ok, true, JSON.stringify(report, null, 1))
      const text = squash(textOf(bytes))
      assert.ok(text.includes('1,350.00') && !text.includes('1,250.00'), text)
      assert.ok(text.includes('Second line stays untouched'))
    })
  }
})

describe('text converted to outlines (no text objects, only vector shapes)', () => {
  // 400 tiny black "glyph" shapes in rows, like a print-to-PDF whose letters were turned into curves.
  function outlinedPage(): Uint8Array {
    const d = new mupdf.PDFDocument()
    const rects: string[] = []
    for (let row = 0; row < 10; row++) for (let col = 0; col < 40; col++) rects.push(`${40 + col * 12} ${700 - row * 24} 7 9 re f`)
    d.insertPage(-1, d.addPage([0, 0, 595, 842], 0, d.addObject(d.newDictionary()), `0 0 0 rg\n${rects.join('\n')}`))
    return new Uint8Array(d.saveToBuffer('compress').asUint8Array().slice())
  }
  // A run that covers the first 10 shapes of row 3 (y from the top: 842 - 700 + 3*24 ...), as OCR would report it.
  const run = (): TextRun => {
    const x0 = 40
    const x1 = 40 + 10 * 12 - 5
    const top = 842 - (700 - 3 * 24) - 9
    const text = 'ABCDEFGHIJ'
    return {
      id: '0:o0', page: 0, source: 'ocr', text, rect: [x0, top, x1, top + 9], x: x0, baseline: top + 9,
      xs: [...Array(text.length).keys()].map((i) => x0 + i * 12).concat(x1), size: 10, fontName: 'scan',
      style: { family: 'sans', bold: false, italic: false, size: 10, color: [0, 0, 0] }, hidden: false, conf: 60,
    }
  }

  test('is recognised as a picture-like page, not "blank"', () => {
    const eng = new PdfEngine(loader)
    eng.open(outlinedPage())
    const info = eng.analyze(0)
    assert.equal(info.kind, 'outlined')
    assert.equal(info.visibleChars, 0)
    assert.deepEqual(eng.getRuns(0), [], 'nothing clickable until OCR has run')
  })

  test('an edit removes the old shapes, draws the new text and verifies', async () => {
    const eng = new PdfEngine(loader)
    eng.open(outlinedPage())
    const r = run()
    const { bytes, report } = await eng.export([mkEdit(r, 'HELLO')], [{ page: 0, lines: [{ text: 'HELLO', rect: r.rect, baseline: r.baseline, size: 10 }] }], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.ok(squash(textOf(bytes)).includes('HELLO'), 'searchable text layer carries the edit')
    // An edited page is re-rendered, so it is now a picture of the page plus a hidden text layer.
    const re = new PdfEngine(loader)
    re.open(bytes)
    assert.equal(re.analyze(0).kind, 'scan-ocr')
    assert.ok(re.analyze(0).hiddenChars >= 5)
  })

  test('recognising without editing keeps the original drawing and adds searchable text', async () => {
    const eng = new PdfEngine(loader)
    eng.open(outlinedPage())
    const r = run()
    const { bytes, report } = await eng.export([], [{ page: 0, lines: [{ text: 'ABCDEFGHIJ', rect: r.rect, baseline: r.baseline, size: 10 }] }], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.ok(squash(textOf(bytes)).includes('ABCDEFGHIJ'))
    const px = (b: Uint8Array) => mupdf.Document.openDocument(b.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false).getPixels().slice()
    const a = px(outlinedPage())
    const b = px(bytes)
    let diff = 0
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i])
    assert.equal(diff, 0, 'a hidden layer must not change a single visible pixel')
  })
})
