import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { PdfEngine } from '../src/engine/engine.ts'
import type { Edit, ExportOptions } from '../src/engine/types.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FX = path.join(ROOT, 'tests', 'fixtures')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const read = (n: string) => new Uint8Array(fs.readFileSync(path.join(FX, n)))
const OPTS: ExportOptions = { textLayer: true, jpegQuality: 88 }
const STYLE = { family: 'sans', bold: false, italic: false, size: 12, color: [0, 0, 0] } as Edit['style']

/** an encrypted copy of the invoice */
function locked(password: string): Uint8Array {
  const doc = mupdf.Document.openDocument(read('invoice-text.pdf').slice(), 'application/pdf') as mupdf.PDFDocument
  return doc.saveToBuffer(`encrypt=aes-128,user-password=${password},owner-password=${password}`).asUint8Array().slice()
}

test('a file that cannot be opened leaves the open file exactly as it was', async () => {
  const eng = new PdfEngine(loader)
  const first = eng.open(read('invoice-text.pdf'))
  assert.equal(first.status, 'ok')
  const runs = eng.getRuns(0)
  assert.ok(runs.length > 10)

  for (const bad of [new TextEncoder().encode('this is definitely not a pdf'), new Uint8Array(0), read('invoice-scan-src.png')]) {
    const r = eng.open(bad)
    assert.equal(r.status, 'error')
    // the first file is still open and fully usable: reading, rendering and saving all work
    assert.equal(eng.getRuns(0).length, runs.length)
    const picture = await eng.render(0, 1, [])
    assert.ok(picture.width > 100)
    const edit: Edit = { id: 'a', page: 0, kind: 'add', text: 'still here', style: STYLE, x: 60, baseline: 600 }
    const { report, bytes } = await eng.export([edit], [], OPTS)
    assert.equal(report.ok, true)
    assert.ok(mupdf.Document.openDocument(bytes.slice(), 'application/pdf').loadPage(0).toStructuredText('preserve-whitespace').asText().includes('still here'))
  }
})

test('a file that is waiting for its password does not close the open file; the right password replaces it', () => {
  const eng = new PdfEngine(loader)
  eng.open(read('invoice-text.pdf'))
  const before = eng.getRuns(0).length
  const enc = locked('s3cret-pw')
  assert.equal(eng.open(enc).status, 'password')
  assert.equal(eng.open(enc, 'wrong').status, 'password')
  assert.equal(eng.getRuns(0).length, before, 'the first file is untouched while the password is asked for')
  const ok = eng.open(enc, 's3cret-pw')
  assert.equal(ok.status, 'ok')
  assert.equal(eng.getRuns(0).length, before, 'and now the unlocked copy is the one that is open')
})

test('pictures placed on one document are let go when another one opens — but not when the open fails', () => {
  const eng = new PdfEngine(loader)
  eng.open(read('invoice-text.pdf'))
  eng.addImage('logo', read('invoice-scan-src.png'))
  const held = () => (eng as unknown as { images: Map<string, unknown> }).images.size
  assert.equal(held(), 1)
  assert.equal(eng.open(new TextEncoder().encode('nope')).status, 'error')
  assert.equal(held(), 1, 'a failed open changes nothing')
  assert.equal(eng.open(read('table-roadmap.pdf')).status, 'ok')
  assert.equal(held(), 0, 'a successful one starts clean')
  eng.dispose()
  assert.equal(held(), 0)
})
