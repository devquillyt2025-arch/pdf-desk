import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfEngine } from '../src/engine/engine.ts'
import { CELL_PAD_X, cellRect, colCount, deleteColumns, deleteRows, distributeColumns, fitWidth, insertColumn, insertRow, mapCells, moveBoundary, rowCount, setBorders, tableBounds, zebra } from '../src/engine/table.ts'
import type { Edit, ExportOptions, FontStyle, TableEdit, TableModel } from '../src/engine/types.ts'
import { ROADMAP, buildTablePdf } from '../scripts/table-fixture.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const OPTS: ExportOptions = { textLayer: true, jpegQuality: 88 }
const STYLE: FontStyle = { family: 'sans', bold: false, italic: false, size: 10, color: [0, 0, 0] }
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

function engineFor(bytes: Uint8Array) {
  const eng = new PdfEngine(loader)
  assert.equal(eng.open(bytes).status, 'ok')
  return eng
}
const textOf = (bytes: Uint8Array) => squash(mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText())
const pix = (bytes: Uint8Array, s: number) => {
  const pm = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceRGB, false)
  return { w: pm.getWidth(), h: pm.getHeight(), n: pm.getNumberOfComponents(), stride: pm.getStride(), d: pm.getPixels().slice() }
}
const at = (p: ReturnType<typeof pix>, x: number, y: number, s: number) => {
  const o = Math.round(y * s) * p.stride + Math.round(x * s) * p.n
  return [p.d[o], p.d[o + 1], p.d[o + 2]]
}
const tableEdit = (id: string, table: TableEdit, page = 0): Edit => ({ id, page, kind: 'table', text: '', style: STYLE, table })
const near = (a: number, b: number, tol = 0.6) => Math.abs(a - b) <= tol

describe('detecting a ruled table', () => {
  const fx = buildTablePdf()
  const eng = engineFor(fx.bytes)

  test('finds the grid: column and row edges match what was drawn', () => {
    const { edit, reason } = eng.detectTable(0, 200, 200)
    assert.ok(edit, `a table was found (${reason})`)
    const m = edit!.model
    assert.equal(colCount(m), 4)
    assert.equal(rowCount(m), 10)
    fx.xs.forEach((x, i) => assert.ok(near(m.xs[i], x), `x${i}: ${m.xs[i]} vs ${x}`))
    fx.ys.forEach((y, i) => assert.ok(near(m.ys[i], y), `y${i}: ${m.ys[i]} vs ${y}`))
  })

  test('every cell carries its text, in order, even when it runs past its border', () => {
    const m = eng.detectTable(0, 200, 200).edit!.model
    ROADMAP.forEach((row, r) => row.forEach((text, c) => assert.equal(m.cells[r][c].text, text, `row ${r + 1}, col ${c + 1}`)))
    assert.equal(m.cells[2][3].text, 'Support rich content, timeline, backup, analytics.')
  })

  test('backgrounds, text colour, font and borders are read from the page', () => {
    const m = eng.detectTable(0, 200, 200).edit!.model
    assert.deepEqual(m.cells[0][0].fill, [31, 78, 121])
    assert.deepEqual(m.cells[0][0].color, [255, 255, 255])
    assert.deepEqual(m.cells[3][1].fill, [243, 243, 243])
    assert.deepEqual(m.cells[3][1].color, [20, 20, 20])
    assert.equal(m.cells[3][1].dejavu, true, 'a DejaVu document keeps DejaVu')
    assert.ok(near(m.cells[3][1].size, 9, 0.1))
    assert.deepEqual(m.borders.color, [153, 153, 153])
    assert.ok(near(m.borders.width, 0.5, 0.05))
    assert.deepEqual([m.borders.outer, m.borders.innerH, m.borders.innerV], [true, true, true])
  })

  test('text that sticks out of the table is included in what gets cleared', () => {
    const { clear } = eng.detectTable(0, 200, 200).edit!
    const right = fx.xs[4]
    assert.ok(clear.some((r) => r[2] > right + 20), 'the overflowing text is covered')
  })

  test('a click outside any table, or on the title, finds nothing', () => {
    assert.equal(eng.detectTable(0, 300, 40).edit, null)
    assert.equal(eng.detectTable(0, 300, 700).edit, null)
  })

  test('borders drawn as hair-thin filled boxes are detected just as well', () => {
    const thin = buildTablePdf({ thinBorders: true })
    const m = engineFor(thin.bytes).detectTable(0, 200, 200).edit!.model
    assert.equal(colCount(m), 4)
    assert.equal(rowCount(m), 10)
    assert.deepEqual(m.borders.color, [153, 153, 153])
  })

  test('without ruled lines there is nothing to detect — but a dragged box infers the table from the text', async () => {
    const bare = buildTablePdf({ noLines: true, rows: ROADMAP.slice(0, 6), colWidths: [50, 110, 160, 190] })
    const e = engineFor(bare.bytes)
    // the grey/blue row backgrounds are not lines, so no grid is found
    assert.equal(e.detectTable(0, 200, 140).edit, null)
    const inferred = e.inferTable(0, [40, 100, 560, bare.ys[bare.ys.length - 1] + 4]).edit
    assert.ok(inferred)
    assert.equal(colCount(inferred!.model), 4)
    assert.equal(rowCount(inferred!.model), 6)
    assert.equal(inferred!.model.cells[1][1].text, 'Clipboard Vault')
    assert.deepEqual(inferred!.model.borders.outer, false)
    // the text keeps its place: left-aligned columns are hugged by their edge, so redrawing puts each word back
    assert.ok(inferred!.model.cells.every((row) => row.every((c) => c.align === 'left')), 'every column is left-aligned, as drawn')
    const redrawn = await e.export([tableEdit('inf', inferred!)], [], OPTS)
    assert.equal(redrawn.report.ok, true, JSON.stringify(redrawn.report, null, 1))
    const xOf = (bytes: Uint8Array, ch: string, y: number) => {
      let found = NaN
      mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').walk({
        onChar(c, origin) {
          if (c === ch && Math.abs(origin[1] - y) < 5 && Number.isNaN(found) && origin[0] > 85) found = origin[0] // first 'C' after the Version column
        },
      })
      return found
    }
    const y2 = inferred!.model.ys[1] + 13 // the "v0.1 Clipboard Vault" row
    assert.ok(near(xOf(redrawn.bytes, 'C', y2), xOf(bare.bytes, 'C', y2), 1.6), `the "Clipboard Vault" text barely moves (${xOf(bare.bytes, 'C', y2)} → ${xOf(redrawn.bytes, 'C', y2)})`)
    assert.deepEqual(inferred!.model.cells[0][0].fill, [31, 78, 121], 'row backgrounds are still read')
  })
})

describe('editing the model (pure)', () => {
  let m: TableModel
  before(() => {
    m = engineFor(buildTablePdf().bytes).detectTable(0, 200, 200).edit!.model
  })

  test('insert a row: later rows move down, the new row copies its neighbour’s look and is empty', () => {
    const n = insertRow(m, 2, 2)
    assert.equal(rowCount(n), 11)
    assert.ok(near(n.ys[3] - n.ys[2], m.ys[3] - m.ys[2]))
    assert.ok(near(n.ys[n.ys.length - 1] - m.ys[m.ys.length - 1], m.ys[3] - m.ys[2]))
    assert.deepEqual(n.cells[2].map((c) => c.text), ['', '', '', ''])
    assert.deepEqual(n.cells[2][0].fill, m.cells[2][0].fill)
    assert.equal(n.cells[3][0].text, m.cells[2][0].text)
    assert.equal(rowCount(insertRow(m, 10, 9)), 11, 'at the end')
  })

  test('insert a column, delete rows / columns', () => {
    const n = insertColumn(m, 1, 1, 50)
    assert.equal(colCount(n), 5)
    assert.ok(near(n.xs[2] - n.xs[1], 50))
    assert.ok(near(n.xs[5] - m.xs[4], 50))
    assert.equal(n.cells[1][2].text, m.cells[1][1].text)
    const d = deleteRows(m, 2, 3)!
    assert.equal(rowCount(d), 8)
    assert.equal(d.cells[2][0].text, 'v0.4')
    assert.ok(near(d.ys[d.ys.length - 1], m.ys[m.ys.length - 1] - (m.ys[4] - m.ys[2])))
    const dc = deleteColumns(m, 0, 0)!
    assert.equal(colCount(dc), 3)
    assert.equal(dc.cells[0][0].text, 'Focus')
    assert.equal(deleteRows(m, 0, 9), null, 'cannot delete every row')
    assert.equal(deleteColumns(m, 0, 3), null)
  })

  test('dragging an edge resizes the two neighbours only, and never below the minimum', () => {
    const n = moveBoundary(m, 'x', 1, m.xs[1] + 30)
    assert.ok(near(n.xs[1], m.xs[1] + 30))
    assert.deepEqual([n.xs[0], n.xs[2], n.xs[4]], [m.xs[0], m.xs[2], m.xs[4]])
    assert.ok(moveBoundary(m, 'x', 1, m.xs[0] - 500).xs[1] >= m.xs[0] + 14 - 1e-9)
    const grown = moveBoundary(m, 'x', 4, m.xs[4] + 80)
    assert.ok(near(tableBounds(grown)[2], m.xs[4] + 80), 'the right edge widens the table')
    const even = distributeColumns(m)
    const w = even.xs[1] - even.xs[0]
    even.xs.slice(1).forEach((x, i) => assert.ok(near(x - even.xs[i], w, 1e-6)))
  })

  test('a table that would run off the page is squeezed back, in proportion, and left alone otherwise', () => {
    const wide = insertColumn(m, 1, 1, 200)
    assert.ok(wide.xs[wide.xs.length - 1] > 595)
    const fitted = fitWidth(wide, 583)
    assert.ok(near(fitted.xs[fitted.xs.length - 1], 583, 1e-6))
    assert.equal(fitted.xs[0], wide.xs[0])
    const ratios = fitted.xs.slice(1).map((x, i) => (x - fitted.xs[i]) / (wide.xs[i + 1] - wide.xs[i]))
    ratios.forEach((r) => assert.ok(near(r, ratios[0], 1e-9), 'every column shrinks by the same factor'))
    assert.equal(fitWidth(m, 583), m, 'a table that fits is returned untouched')
  })

  test('recolouring and striping', () => {
    const red = mapCells(m, { r0: 1, r1: 2, c0: 0, c1: 1 }, (c) => ({ ...c, fill: [255, 0, 0] }))
    assert.deepEqual(red.cells[1][1].fill, [255, 0, 0])
    assert.deepEqual(red.cells[3][1].fill, m.cells[3][1].fill)
    const z = zebra(m, [200, 220, 255])
    assert.deepEqual(z.cells[2][0].fill, [200, 220, 255])
    assert.equal(z.cells[1][0].fill, null)
    assert.deepEqual(z.cells[0][0].fill, m.cells[0][0].fill, 'the header is left alone')
    assert.equal(setBorders(m, { innerV: false }).borders.innerV, false)
  })
})

describe('redrawing a table', () => {
  const fx = buildTablePdf()
  const original = fx.bytes
  let eng: PdfEngine
  let base: TableEdit
  before(() => {
    eng = engineFor(original)
    base = eng.detectTable(0, 200, 200).edit!
  })
  const withModel = (model: TableModel, over: Partial<TableEdit> = {}): TableEdit => ({ ...base, model, ...over })

  test('an untouched model redraws the same words in the same cells and verifies', async () => {
    const { bytes, report } = await eng.export([tableEdit('t1', base)], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const t = textOf(bytes)
    for (const row of ROADMAP) for (const cell of row) for (const word of cell.split(' ')) assert.ok(t.includes(word), `“${word}” is still on the page`)
    assert.ok(t.includes('Version Evolution Roadmap') && t.includes('Footer: the table above'), 'text outside the table is untouched')
  })

  test('the old table is really removed, not covered: no duplicated words, no ghost of the overflowing text', async () => {
    const { bytes } = await eng.export([tableEdit('t1', base)], [], OPTS)
    const words = textOf(bytes).split(' ')
    assert.equal(words.filter((w) => w === 'Clipboard').length, 1)
    assert.equal(words.filter((w) => w === 'analytics.').length, 1, 'the overflow is not left behind as a second copy')
  })

  test('border colour, border width, header fill and text colour are applied', async () => {
    let m = setBorders(base.model, { color: [220, 38, 38], width: 2 })
    m = mapCells(m, { r0: 0, r1: 0, c0: 0, c1: 3 }, (c) => ({ ...c, fill: [22, 163, 74], color: [255, 255, 0] }))
    const { bytes, report } = await eng.export([tableEdit('t2', withModel(m))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const p = pix(bytes, 4)
    const [bx0, by0, bx1] = tableBounds(m)
    const onBorder = at(p, (bx0 + bx1) / 2, by0, 4)
    assert.ok(onBorder[0] > 190 && onBorder[1] < 90, `top border is red: ${onBorder}`)
    const header = at(p, m.xs[1] + 2, m.ys[0] + 3, 4)
    assert.ok(header[1] > 140 && header[0] < 80, `header is green: ${header}`)
    const body = at(p, m.xs[1] + 2, m.ys[2] + 3, 4)
    assert.ok(body.every((v) => Math.abs(v - 243) <= 1), `body fill is unchanged: ${body}`)
  })

  test('removing borders and fills leaves no lines or backgrounds behind', async () => {
    let m = setBorders(base.model, { outer: false, innerH: false, innerV: false })
    m = mapCells(m, { r0: 0, r1: 9, c0: 0, c1: 3 }, (c) => ({ ...c, fill: null, color: [0, 0, 0] }))
    const { bytes, report } = await eng.export([tableEdit('t3', withModel(m))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const p = pix(bytes, 2)
    for (const [x, y] of [[m.xs[1], 200], [100, m.ys[0]], [m.xs[2] + 40, m.ys[3] + 2], [m.xs[1] + 3, m.ys[0] + 3]]) assert.deepEqual(at(p, x, y, 2), [255, 255, 255], `blank at ${x},${y}`)
  })

  test('add and delete rows and columns: the words follow the cells', async () => {
    let m = insertRow(base.model, 3, 2)
    m = mapCells(m, { r0: 3, r1: 3, c0: 0, c1: 0 }, (c) => ({ ...c, text: 'v0.25' }))
    m = mapCells(m, { r0: 3, r1: 3, c0: 1, c1: 1 }, (c) => ({ ...c, text: 'Brand new row' }))
    m = deleteRows(m, 5, 6)!
    m = insertColumn(m, 4, 3, 60)
    m = mapCells(m, { r0: 0, r1: 0, c0: 4, c1: 4 }, (c) => ({ ...c, text: 'Owner' }))
    m = mapCells(m, { r0: 1, r1: 1, c0: 4, c1: 4 }, (c) => ({ ...c, text: 'Priya' }))
    m = deleteColumns(m, 2, 2)!
    const { bytes, report } = await eng.export([tableEdit('t4', withModel(m))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const words = textOf(bytes).split(' ')
    for (const w of ['v0.25', 'Brand', 'row', 'Owner', 'Priya']) assert.ok(words.includes(w), w)
    assert.ok(!words.includes('Embeddings,'), 'a deleted row’s text is gone (v0.4 was deleted)')
    assert.ok(!words.includes('Rust,'), 'a deleted column’s text is gone (Core Technologies)')
    assert.ok(words.includes('Footer:'))
  })

  test('a table whose text ran past its borders is redrawn as it was: one line, same row heights', async () => {
    assert.equal(base.model.wrap, false, 'detected as unwrapped')
    const fitted = await eng.fitTable(base.model, 'grow')
    assert.deepEqual(fitted.ys, base.model.ys, 'fitting changes nothing while wrapping is off')
    const { bytes, report } = await eng.export([tableEdit('w0', base)], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    let right = 0
    mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').walk({
      onChar(_c, origin) {
        if (origin[1] > base.model.ys[2] && origin[1] < base.model.ys[3]) right = Math.max(right, origin[0])
      },
    })
    assert.ok(right > base.model.xs[4] + 20, `the long line still runs past the border (${right.toFixed(0)} > ${base.model.xs[4].toFixed(0)})`)
  })

  test('with wrapping on, long text stays inside its column and the row grows to fit', async () => {
    const m = mapCells({ ...base.model, wrap: true }, { r0: 1, r1: 1, c0: 3, c1: 3 }, (c) => ({ ...c, text: 'Capture and search the whole clipboard history, including images, files and formatted text, offline.' }))
    const fitted = await eng.fitTable(m, 'grow')
    assert.ok(fitted.ys[2] - fitted.ys[1] > m.ys[2] - m.ys[1] + 15, 'row 1 got taller')
    assert.ok(near(fitted.ys[1] - fitted.ys[0], m.ys[1] - m.ys[0], 1e-6), 'the header, whose text fits, keeps its height')
    const { bytes, report } = await eng.export([tableEdit('t5', withModel(fitted))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    // wrapped inside the cell: every character of the sentence sits within the column
    const doc = mupdf.Document.openDocument(bytes.slice(), 'application/pdf')
    let maxX = 0
    doc.loadPage(0).toStructuredText('preserve-whitespace').walk({
      onChar(_c, origin) {
        if (origin[1] > fitted.ys[1] && origin[1] < fitted.ys[2]) maxX = Math.max(maxX, origin[0])
      },
    })
    assert.ok(maxX <= fitted.xs[4] + 0.5, `text stays inside the last column (max x ${maxX.toFixed(1)} vs ${fitted.xs[4].toFixed(1)})`)
    assert.ok(textOf(bytes).includes('offline.'))
    const exact = await eng.fitTable(fitted, 'exact')
    assert.ok(exact.ys[exact.ys.length - 1] < fitted.ys[fitted.ys.length - 1], '"exact" shrinks the roomy rows back down')
  })

  test('the on-screen render equals the exported page, pixel for pixel', async () => {
    let m = setBorders(base.model, { color: [37, 99, 235], width: 1.5 })
    m = zebra(m, [219, 234, 254])
    m = insertColumn(m, 2, 1, 70)
    const edit = tableEdit('t6', withModel(m))
    const preview = await eng.render(0, 2, [edit])
    const { bytes } = await eng.export([edit], [], OPTS)
    const p = pix(bytes, 2)
    assert.equal(preview.width, p.w)
    let diff = 0
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) for (let c = 0; c < 3; c++) diff += Math.abs(preview.rgba[(y * p.w + x) * 4 + c] - p.d[y * p.stride + x * p.n + c])
    assert.equal(diff, 0)
  })

  test('deleting the table removes every line, fill and word of it and nothing else', async () => {
    const { bytes, report } = await eng.export([tableEdit('t7', withModel(base.model, { deleted: true }))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    const t = textOf(bytes)
    assert.ok(!t.includes('Clipboard') && !t.includes('analytics') && !t.includes('Core') && !t.includes('v0.3'), t)
    assert.ok(t.includes('Version Evolution Roadmap'), 'the title above the table stays')
    assert.ok(t.includes('Footer:'), 'the footer below it stays')
    const p = pix(bytes, 2)
    assert.deepEqual(at(p, 300, 200, 2), [255, 255, 255])
  })

  test('everything outside the table is pixel-identical after an edit', async () => {
    const m = setBorders(base.model, { color: [0, 0, 0], width: 1 })
    const { bytes } = await eng.export([tableEdit('t8', withModel(m))], [], OPTS)
    const a = pix(original, 2)
    const b = pix(bytes, 2)
    const [x0, y0, x1, y1] = tableBounds(m)
    const zone = [x0 - 12, y0 - 6, x1 + 130, y1 + 6] // box + the overflow
    let stray = 0
    for (let y = 0; y < a.h; y++) {
      for (let x = 0; x < a.w; x++) {
        if (x / 2 >= zone[0] && x / 2 <= zone[2] && y / 2 >= zone[1] && y / 2 <= zone[3]) continue
        const o = y * a.stride + x * a.n
        if (Math.abs(a.d[o] - b.d[o]) > 8) stray++
      }
    }
    assert.equal(stray, 0, 'the title and footer are exactly as before')
  })

  test('verification catches a table that was claimed but not drawn', async () => {
    const m = mapCells(base.model, { r0: 1, r1: 1, c0: 1, c1: 1 }, (c) => ({ ...c, text: 'Something else' }))
    const report = await eng.verify(original, [tableEdit('t9', withModel(m))], [], OPTS)
    assert.equal(report.ok, false)
    assert.equal(report.passed, 0)
  })

  test('verification catches border colours that did not make it into the file', async () => {
    const wanted = setBorders(base.model, { color: [220, 38, 38], width: 2 })
    // export with grey borders, but claim red ones
    const grey = await eng.export([tableEdit('t10', withModel(setBorders(base.model, { width: 2 })))], [], OPTS)
    const report = await eng.verify(grey.bytes, [tableEdit('t10', withModel(wanted))], [], OPTS)
    assert.equal(report.ok, false)
    assert.match(report.pages[0].edits[0].actual, /border/)
  })

  test('a word wider than its column is reported (it sticks out) but is not a failure', async () => {
    let m = mapCells(base.model, { r0: 1, r1: 1, c0: 0, c1: 0 }, (c) => ({ ...c, text: 'Supercalifragilistic' }))
    m = await eng.fitTable(m, 'grow')
    const { report } = await eng.export([tableEdit('t11', withModel(m))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.match(report.pages[0].edits[0].warning ?? '', /wider than its column/)
  })

  test('a table that grows onto text below it is verified, with a warning that names the clash', async () => {
    // give the table so much to say that it reaches the footer
    let m: TableModel = { ...base.model, wrap: true }
    for (let r = 1; r < rowCount(m); r++) m = mapCells(m, { r0: r, r1: r, c0: 3, c1: 3 }, (c) => ({ ...c, text: `${c.text} — and a good deal more detail about this release that needs several lines in a narrow column` }))
    m = await eng.fitTable(m, 'grow')
    assert.ok(tableBounds(m)[3] > fx.ys[fx.ys.length - 1] + 90, 'the table now reaches the footer')
    const { report } = await eng.export([tableEdit('t12', withModel(m))], [], OPTS)
    assert.equal(report.ok, true, JSON.stringify(report, null, 1))
    assert.match(report.pages[0].edits[0].warning ?? '', /runs into text that was already on the page/)
  })

  test('a table pushed off the page is reported in plain words, not as a text mismatch', async () => {
    const wide = insertColumn(base.model, 1, 1, 200) // the right edge is now past x = 595
    const { report } = await eng.export([tableEdit('off', withModel(wide))], [], OPTS)
    assert.equal(report.ok, false)
    assert.match(report.pages[0].edits[0].actual, /runs off the edge of the page/)
  })

  test('re-editing a saved table keeps working (second round trip)', async () => {
    const first = await eng.export([tableEdit('a', withModel(setBorders(base.model, { color: [220, 38, 38] })))], [], OPTS)
    const again = engineFor(first.bytes)
    const found = again.detectTable(0, 200, 200).edit!
    assert.equal(rowCount(found.model), 10)
    assert.deepEqual(found.model.borders.color, [220, 38, 38], 'its new border colour is what is read back')
    assert.equal(found.model.cells[2][3].text, 'Support rich content, timeline, backup, analytics.')
    const second = await again.export([tableEdit('b', found)], [], OPTS)
    assert.equal(second.report.ok, true, JSON.stringify(second.report, null, 1))
  })
})

describe('tables on pages where they cannot be edited', () => {
  test('a scanned page says so instead of guessing', () => {
    const eng = engineFor(new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/invoice-scan.pdf'))))
    assert.deepEqual(eng.detectTable(0, 200, 200), { edit: null, reason: 'scan' })
  })
  test('the invoice sample is not mistaken for a ruled table', () => {
    const eng = engineFor(new Uint8Array(fs.readFileSync(path.join(ROOT, 'tests/fixtures/invoice-text.pdf'))))
    const r = eng.detectTable(0, 300, 300)
    // The invoice has filled bands but no ruled grid: either nothing is found, or what is found is sane.
    if (r.edit) assert.ok(rowCount(r.edit.model) >= 1 && colCount(r.edit.model) >= 2)
  })
  test('cell padding is applied to the left edge of left-aligned text', async () => {
    const fx = buildTablePdf()
    const eng = engineFor(fx.bytes)
    const base = eng.detectTable(0, 200, 200).edit!
    const { bytes } = await eng.export([tableEdit('p', base)], [], OPTS)
    let minX = Infinity
    mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').walk({
      onChar(c, origin) {
        if (c === 'v' && origin[1] > base.model.ys[1] && origin[1] < base.model.ys[2]) minX = Math.min(minX, origin[0])
      },
    })
    assert.ok(near(minX, cellRect(base.model, 1, 0)[0] + CELL_PAD_X, 0.8), `text starts ${(minX - base.model.xs[0]).toFixed(1)}pt inside the cell`)
  })
})
