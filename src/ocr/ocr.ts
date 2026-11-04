import { createWorker } from 'tesseract.js'
import type { OcrWord, PngResult, Rgb, TextRun } from '../engine/types.ts'

type TessWorker = Awaited<ReturnType<typeof createWorker>>

interface Bb {
  x0: number
  y0: number
  x1: number
  y1: number
}
interface OWord {
  text: string
  confidence: number
  bbox: Bb
}
interface OLine {
  words: OWord[]
  bbox: Bb
  baseline: Bb
  rowAttributes?: { rowHeight: number }
}
interface OPage {
  blocks: { paragraphs: { lines: OLine[] }[] }[] | null
}

export const LANGUAGES = [
  { code: 'eng', label: 'English' },
  { code: 'eng+hin', label: 'English + Hindi' },
  { code: 'eng+tam', label: 'English + Tamil' },
  { code: 'eng+mal', label: 'English + Malayalam' },
  { code: 'eng+kan', label: 'English + Kannada' },
  { code: 'eng+tel', label: 'English + Telugu' },
  { code: 'hin', label: 'Hindi' },
  { code: 'tam', label: 'Tamil' },
  { code: 'mal', label: 'Malayalam' },
]

/** English ships with the app (works offline). Other languages are fetched once, then cached by the browser. */
const BUNDLED = new Set(['eng'])

export interface OcrProgress {
  status: string
  progress: number
}

let worker: TessWorker | null = null
let workerLang = ''
let progressCb: ((p: OcrProgress) => void) | null = null

const abs = (p: string) => new URL(`${import.meta.env.BASE_URL}${p}`, location.href).href

async function ensureWorker(lang: string): Promise<TessWorker> {
  if (worker && workerLang === lang) return worker
  if (worker) {
    await worker.terminate()
    worker = null
  }
  const bundled = lang.split('+').every((l) => BUNDLED.has(l))
  worker = await createWorker(lang, 1, {
    workerPath: abs('tesseract/worker.min.js'),
    corePath: abs('tesseract'),
    ...(bundled ? { langPath: abs('tessdata'), gzip: false } : {}),
    logger: (m) => progressCb?.({ status: m.status, progress: m.progress }),
  })
  workerLang = lang
  return worker
}

export async function stopOcr() {
  await worker?.terminate()
  worker = null
  workerLang = ''
}

/** Reads the ink colour of a text box from the page image (mean of its darkest pixels). */
async function makeInkSampler(blob: Blob): Promise<(r: Bb) => Rgb> {
  const bmp = await createImageBitmap(blob)
  const cv = new OffscreenCanvas(bmp.width, bmp.height)
  const g = cv.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0)
  bmp.close()
  return (r) => {
    const x = Math.max(0, Math.floor(r.x0))
    const y = Math.max(0, Math.floor(r.y0))
    const w = Math.min(cv.width - x, Math.ceil(r.x1 - r.x0))
    const h = Math.min(cv.height - y, Math.ceil(r.y1 - r.y0))
    if (w <= 0 || h <= 0) return [20, 20, 20]
    const d = g.getImageData(x, y, w, h).data
    const hist = new Uint32Array(256)
    const total = w * h
    for (let i = 0; i < d.length; i += 4) hist[(d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10 | 0]++
    let acc = 0
    let t = 0
    for (; t < 256; t++) {
      acc += hist[t]
      if (acc >= total * 0.08) break
    }
    let r0 = 0
    let g0 = 0
    let b0 = 0
    let n = 0
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10 <= t) {
        r0 += d[i]
        g0 += d[i + 1]
        b0 += d[i + 2]
        n++
      }
    }
    if (!n) return [20, 20, 20]
    // Pull the mean slightly towards the ink core: scans blur strokes, which lightens them.
    const k = 0.85
    return [Math.round((r0 / n) * k), Math.round((g0 / n) * k), Math.round((b0 / n) * k)]
  }
}

function runFromWords(page: number, n: number, words: OWord[], line: OLine, png: PngResult, ink: (r: Bb) => Rgb): TextRun {
  const S = png.scale
  const toX = (px: number) => png.x0 + px / S
  const toY = (px: number) => png.y0 + px / S

  let text = ''
  const xs: number[] = []
  const owords: OcrWord[] = []
  words.forEach((w, i) => {
    const x0 = toX(w.bbox.x0)
    const x1 = toX(w.bbox.x1)
    if (i > 0) {
      text += ' '
      xs.push(toX(words[i - 1].bbox.x1))
    }
    const chars = [...w.text]
    let unit = 0
    chars.forEach((ch, k) => {
      for (let u = 0; u < ch.length; u++) xs.push(x0 + ((unit + u) / w.text.length) * (x1 - x0))
      unit += ch.length
      void k
    })
    text += w.text
    owords.push({ text: w.text, conf: w.confidence, x0, x1 })
  })
  xs.push(toX(words[words.length - 1].bbox.x1))

  const bb: Bb = {
    x0: Math.min(...words.map((w) => w.bbox.x0)),
    y0: Math.min(...words.map((w) => w.bbox.y0)),
    x1: Math.max(...words.map((w) => w.bbox.x1)),
    y1: Math.max(...words.map((w) => w.bbox.y1)),
  }
  const b = line.baseline
  const slope = b.x1 !== b.x0 ? (b.y1 - b.y0) / (b.x1 - b.x0) : 0
  const baselinePx = b.y0 + (bb.x0 - b.x0) * slope
  const rowH = line.rowAttributes?.rowHeight ?? bb.y1 - bb.y0
  const sizePt = Math.max(4, Math.round(((rowH * 1.06) / S) * 10) / 10)

  return {
    id: `${page}:o${n}`,
    page,
    source: 'ocr',
    text,
    rect: [toX(bb.x0), toY(bb.y0), toX(bb.x1), toY(bb.y1)],
    x: toX(bb.x0),
    baseline: toY(baselinePx),
    xs,
    size: sizePt,
    fontName: 'scan',
    style: { family: 'sans', bold: false, italic: false, size: sizePt, color: ink(bb) },
    hidden: false,
    conf: Math.min(...words.map((w) => w.confidence)),
    words: owords,
  }
}

export async function recognizePage(
  page: number,
  png: PngResult,
  lang: string,
  onProgress?: (p: OcrProgress) => void,
): Promise<TextRun[]> {
  progressCb = onProgress ?? null
  const w = await ensureWorker(lang)
  const blob = new Blob([png.png as BlobPart], { type: 'image/png' })
  const res = await w.recognize(blob, {}, { blocks: true })
  const data = res.data as unknown as OPage
  const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines))
  const ink = await makeInkSampler(blob)
  const runs: TextRun[] = []
  for (const line of lines) {
    const words = line.words.filter((x) => x.text.trim() !== '').sort((a, b) => a.bbox.x0 - b.bbox.x0)
    if (!words.length) continue
    const rowH = line.rowAttributes?.rowHeight ?? line.bbox.y1 - line.bbox.y0
    const gapLimit = Math.max(rowH * 1.1, 14)
    let seg: OWord[] = []
    const flush = () => {
      if (seg.length) runs.push(runFromWords(page, runs.length, seg, line, png, ink))
      seg = []
    }
    for (const word of words) {
      const prev = seg[seg.length - 1]
      if (prev && word.bbox.x0 - prev.bbox.x1 > gapLimit) flush()
      seg.push(word)
    }
    flush()
  }
  progressCb = null
  return runs
}

// ------------------------------------------------------------------------------------ review

const OKAY_SYMBOLS = new Set(['-', '–', '—', '&', '/', '(', ')', ':', ';', ',', '.', '%', '+', '#', '@', '•', '·', '*', '"', "'", '?', '!'])

/** Why a recognised run deserves a human look (empty = looks fine). */
export function reviewReasons(run: TextRun, threshold: number): string[] {
  const out: string[] = []
  const low = run.words?.filter((w) => w.conf < threshold) ?? []
  if (low.length) out.push(`Low confidence: ${low.map((w) => `“${w.text}” ${Math.round(w.conf)}%`).join(', ')}`)
  const odd = (run.words ?? []).filter((w) => w.text.length <= 3 && !/[\p{L}\p{N}]/u.test(w.text) && ![...w.text].every((c) => OKAY_SYMBOLS.has(c)))
  if (odd.length) out.push(`Unusual symbol: ${odd.map((w) => `“${w.text}”`).join(' ')}`)
  return out
}

/** Re-flow a run to new text: words keep their original boxes when the word count matches, else spread evenly. */
export function withText(run: TextRun, text: string): TextRun {
  if (text === run.text) return run
  const words = text.split(' ')
  const [rx0, , rx1] = run.rect
  const xs: number[] = []
  const old = run.words
  const useBoxes = old && old.length === words.length
  let total = 0
  words.forEach((w) => (total += w.length))
  let cursor = rx0
  words.forEach((w, i) => {
    let x0: number
    let x1: number
    if (useBoxes) {
      x0 = old[i].x0
      x1 = old[i].x1
    } else {
      const share = total ? w.length / total : 1 / words.length
      x0 = cursor
      x1 = cursor + share * (rx1 - rx0)
      cursor = x1
    }
    if (i > 0) xs.push(useBoxes ? old[i - 1].x1 : x0)
    for (let u = 0; u < w.length; u++) xs.push(x0 + (u / Math.max(1, w.length)) * (x1 - x0))
  })
  xs.push(rx1)
  return { ...run, text, xs, words: undefined }
}
