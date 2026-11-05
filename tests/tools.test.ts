import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as mupdf from 'mupdf'
import { FontBook } from '../src/engine/fonts.ts'
import { PdfTools, type NumberPosition, type PdfSource } from '../src/engine/tools.ts'
import { formatRanges, parseRanges } from '../src/engine/ranges.ts'
import { crc32, zip } from '../src/engine/zip.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FX = path.join(ROOT, 'tests', 'fixtures')
const loader = async (file: string) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', file)))
const tools = new PdfTools(new FontBook(loader))
const read = (name: string) => new Uint8Array(fs.readFileSync(path.join(FX, name)))
const text: PdfSource = { bytes: read('invoice-text.pdf') }
const scan: PdfSource = { bytes: read('invoice-scan.pdf') }

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
function pageText(bytes: Uint8Array, page = 0, password?: string): string {
  const d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf')
  if (d.needsPassword()) assert.ok(password && d.authenticatePassword(password), 'password accepted')
  return squash(d.loadPage(page).toStructuredText('preserve-whitespace').asText())
}
function rotationOf(bytes: Uint8Array, page: number): number {
  const d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf').asPDF()!
  const r = d.findPage(page).getInheritable('Rotate')
  return r.isNumber() ? r.asNumber() : 0
}
function ok(src: PdfSource) {
  const r = tools.inspect(src)
  assert.equal(r.status, 'ok')
  return r as Extract<ReturnType<PdfTools['inspect']>, { status: 'ok' }>
}

describe('page ranges', () => {
  test('numbers, ranges and open ends (1-based in, 0-based out)', () => {
    assert.deepEqual(parseRanges('1-3, 5', 9).pages, [0, 1, 2, 4])
    assert.deepEqual(parseRanges('7-', 9).pages, [6, 7, 8])
    assert.deepEqual(parseRanges('-2', 9).pages, [0, 1])
    assert.deepEqual(parseRanges('1 - 3', 9).pages, [0, 1, 2])
  })
  test('order is kept, so ranges can re-order or reverse', () => {
    assert.deepEqual(parseRanges('3,1,2', 5).pages, [2, 0, 1])
    assert.deepEqual(parseRanges('4-2', 5).pages, [3, 2, 1])
  })
  test('all / odd / even', () => {
    assert.deepEqual(parseRanges('all', 3).pages, [0, 1, 2])
    assert.deepEqual(parseRanges('odd', 5).pages, [0, 2, 4])
    assert.deepEqual(parseRanges('even', 5).pages, [1, 3])
  })
  test('bad input explains itself instead of guessing', () => {
    assert.match(parseRanges('', 5).error ?? '', /Type the pages/)
    assert.match(parseRanges('0', 5).error ?? '', /outside/)
    assert.match(parseRanges('6', 5).error ?? '', /outside this document \(it has 5 pages\)/)
    assert.match(parseRanges('abc', 5).error ?? '', /isn’t a page number/)
    assert.match(parseRanges('-', 5).error ?? '', /isn’t a page number/)
  })
  test('formatRanges collapses runs', () => {
    assert.equal(formatRanges([0, 1, 2, 4, 6, 7]), '1-3, 5, 7-8')
  })
})

describe('zip', () => {
  test('writes a readable archive with correct CRCs', () => {
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926) // the standard check value
    const files = [
      { name: 'page-1.png', data: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: 'ünï.txt', data: new TextEncoder().encode('hello') },
    ]
    const z = zip(files)
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength)
    const eocd = z.length - 22
    assert.equal(dv.getUint32(eocd, true), 0x06054b50)
    assert.equal(dv.getUint16(eocd + 10, true), 2)
    let p = dv.getUint32(eocd + 16, true)
    for (const f of files) {
      assert.equal(dv.getUint32(p, true), 0x02014b50)
      assert.equal(dv.getUint32(p + 16, true), crc32(f.data))
      const nameLen = dv.getUint16(p + 28, true)
      const local = dv.getUint32(p + 42, true)
      assert.equal(new TextDecoder().decode(z.subarray(p + 46, p + 46 + nameLen)), f.name)
      assert.equal(dv.getUint32(local, true), 0x04034b50)
      const data = z.subarray(local + 30 + nameLen, local + 30 + nameLen + f.data.length)
      assert.deepEqual([...data], [...f.data])
      p += 46 + nameLen
    }
  })
})

describe('merge', () => {
  test('joins files in order and keeps each page’s text', () => {
    const r = tools.merge([text, scan, text])
    assert.equal(r.pages, 3)
    assert.equal(ok({ bytes: r.bytes }).pages, 3)
    assert.equal(pageText(r.bytes, 0), pageText(text.bytes, 0))
    assert.equal(pageText(r.bytes, 2), pageText(text.bytes, 0))
    assert.equal(pageText(r.bytes, 1), pageText(scan.bytes, 0)) // a scan has no text: both empty
  })
  test('shared resources are copied once, not once per use', () => {
    const one = tools.merge([text]).bytes.length
    const three = tools.merge([text, text, text]).bytes.length
    assert.ok(three < one * 3, `3 copies (${three}) should be < 3 × one copy (${one * 3})`)
  })
  test('refuses an encrypted source without its password, accepts it with', () => {
    const locked = tools.protect(text, 'sesame').bytes
    assert.throws(() => tools.merge([{ bytes: locked }]), /password/i)
    assert.equal(tools.merge([{ bytes: locked, password: 'sesame' }]).pages, 1)
  })
})

describe('rebuild (delete / extract / reorder / rotate / duplicate)', () => {
  const three = tools.merge([text, scan, text]).bytes

  test('extract a subset in the order asked', () => {
    const r = tools.rebuild({ bytes: three }, [{ src: 2 }, { src: 1 }])
    assert.equal(r.pages, 2)
    assert.equal(pageText(r.bytes, 0), pageText(text.bytes, 0))
    assert.equal(pageText(r.bytes, 1), '')
  })
  test('delete = keep everything else', () => {
    const r = tools.rebuild({ bytes: three }, [{ src: 0 }, { src: 2 }])
    assert.equal(r.pages, 2)
    assert.equal(pageText(r.bytes, 1), pageText(text.bytes, 0))
  })
  test('rotation adds to the page’s own rotation and wraps; sizes swap for quarter turns', () => {
    const before = ok({ bytes: three }).sizes[0]
    const r = tools.rebuild({ bytes: three }, [{ src: 0, rotate: 90 }, { src: 0, rotate: -90 }, { src: 0, rotate: 180 }, { src: 0, rotate: 360 }, { src: 0 }])
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => rotationOf(r.bytes, i)), [90, 270, 180, 0, 0])
    const sizes = ok({ bytes: r.bytes }).sizes
    assert.ok(Math.abs(sizes[0].width - before.height) < 0.01 && Math.abs(sizes[0].height - before.width) < 0.01, 'quarter turn swaps width and height')
    assert.ok(Math.abs(sizes[2].width - before.width) < 0.01, 'half turn keeps them')
    // turning an already-turned page stacks
    const twice = tools.rebuild({ bytes: r.bytes }, [{ src: 0, rotate: 90 }])
    assert.equal(rotationOf(twice.bytes, 0), 180)
  })
  test('duplicate a page', () => {
    const r = tools.rebuild({ bytes: three }, [{ src: 0 }, { src: 0 }, { src: 0 }])
    assert.equal(r.pages, 3)
    assert.equal(pageText(r.bytes, 2), pageText(text.bytes, 0))
  })
  test('rotating does not alter the text on the page', () => {
    const r = tools.rebuild(text, [{ src: 0, rotate: 90 }])
    assert.equal(pageText(r.bytes, 0), pageText(text.bytes, 0))
  })
  test('rejects nothing-to-keep and out-of-range pages', () => {
    assert.throws(() => tools.rebuild(text, []), /at least one page/)
    assert.throws(() => tools.rebuild(text, [{ src: 5 }]), /does not exist/)
  })
})

describe('images → PDF', () => {
  const jpg = read('invoice-scan.jpg')
  const png = read('invoice-scan-src.png')

  test('one page per picture, in order, and the picture is really there', () => {
    const r = tools.imagesToPdf([{ name: 'a.jpg', bytes: jpg }, { name: 'b.png', bytes: png }], { size: 'fit', margin: 0 })
    assert.equal(r.pages, 2)
    const d = mupdf.Document.openDocument(r.bytes.slice(), 'application/pdf')
    const pm = d.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false)
    const px = pm.getPixels()
    let dark = 0
    for (let i = 0; i < px.length; i += 3) if (px[i] < 100) dark++
    assert.ok(dark > 200, 'page 1 shows the scanned invoice, not a blank page')
  })
  test('"fit" matches the picture’s shape and never exceeds A4', () => {
    const r = tools.imagesToPdf([{ name: 'a.jpg', bytes: jpg }], { size: 'fit', margin: 0 })
    const { sizes } = ok({ bytes: r.bytes })
    const img = new mupdf.Image(jpg.slice())
    assert.ok(Math.abs(sizes[0].width / sizes[0].height - img.getWidth() / img.getHeight()) < 0.01)
    assert.ok(sizes[0].width <= 842.1 && sizes[0].height <= 842.1)
  })
  test('A4 and Letter centre the picture on the paper', () => {
    const a4 = ok({ bytes: tools.imagesToPdf([{ name: 'a', bytes: jpg }], { size: 'a4', margin: 20 }).bytes }).sizes[0]
    assert.ok(Math.abs(a4.width - 595.28) < 0.1 && Math.abs(a4.height - 841.89) < 0.1)
    const lt = ok({ bytes: tools.imagesToPdf([{ name: 'a', bytes: jpg }], { size: 'letter', margin: 0 }).bytes }).sizes[0]
    assert.ok(Math.abs(lt.width - 612) < 0.1 && Math.abs(lt.height - 792) < 0.1)
  })
  test('a file that is not a picture is named in the error', () => {
    assert.throws(() => tools.imagesToPdf([{ name: 'notes.txt', bytes: new TextEncoder().encode('hello') }], { size: 'fit', margin: 0 }), /notes\.txt/)
  })
})

describe('passwords', () => {
  test('protect → needs the password; text survives; unlock → opens freely', () => {
    const locked = tools.protect(text, 'p4ss word').bytes
    assert.equal(tools.inspect({ bytes: locked }).status, 'password')
    assert.equal(tools.inspect({ bytes: locked, password: 'wrong' }).status, 'password')
    const good = tools.inspect({ bytes: locked, password: 'p4ss word' })
    assert.equal(good.status, 'ok')
    assert.equal((good as { encrypted: boolean }).encrypted, true)
    assert.equal(pageText(locked, 0, 'p4ss word'), pageText(text.bytes, 0))

    const open = tools.unlock({ bytes: locked, password: 'p4ss word' }).bytes
    assert.equal(tools.inspect({ bytes: open }).status, 'ok')
    assert.equal((tools.inspect({ bytes: open }) as { encrypted: boolean }).encrypted, false)
    assert.equal(pageText(open, 0), pageText(text.bytes, 0))
  })
  test('unlock needs the right password', () => {
    const locked = tools.protect(text, 'abc123').bytes
    assert.throws(() => tools.unlock({ bytes: locked, password: 'nope' }), /didn’t work/)
    assert.throws(() => tools.unlock({ bytes: locked }), /password protected/)
  })
  test('symbols, spaces, = and non-ASCII letters round-trip', () => {
    for (const pw of ['a=b=c', 'sp ace', 'p@$$-w0rd!#%^&*()', 'pässwörd₹']) {
      const locked = tools.protect(text, pw).bytes
      assert.equal(tools.inspect({ bytes: locked, password: pw }).status, 'ok', pw)
      assert.equal(tools.inspect({ bytes: locked, password: pw.slice(0, -1) }).status, 'password', pw)
    }
  })
  test('a comma is refused up front (MuPDF reads it as the next save option)', () => {
    assert.throws(() => tools.protect(text, 'a,b'), /comma/)
  })
  test('empty password is refused', () => {
    assert.throws(() => tools.protect(text, ''), /password/i)
  })
})

describe('stamps', () => {
  const base = pageText(text.bytes, 0)
  const numbers = { format: 'Page {n} of {N}', position: 'bottom-center' as const, size: 10, start: 1, margin: 24, color: [0, 0, 0] as [number, number, number], skipFirst: false }

  test('page numbers appear on every page and nothing else changes', async () => {
    const two = tools.merge([text, text]).bytes
    const r = await tools.stamp({ bytes: two }, { numbers })
    assert.equal(r.pages, 2)
    assert.equal(pageText(r.bytes, 0), `${base} Page 1 of 2`)
    assert.equal(pageText(r.bytes, 1), `${base} Page 2 of 2`)
  })
  test('start number and skip-first', async () => {
    const two = tools.merge([text, text]).bytes
    const r = await tools.stamp({ bytes: two }, { numbers: { ...numbers, format: '{n}', start: 10, skipFirst: true } })
    assert.equal(pageText(r.bytes, 0), base)
    assert.equal(pageText(r.bytes, 1), `${base} 11`)
  })
  test('number sits where asked (bottom-right is right of centre, top is above bottom)', async () => {
    async function where(position: NumberPosition) {
      // '§' appears nowhere in the invoice, so the first one found is our stamp
      const r = await tools.stamp(text, { numbers: { ...numbers, format: '§§§', position } })
      const d = mupdf.Document.openDocument(r.bytes.slice(), 'application/pdf')
      let box: number[] | null = null
      d.loadPage(0).toStructuredText('preserve-whitespace').walk({
        onChar(c, _o, _f, _s, quad) {
          if (c === '§' && !box) box = [...quad]
        },
      })
      assert.ok(box, 'found the stamp')
      return { x: (box![0] + box![2]) / 2, y: (box![1] + box![5]) / 2 }
    }
    const [bc, br, bl, tc] = [await where('bottom-center'), await where('bottom-right'), await where('bottom-left'), await where('top-center')]
    assert.ok(br.x > bc.x && bc.x > bl.x)
    assert.ok(tc.y < bc.y)
  })
  test('a watermark is drawn, rotated, with its opacity in the file', async () => {
    const r = await tools.stamp(text, { watermark: { text: 'CONFIDENTIAL', size: 60, opacity: 0.2, angle: 45, color: [200, 0, 0] } })
    assert.match(pageText(r.bytes, 0), /CONFIDENTIAL/)
    const d = mupdf.Document.openDocument(r.bytes.slice(), 'application/pdf').asPDF()!
    const states = d.findPage(0).getInheritable('Resources').get('ExtGState')
    let gs: mupdf.PDFObject | null = null
    states.forEach((v, k) => {
      if (String(k).startsWith('PDStG')) gs = v
    })
    assert.ok(gs, 'the watermark has its own graphics state')
    assert.ok(Math.abs((gs as mupdf.PDFObject).get('ca').asNumber() - 0.2) < 1e-6)
    // rotated: the first and last letters differ in y by a lot
    const ys: number[] = []
    d.loadPage(0).toStructuredText('preserve-whitespace').walk({
      onChar(c, _o, _f, _s, quad) {
        if ('CONFIDENTIAL'.includes(c) && quad[1] < 700) ys.push(quad[1])
      },
    })
    assert.ok(Math.max(...ys) - Math.min(...ys) > 200, 'text climbs across the page')
  })
  test('watermark is centred on the page', async () => {
    const r = await tools.stamp(text, { watermark: { text: 'DRAFT', size: 80, opacity: 0.3, angle: 0, color: [128, 128, 128] } })
    const d = mupdf.Document.openDocument(r.bytes.slice(), 'application/pdf')
    const [x0, y0, x1, y1] = d.loadPage(0).getBounds()
    const xs: number[] = []
    const ys: number[] = []
    d.loadPage(0).toStructuredText('preserve-whitespace').walk({
      onChar(c, _o, _f, _s, quad) {
        if ('DRAFT'.includes(c) && quad[1] > 200 && quad[1] < 700 && quad[2] - quad[0] > 20) {
          xs.push(quad[0], quad[2])
          ys.push(quad[1], quad[5])
        }
      },
    })
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    assert.ok(Math.abs(cx - (x0 + x1) / 2) < 12, `x centre ${cx}`)
    assert.ok(Math.abs(cy - (y0 + y1) / 2) < 25, `y centre ${cy}`)
  })
  test('₹ and other non-WinAnsi characters use the bundled fallback font', async () => {
    const r = await tools.stamp(text, { numbers: { ...numbers, format: '₹ {n}' } })
    assert.ok(pageText(r.bytes, 0).endsWith('₹ 1'))
    assert.equal(r.warnings, undefined)
  })
  test('characters no font can draw are reported, not silently dropped', async () => {
    const r = await tools.stamp(text, { numbers: { ...numbers, format: '{n} ௮' } })
    assert.ok(r.warnings?.some((w) => w.includes('௮')))
  })
  test('stamping an already-stamped file does not break the earlier stamp', async () => {
    const a = await tools.stamp(text, { numbers: { ...numbers, format: 'first' } })
    const b = await tools.stamp({ bytes: a.bytes }, { numbers: { ...numbers, format: 'second', position: 'top-center' } })
    const t = pageText(b.bytes, 0)
    assert.ok(t.includes('first') && t.includes('second'))
  })
  test('a second stamp pass never changes the fonts the first one used, even when they differ', async () => {
    // "₹" comes from the bundled DejaVu font, the rest from Helvetica — and the second pass uses Helvetica only
    const a = await tools.stamp(text, { numbers: { ...numbers, format: '₹ first' } })
    const b = await tools.stamp({ bytes: a.bytes }, { numbers: { ...numbers, format: 'second', position: 'top-center' } })
    const t = pageText(b.bytes, 0)
    assert.ok(t.includes('₹') && t.includes('first') && t.includes('second'), 'the rupee sign of the first pass is still a rupee sign: ' + JSON.stringify(t.slice(-60)))
    const fonts = (bytes: Uint8Array) => {
      const d = mupdf.Document.openDocument(bytes.slice(), 'application/pdf') as mupdf.PDFDocument
      const f = d.findPage(0).getInheritable('Resources').get('Font')
      const names: string[] = []
      f.forEach((_v, k) => void names.push(String(k)))
      return names.filter((n) => n.startsWith('PDSt'))
    }
    assert.equal(new Set(fonts(b.bytes)).size, fonts(b.bytes).length)
    assert.ok(fonts(b.bytes).length > fonts(a.bytes).length, 'the second pass added its own font entries instead of replacing the first pass’s')
  })
  test('works on a scanned page (no text) too', async () => {
    const r = await tools.stamp(scan, { numbers: { ...numbers, format: 'p{n}' }, watermark: { text: 'COPY', size: 50, opacity: 0.2, angle: 30, color: [0, 0, 0] } })
    assert.ok(pageText(r.bytes, 0).includes('p1'))
    assert.ok(pageText(r.bytes, 0).includes('COPY'))
  })
  test('preview renders a PNG of the stamped page without touching the source', async () => {
    const p = await tools.stampPreview(text, { numbers }, 0, 400)
    assert.deepEqual([...p.png.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.ok(Math.abs(p.width - 400) <= 1)
    assert.equal(pageText(text.bytes, 0), base)
  })
})
