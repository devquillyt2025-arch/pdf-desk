import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfEngine } from '../src/engine/engine.ts'
import { contentBox, hitOverlay, moveOverlay, overlayBounds, overlayPrims, primsToContent, resizeOverlay, selectTextRects, segsToSvg } from '../src/engine/overlay.ts'
import type { Edit, ExportOptions, FontStyle, Overlay, TextRun } from '../src/engine/types.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FX = path.join(ROOT, 'tests', 'fixtures')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const OPTS: ExportOptions = { textLayer: true, jpegQuality: 88 }
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(FX, name)))
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const STYLE: FontStyle = { family: 'sans', bold: false, italic: false, size: 12, color: [0, 0, 0] }

function open(name: string) {
  const eng = new PdfEngine(loader)
  assert.equal(eng.open(read(name)).status, 'ok')
  return eng
}
let n = 0
const ov = (overlay: Overlay, page = 0): Edit => ({ id: `o${++n}`, page, kind: 'overlay', text: '', style: STYLE, overlay })
const textOf = (bytes: Uint8Array) => squash(mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText())
const pix = (bytes: Uint8Array, scale: number) => {
  const pm = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
  return { w: pm.getWidth(), h: pm.getHeight(), n: pm.getNumberOfComponents(), stride: pm.getStride(), d: pm.getPixels().slice() }
}
const at = (p: ReturnType<typeof pix>, x: number, y: number, scale: number) => {
  const o = Math.round(y * scale) * p.stride + Math.round(x * scale) * p.n
  return [p.d[o], p.d[o + 1], p.d[o + 2]]
}

describe('overlay geometry (pure)', () => {
  const all: Overlay[] = [
    { type: 'highlight', rects: [[10, 10, 100, 22], [10, 24, 60, 36]], color: [255, 235, 59], opacity: 0.5 },
    { type: 'underline', rects: [[10, 10, 100, 22]], color: [220, 38, 38], width: 1.5 },
    { type: 'strike', rects: [[10, 10, 100, 22]], color: [220, 38, 38], width: 1.5 },
    { type: 'rect', rect: [20, 30, 120, 90], stroke: [0, 0, 255], fill: [255, 0, 0], width: 2, opacity: 0.3 },
    { type: 'ellipse', rect: [20, 30, 120, 90], stroke: [0, 0, 255], fill: null, width: 2, opacity: 1 },
    { type: 'line', a: [10, 10], b: [100, 50], color: [0, 0, 0], width: 2 },
    { type: 'arrow', a: [10, 10], b: [100, 50], color: [0, 0, 0], width: 2 },
    { type: 'ink', strokes: [[[10, 10], [20, 25], [30, 12], [45, 40]], [[60, 60]]], color: [0, 0, 128], width: 2 },
    { type: 'image', rect: [50, 50, 150, 100], imageId: 'i1', opacity: 1 },
  ]

  test('every overlay turns into drawable primitives and a bounding box that contains them', () => {
    for (const o of all) {
      const prims = overlayPrims(o)
      assert.ok(prims.length > 0, o.type)
      const b = overlayBounds(o)
      assert.ok(b[2] > b[0] && b[3] > b[1], `${o.type} has an area`)
      for (const p of prims) {
        if (p.kind !== 'path') continue
        for (const s of p.segs) {
          for (let i = 1; i + 1 < s.length; i += 2) {
            const [x, y] = [s[i] as number, s[i + 1] as number]
            assert.ok(x >= b[0] - 0.01 && x <= b[2] + 0.01 && y >= b[1] - 0.01 && y <= b[3] + 0.01, `${o.type}: (${x},${y}) inside ${b}`)
          }
        }
      }
    }
  })

  test('a highlight is a multiply-blended fill; a rectangle with fill and outline is two primitives', () => {
    const [h] = overlayPrims(all[0])
    assert.equal(h.kind === 'path' && h.multiply, true)
    assert.equal(overlayPrims(all[3]).length, 2)
    assert.equal(overlayPrims(all[4]).length, 1, 'no fill → outline only')
  })

  test('PDF content has balanced q/Q, valid operators, and names its resources', () => {
    const names: string[] = []
    const lines = all.flatMap((o) =>
      primsToContent(overlayPrims(o), {
        gstate: (a, m) => (names.push(`g${a}${m}`), 'G1'),
        image: (id) => (id === 'i1' ? 'Im1' : null),
      }),
    )
    const text = lines.join('\n')
    assert.equal((text.match(/\bq\b/g) ?? []).length, (text.match(/\bQ\b/g) ?? []).length)
    assert.match(text, /\/G1 gs/)
    assert.match(text, /\/Im1 Do/)
    assert.ok(!/NaN|undefined/.test(text))
    assert.ok(names.some((s) => s.endsWith('true')), 'highlight asks for multiply')
  })

  test('an unknown picture id is skipped, not drawn as garbage', () => {
    assert.deepEqual(primsToContent(overlayPrims(all[8]), { gstate: () => 'G', image: () => null }), [])
  })

  test('svg path strings are well formed', () => {
    for (const o of all) for (const p of overlayPrims(o)) if (p.kind === 'path') assert.match(segsToSvg(p.segs), /^M [-\d. ]+( [LCZ][-\d. ]*)*$/)
  })

  test('move translates every point; resize maps the content box onto the new box', () => {
    for (const o of all) {
      const b0 = overlayBounds(o)
      const b1 = overlayBounds(moveOverlay(o, 7, -3))
      assert.ok(Math.abs(b1[0] - b0[0] - 7) < 1e-6 && Math.abs(b1[1] - b0[1] + 3) < 1e-6, o.type)
    }
    const ink = all[7]
    const box = contentBox(ink)!
    const bigger = resizeOverlay(ink, [box[0], box[1], box[0] + (box[2] - box[0]) * 2, box[1] + (box[3] - box[1]) * 3])
    const nb = contentBox(bigger)!
    assert.ok(Math.abs(nb[2] - nb[0] - (box[2] - box[0]) * 2) < 1e-6 && Math.abs(nb[3] - nb[1] - (box[3] - box[1]) * 3) < 1e-6)
    assert.equal(resizeOverlay(all[0], [0, 0, 5, 5]), all[0], 'markup is not resizable')
  })

  test('hit testing: lines and pen strokes are hit near the stroke, not in empty space inside their box', () => {
    const line = all[5]
    assert.equal(hitOverlay(line, 55, 30, 2), true)
    assert.equal(hitOverlay(line, 100, 10, 2), false)
    assert.equal(hitOverlay(all[7], 20, 25, 2), true)
    assert.equal(hitOverlay(all[7], 45, 12, 2), false)
    assert.equal(hitOverlay(all[3], 60, 60, 0), true)
    assert.equal(hitOverlay(all[3], 200, 60, 0), false)
  })
})

describe('text selection → boxes', () => {
  let runs: TextRun[]
  before(() => {
    runs = open('invoice-text.pdf').getRuns(0)
  })
  const find = (t: string) => runs.find((r) => r.text === t)!

  test('dragging across part of one line selects just those characters', () => {
    const r = find('Lithium battery pack 48V')
    const y = (r.rect[1] + r.rect[3]) / 2
    const from = r.xs[0] - 4
    const to = r.xs[7] // "Lithium"
    const rects = selectTextRects(runs, [from, y], [to, y])
    assert.equal(rects.length, 1)
    assert.ok(Math.abs(rects[0][0] - r.xs[0]) < 0.01 && Math.abs(rects[0][2] - r.xs[7]) < 0.6, JSON.stringify(rects))
    assert.ok(rects[0][2] < find('Lithium battery pack 48V').xs[10], 'stops before "battery" ends')
  })

  test('selection works backwards too', () => {
    const r = find('Charger unit (fast)')
    const y = (r.rect[1] + r.rect[3]) / 2
    const fwd = selectTextRects(runs, [r.xs[0], y], [r.xs[7], y])
    const back = selectTextRects(runs, [r.xs[7], y], [r.xs[0], y])
    assert.deepEqual(back, fwd)
  })

  test('dragging down through several lines selects the lines between, whole', () => {
    const a = find('Lithium battery pack 48V')
    const b = find('Installation & testing')
    const rects = selectTextRects(runs, [a.xs[3], (a.rect[1] + a.rect[3]) / 2], [b.xs[5], (b.rect[1] + b.rect[3]) / 2])
    assert.ok(rects.length >= 3, `got ${rects.length}`)
    const charger = find('Charger unit (fast)')
    assert.ok(rects.some((q) => q[0] <= charger.xs[0] + 0.5 && q[2] >= charger.xs[charger.text.length] - 1), 'the middle line is fully covered')
  })

  test('empty space far from any text selects nothing', () => {
    assert.deepEqual(selectTextRects(runs, [300, 700], [400, 760]), [])
  })
})

describe('overlays on a searchable page', () => {
  let eng: PdfEngine
  let runs: TextRun[]
  let base: string
  before(() => {
    eng = open('invoice-text.pdf')
    runs = eng.getRuns(0)
    base = textOf(read('invoice-text.pdf'))
  })
  const box = (t: string) => runs.find((r) => r.text === t)!.rect

  test('highlight, underline, strike-out, shapes and a pen stroke export, verify, and leave the text alone', async () => {
    const item = box('Lithium battery pack 48V')
    const edits = [
      ov({ type: 'highlight', rects: [item], color: [255, 235, 59], opacity: 1 }),
      ov({ type: 'underline', rects: [box('Charger unit (fast)')], color: [220, 38, 38], width: 1.5 }),
      ov({ type: 'strike', rects: [box('Installation & testing')], color: [0, 0, 0], width: 1.5 }),
      ov({ type: 'rect', rect: [330, 560, 450, 620], stroke: [37, 99, 235], fill: [37, 99, 235], width: 2, opacity: 0.25 }),
      ov({ type: 'ellipse', rect: [60, 560, 160, 620], stroke: [22, 163, 74], fill: null, width: 3, opacity: 1 }),
      ov({ type: 'arrow', a: [200, 700], b: [300, 640], color: [220, 38, 38], width: 2.5 }),
      ov({ type: 'line', a: [60, 700], b: [180, 700], color: [0, 0, 0], width: 1 }),
      ov({ type: 'ink', strokes: [[[330, 700], [345, 680], [360, 705], [380, 675], [400, 700]]], color: [20, 20, 140], width: 2 }),
    ]
    const { bytes, report } = await eng.export(edits, [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.equal(report.editCount, edits.length)
    assert.equal(report.passed, edits.length)
    assert.equal(textOf(bytes), base, 'not one character of text changed')
    const p = pix(bytes, 2)
    const o = pix(read('invoice-text.pdf'), 2)
    // the highlight really is yellow-ish over white paper, and an unrelated spot is unchanged
    const [r, g, b] = at(p, item[0] + 2, item[3] - 1, 2)
    assert.ok(r > 200 && g > 190 && b < 140, `highlight pixel ${[r, g, b]}`)
    assert.deepEqual(at(p, 500, 760, 2), at(o, 500, 760, 2))
  })

  test('a highlight is a highlighter: the text underneath is still readable (multiply, not paint-over)', async () => {
    const r0 = runs.find((r) => r.text === 'Billed to:')!
    const { bytes } = await eng.export([ov({ type: 'highlight', rects: [r0.rect], color: [255, 235, 59], opacity: 1 })], [], OPTS)
    const p = pix(bytes, 4)
    let dark = 0
    for (let y = Math.floor(r0.rect[1] * 4); y < r0.rect[3] * 4; y++) for (let x = Math.floor(r0.rect[0] * 4); x < r0.rect[2] * 4; x++) if (p.d[y * p.stride + x * p.n] < 90) dark++
    assert.ok(dark > 60, `dark glyph pixels survive under the highlight (${dark})`)
  })

  test('what you see is what you save: the on-screen render equals the exported page, pixel for pixel', async () => {
    const edits = [
      ov({ type: 'highlight', rects: [box('Billed to:')], color: [134, 239, 172], opacity: 0.6 }),
      ov({ type: 'ellipse', rect: [330, 560, 450, 620], stroke: [220, 38, 38], fill: [255, 200, 0], width: 3, opacity: 0.4 }),
      ov({ type: 'arrow', a: [200, 700], b: [300, 640], color: [0, 0, 0], width: 2 }),
    ]
    const preview = await eng.render(0, 2, edits)
    const { bytes } = await eng.export(edits, [], OPTS)
    const p = pix(bytes, 2)
    assert.equal(preview.width, p.w)
    let diff = 0
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) for (let c = 0; c < 3; c++) diff += Math.abs(preview.rgba[(y * p.w + x) * 4 + c] - p.d[y * p.stride + x * p.n + c])
    assert.equal(diff, 0)
  })

  test('overlay + a text edit on the same page both verify', async () => {
    const total = runs.find((r) => r.text === '₹ 60,900.00')!
    const text: Edit = { id: 'tx', page: 0, kind: 'replace', run: total, text: '₹ 61,000.00', style: total.style }
    const edits = [text, ov({ type: 'highlight', rects: [total.rect], color: [255, 235, 59], opacity: 1 }), ov({ type: 'rect', rect: [60, 560, 160, 620], stroke: [0, 0, 0], fill: null, width: 1, opacity: 1 })]
    const { bytes, report } = await eng.export(edits, [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.ok(textOf(bytes).includes('61,000.00') && !textOf(bytes).includes('60,900.00'))
  })

  test('a picture overlay places the picture and keeps the text', async () => {
    const id = 'logo'
    const size = eng.addImage(id, read('invoice-scan-src.png'))
    assert.ok(size.width > 100 && size.height > 100)
    const edits = [ov({ type: 'image', rect: [330, 560, 450, 640], imageId: id, opacity: 1 })]
    const { bytes, report } = await eng.export(edits, [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.equal(textOf(bytes), base)
    const d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').asPDF()!
    const xo = d.findPage(0).getInheritable('Resources').get('XObject')
    let found = 0
    xo.forEach((_v, k) => String(k).startsWith('PDOvI') && found++)
    assert.equal(found, 1)
  })

  test('a picture id nobody registered is reported, not silently dropped', async () => {
    const edits = [ov({ type: 'image', rect: [330, 560, 450, 640], imageId: 'ghost', opacity: 1 })]
    const { report } = await eng.export(edits, [], OPTS)
    assert.equal(report.ok, false)
    assert.equal(report.pages[0].edits[0].actual, '(no visible change)')
  })

  test('white on white cannot be seen, so it is reported as such — not as a failed save', async () => {
    const blank: Overlay = { type: 'rect', rect: [100, 600, 220, 660], stroke: [255, 255, 255], fill: [255, 255, 255], width: 2, opacity: 1 }
    const { report } = await eng.export([ov(blank)], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.match(report.pages[0].edits[0].warning ?? '', /already white/)
  })

  test('white over something is an ordinary check: it must show', async () => {
    const t = box('Total payable')
    const whiteout: Overlay = { type: 'rect', rect: [t[0] - 2, t[1] - 2, t[2] + 2, t[3] + 2], stroke: null, fill: [255, 255, 255], width: 1, opacity: 1 }
    const { report } = await eng.export([ov(whiteout)], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.equal(report.pages[0].edits[0].warning, undefined, 'it changed the page, so no caveat is needed')
  })

  test('verification catches an overlay that was claimed but not applied', async () => {
    const claimed = ov({ type: 'highlight', rects: [box('Billed to:')], color: [255, 235, 59], opacity: 1 })
    const report = await eng.verify(read('invoice-text.pdf'), [claimed], [], OPTS)
    assert.equal(report.ok, false)
    assert.equal(report.passed, 0)
  })

  test('verification catches damage outside the overlay', async () => {
    const claimed = ov({ type: 'highlight', rects: [box('Billed to:')], color: [255, 235, 59], opacity: 1 })
    // a "bad export": the highlight is there, but so is an extra black bar somewhere else
    const bad = await eng.export([claimed, ov({ type: 'rect', rect: [100, 300, 500, 330], stroke: null, fill: [0, 0, 0], width: 0, opacity: 1 })], [], OPTS)
    const report = await eng.verify(bad.bytes, [claimed], [], OPTS)
    assert.equal(report.ok, false, 'the stray bar must be noticed')
    assert.ok(report.collateral > 0)
  })

  test('re-editing a file we already exported keeps the earlier overlays', async () => {
    const first = await eng.export([ov({ type: 'highlight', rects: [box('Billed to:')], color: [255, 235, 59], opacity: 1 })], [], OPTS)
    const again = new PdfEngine(loader)
    assert.equal(again.open(first.bytes).status, 'ok')
    const second = await again.export([ov({ type: 'underline', rects: [box('Charger unit (fast)')], color: [220, 38, 38], width: 1.5 })], [], OPTS)
    assert.equal(second.report.ok, true, JSON.stringify(second.report, null, 1))
    const p = pix(second.bytes, 2)
    const b = box('Billed to:')
    const [r, g, bl] = at(p, b[0] + 2, b[3] - 1, 2)
    assert.ok(r > 200 && g > 190 && bl < 140, `first session's highlight still there: ${[r, g, bl]}`)
  })
})

describe('overlays on a scanned page', () => {
  let eng: PdfEngine
  const scanRect: [number, number, number, number] = [60, 220, 330, 245]
  before(() => {
    eng = open('invoice-scan.pdf')
  })

  test('overlay-only export keeps the scanned picture untouched and verifies', async () => {
    const edits = [
      ov({ type: 'highlight', rects: [scanRect], color: [255, 235, 59], opacity: 1 }),
      ov({ type: 'arrow', a: [400, 500], b: [330, 440], color: [220, 38, 38], width: 3 }),
    ]
    const { bytes, report } = await eng.export(edits, [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    // still exactly one picture (not re-rendered): the page's image object count is unchanged
    const imgs = (b: Uint8Array) => {
      let c = 0
      const d = mupdf.Document.openDocument(b.slice(), 'application/pdf').asPDF()!
      d.findPage(0).getInheritable('Resources').get('XObject').forEach(() => c++)
      return c
    }
    assert.equal(imgs(bytes), imgs(read('invoice-scan.pdf')))
    // outside the overlays the picture is pixel-identical to the original
    const p = pix(bytes, 1)
    const o = pix(read('invoice-scan.pdf'), 1)
    assert.deepEqual(at(p, 500, 100, 1), at(o, 500, 100, 1))
    const [r, g, b] = at(p, 70, 242, 1)
    assert.ok(r > 180 && b < 170, `highlight over paper is yellow: ${[r, g, b]}`)
  })

  test('on-screen render of a scan (bitmap path) matches the saved page, including the multiply highlight', async () => {
    const edits = [
      ov({ type: 'highlight', rects: [scanRect], color: [134, 239, 172], opacity: 0.7 }),
      ov({ type: 'rect', rect: [100, 500, 220, 560], stroke: [37, 99, 235], fill: [37, 99, 235], width: 2, opacity: 0.3 }),
      ov({ type: 'ink', strokes: [[[300, 600], [320, 620], [340, 595], [360, 625]]], color: [20, 20, 140], width: 2.5 }),
    ]
    const preview = await eng.render(0, 1, edits)
    const { bytes, report } = await eng.export(edits, [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const p = pix(bytes, 1)
    assert.equal(preview.width, p.w)
    let sum = 0
    let worst = 0
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(preview.rgba[(y * p.w + x) * 4 + c] - p.d[y * p.stride + x * p.n + c])
          sum += d
          worst = Math.max(worst, d)
        }
      }
    }
    assert.ok(sum / (p.w * p.h * 3) < 0.35, `mean difference ${(sum / (p.w * p.h * 3)).toFixed(3)}`)
    assert.ok(worst <= 90, `worst pixel difference ${worst} (anti-aliasing only)`)
    // and the multiply really multiplies: green over white paper ≈ white × green
    const [r, g, b] = [preview.rgba[((scanRect[1] + 2) * p.w + 70) * 4], preview.rgba[((scanRect[1] + 2) * p.w + 70) * 4 + 1], preview.rgba[((scanRect[1] + 2) * p.w + 70) * 4 + 2]]
    assert.ok(g > r && g > b, `green-ish highlight in the bitmap preview: ${[r, g, b]}`)
  })

  test('overlay + an edited scan line: both land, report ok', async () => {
    const textRuns = open('invoice-text.pdf').getRuns(0)
    const ref = textRuns.find((r) => r.text === '₹ 50,000.00')!
    const run: TextRun = { ...ref, source: 'ocr', conf: 55, hidden: false }
    const edit: Edit = { id: 'sc1', page: 0, kind: 'replace', run, text: '₹ 52,000.00', style: run.style }
    const lines = textRuns.map((r) => ({ text: r.id === run.id ? '₹ 52,000.00' : r.text, rect: r.rect, baseline: r.baseline, size: r.size }))
    const o = ov({ type: 'underline', rects: [ref.rect], color: [220, 38, 38], width: 2 })
    const { bytes, report } = await eng.export([edit, o], [{ page: 0, lines }], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.ok(textOf(bytes).includes('52,000.00'))
    const re = new PdfEngine(loader)
    re.open(bytes)
    assert.equal(re.analyze(0).kind, 'scan-ocr')
  })
})
