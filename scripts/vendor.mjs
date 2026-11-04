// Copies the runtime assets PageDesk needs into public/ so the app works fully
// offline: fallback fonts, the Tesseract worker + WASM cores, and the English
// OCR model. Idempotent; safe to run on every dev/build.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nm = (...p) => path.join(root, 'node_modules', ...p)
const pub = (...p) => path.join(root, 'public', ...p)

function copy(src, dest) {
  if (!fs.existsSync(src)) { console.warn('[vendor] missing', src); return }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest) && fs.statSync(dest).size === fs.statSync(src).size) return
  fs.copyFileSync(src, dest)
}

// 1. Unicode fallback fonts (Latin/Greek/Cyrillic/₹ etc.) for glyphs the base-14 fonts lack.
const fontFiles = [
  'DejaVuSans', 'DejaVuSans-Bold', 'DejaVuSans-Oblique', 'DejaVuSans-BoldOblique',
  'DejaVuSerif', 'DejaVuSerif-Bold', 'DejaVuSerif-Italic', 'DejaVuSerif-BoldItalic',
  'DejaVuSansMono', 'DejaVuSansMono-Bold', 'DejaVuSansMono-Oblique', 'DejaVuSansMono-BoldOblique',
]
for (const f of fontFiles) copy(nm('dejavu-fonts-ttf', 'ttf', `${f}.ttf`), pub('fonts', `${f}.ttf`))

// 2. Tesseract runtime.
copy(nm('tesseract.js', 'dist', 'worker.min.js'), pub('tesseract', 'worker.min.js'))
const coreDir = nm('tesseract.js-core')
if (fs.existsSync(coreDir)) {
  for (const f of fs.readdirSync(coreDir)) {
    if (/-lstm\.wasm\.js$/.test(f)) copy(path.join(coreDir, f), pub('tesseract', f))
  }
}

// 3. English OCR model (tessdata_fast, ~4 MB). Other languages load on demand.
const eng = pub('tessdata', 'eng.traineddata')
if (!fs.existsSync(eng) || fs.statSync(eng).size < 1_000_000) {
  try {
    const res = await fetch('https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    fs.mkdirSync(path.dirname(eng), { recursive: true })
    fs.writeFileSync(eng, Buffer.from(await res.arrayBuffer()))
    console.log('[vendor] downloaded eng.traineddata')
  } catch (e) {
    console.warn('[vendor] could not download eng.traineddata — OCR will fetch it from the CDN at runtime:', String(e))
  }
}
