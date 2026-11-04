// Builds test PDFs: a searchable invoice (Chromium print-to-PDF => embedded subset fonts)
// and a "scanned" version (screenshot embedded as a bare image, no text layer).
import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

import { fileURLToPath } from "node:url"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = process.argv[2] ?? path.join(ROOT, "tests", "fixtures")
fs.mkdirSync(OUT, { recursive: true })
const { chromium } = await import(pathToFileURL(`${ROOT}/node_modules/playwright-core/index.mjs`).href)
const mupdf = await import(pathToFileURL(`${ROOT}/node_modules/mupdf/dist/mupdf.js`).href)

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 0 }
body { margin: 0; padding: 56px 64px; font-family: Arial, Helvetica, sans-serif; font-size: 13px; color: #1a1a1a; width: 595px; box-sizing: content-box }
h1 { font-family: Georgia, 'Times New Roman', serif; font-size: 26px; margin: 0 0 4px; color: #123a6b }
.sub { color: #666; margin-bottom: 22px }
.row { display:flex; justify-content: space-between; margin-bottom: 4px }
table { border-collapse: collapse; width: 100%; margin-top: 18px }
th { background: #e8eef7; text-align: left; padding: 7px 9px; font-size: 12px; border-bottom: 2px solid #123a6b }
td { padding: 7px 9px; border-bottom: 1px solid #d5d5d5 }
td.n, th.n { text-align: right }
.total { background: #fff4d6 }
.mono { font-family: 'Courier New', monospace; font-size: 12px }
p { line-height: 1.25; margin: 14px 0 0 }
</style></head><body>
<h1>Invoice INV-2026-0417</h1>
<div class="sub">Sundaram Traders Pvt Ltd · Kochi, Kerala</div>
<div class="row"><span><b>Billed to:</b> Meera Nair</span><span><b>Date:</b> 04 November 2026</span></div>
<div class="row"><span><b>GSTIN:</b> <span class="mono">32ABCDE1234F1Z5</span></span><span><b>Due:</b> 18 November 2026</span></div>
<table>
<tr><th>Item</th><th class="n">Qty</th><th class="n">Rate</th><th class="n">Amount</th></tr>
<tr><td>Lithium battery pack 48V</td><td class="n">4</td><td class="n">₹ 12,500.00</td><td class="n">₹ 50,000.00</td></tr>
<tr><td>Charger unit (fast)</td><td class="n">2</td><td class="n">₹ 3,200.00</td><td class="n">₹ 6,400.00</td></tr>
<tr><td>Installation &amp; testing</td><td class="n">1</td><td class="n">₹ 4,500.00</td><td class="n">₹ 4,500.00</td></tr>
<tr class="total"><td><b>Total payable</b></td><td></td><td></td><td class="n"><b>₹ 60,900.00</b></td></tr>
</table>
<p>Payment is due within fourteen days of the invoice date. Late payments attract interest at 1.5% per month. Goods once sold will not be taken back without prior written approval.</p>
<p>Bank: State Bank of India · A/C <span class="mono">00112233445</span> · IFSC <span class="mono">SBIN0001234</span></p>
</body></html>`

function findChrome() {
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p } catch {}
  const base = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", "AppData", "Local", "ms-playwright")
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse() : []
  for (const d of dirs) { const p = path.join(base, d, "chrome-win64", "chrome.exe"); if (fs.existsSync(p)) return p }
  return undefined
}
const browser = await chromium.launch({ executablePath: findChrome() })
const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 2.0833 }) // ~200dpi
await page.setContent(html)
await page.pdf({ path: path.join(OUT, 'invoice-text.pdf'), format: 'A4', printBackground: true })
const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 794, height: 1123 } })
fs.writeFileSync(path.join(OUT, 'invoice-scan-src.png'), png)
await browser.close()

// Make a "scanned" PDF: A4 page with a single JPEG, no text at all. Add mild noise/blur via a pixmap pass.
const pix = new mupdf.Image(png).toPixmap()
const rgb = pix.convertToColorSpace(mupdf.ColorSpace.DeviceRGB)
const w = rgb.getWidth(), h = rgb.getHeight(), n = rgb.getNumberOfComponents(), px = rgb.getPixels(), stride = rgb.getStride()
let seed = 12345
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = y * stride + x * n
  const warm = 6 // slightly warm paper tint
  const noise = (rnd() - 0.5) * 14
  px[i] = Math.max(0, Math.min(255, px[i] - 2 + noise))
  px[i + 1] = Math.max(0, Math.min(255, px[i + 1] - warm / 2 + noise))
  px[i + 2] = Math.max(0, Math.min(255, px[i + 2] - warm + noise))
}
const jpg = rgb.asJPEG(82)
fs.writeFileSync(path.join(OUT, 'invoice-scan.jpg'), jpg)
const doc = new mupdf.PDFDocument()
const img = doc.addImage(new mupdf.Image(jpg))
const res = doc.addObject(doc.newDictionary())
const xo = doc.newDictionary(); xo.put('Im0', img); res.put('XObject', xo)
const W = 595.28, H = 841.89
const page0 = doc.addPage([0, 0, W, H], 0, res, `q ${W} 0 0 ${H} 0 0 cm /Im0 Do Q`)
doc.insertPage(-1, page0)
fs.writeFileSync(path.join(OUT, 'invoice-scan.pdf'), doc.saveToBuffer('compress').asUint8Array())
console.log('fixtures written', OUT, 'image', w, 'x', h)
