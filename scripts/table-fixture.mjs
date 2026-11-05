// Builds a PDF with a ruled table that looks like a typical generated report: a dark header, grey body rows, thin
// borders, DejaVu text, and a cell whose text runs past its border. Used by the tests and for the sample on the home page.
import * as mupdf from 'mupdf'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FONT = (name) => new Uint8Array(fs.readFileSync(path.join(ROOT, 'node_modules', 'dejavu-fonts-ttf', 'ttf', `${name}.ttf`)))

export const ROADMAP = [
  ['Version', 'Focus', 'Core Technologies', 'Primary Outcome'],
  ['v0.1', 'Clipboard Vault', 'Rust, Tauri, SQLite', 'Capture and search clipboard history.'],
  ['v0.2', 'Rich Memory Engine', 'SQLite, Images, Files, HTML', 'Support rich content, timeline, backup, analytics.'],
  ['v0.3', 'AI Memory Engine', 'Ollama, Local LLM', 'Summaries, categorization, metadata.'],
  ['v0.4', 'Semantic Memory', 'Embeddings, Qdrant', 'Natural language & semantic search.'],
  ['v0.5', 'Knowledge Graph', 'Neo4j, NLP', 'Connect entities into a personal knowledge graph.'],
  ['v1.0', 'Memory OS', 'Hybrid Search, RAG', 'Unified searchable personal memory.'],
  ['v2.0', 'Learning Engine', 'Analytics, AI', 'Daily summaries, quizzes, learning insights.'],
  ['v3.0', 'Memory Assistant', 'AI Agents', 'Chat with your memory and retrieve context.'],
  ['v4.0', 'Context Engine', 'Desktop context, OCR', 'Understand screenshots and active work.'],
]

/**
 * @param {{ rows?: string[][], colWidths?: number[], rowHeight?: number, x?: number, top?: number, thinBorders?: boolean, noLines?: boolean, size?: number }} [o]
 * @returns {{ bytes: Uint8Array, xs: number[], ys: number[] }} the PDF and the table's column/row edges (page space, y down)
 */
export function buildTablePdf(o = {}) {
  const rows = o.rows ?? ROADMAP
  const colWidths = o.colWidths ?? [50, 105, 150, 175]
  const rowH = o.rowHeight ?? 24
  const x0 = o.x ?? 30
  const top = o.top ?? 110
  const size = o.size ?? 9
  const H = 842
  const doc = new mupdf.PDFDocument()
  const font = new mupdf.Font('DejaVuSans', FONT('DejaVuSans'))
  const fref = doc.addFont(font)

  const xs = [x0]
  for (const w of colWidths) xs.push(xs[xs.length - 1] + w)
  const ys = [top]
  for (let i = 0; i < rows.length; i++) ys.push(top + rowH * (i + 1))

  const hex = (s) => [...s].map((ch) => font.encodeCharacter(ch.codePointAt(0)).toString(16).padStart(4, '0')).join('')
  const text = (s, x, yDown, sz, rgb) => `${rgb.map((v) => v / 255).join(' ')} rg BT /F1 ${sz} Tf 1 0 0 1 ${x.toFixed(2)} ${(H - yDown).toFixed(2)} Tm <${hex(s)}> Tj ET`
  const ops = []
  ops.push(text('Version Evolution Roadmap', x0 + 10, top - 22, 18, [20, 20, 20]))
  // cell backgrounds
  rows.forEach((_, r) => {
    const rgb = r === 0 ? [31, 78, 121] : [243, 243, 243]
    ops.push(`${rgb.map((v) => v / 255).join(' ')} rg ${xs[0]} ${H - ys[r + 1]} ${xs[xs.length - 1] - xs[0]} ${rowH} re f`)
  })
  // borders
  if (!o.noLines) {
    const g = [0.6, 0.6, 0.6]
    if (o.thinBorders) {
      // hair-thin filled boxes instead of stroked lines
      ops.push(`${g.join(' ')} rg`)
      for (const y of ys) ops.push(`${xs[0]} ${H - y - 0.25} ${xs[xs.length - 1] - xs[0]} 0.5 re f`)
      for (const x of xs) ops.push(`${x - 0.25} ${H - ys[ys.length - 1]} 0.5 ${ys[ys.length - 1] - ys[0]} re f`)
    } else {
      ops.push(`${g.join(' ')} RG 0.5 w`)
      for (const y of ys) ops.push(`${xs[0]} ${H - y} m ${xs[xs.length - 1]} ${H - y} l S`)
      for (const x of xs) ops.push(`${x} ${H - ys[0]} m ${x} ${H - ys[ys.length - 1]} l S`)
    }
  }
  // text: one line per cell, left aligned, may overflow its cell
  rows.forEach((row, r) => {
    row.forEach((cell, c) => ops.push(text(cell, xs[c] + 6, ys[r] + rowH / 2 + size * 0.35, size, r === 0 ? [255, 255, 255] : [20, 20, 20])))
  })
  ops.push(text('Footer: the table above is the product roadmap.', x0, ys[ys.length - 1] + 90, 10, [60, 60, 60]))

  const resources = doc.addObject(doc.newDictionary())
  const fd = doc.newDictionary()
  fd.put('F1', fref)
  resources.put('Font', fd)
  doc.insertPage(-1, doc.addPage([0, 0, 595, H], 0, resources, ops.join('\n')))
  try {
    doc.subsetFonts() // keep only the glyphs used, so the sample is small
  } catch {
    /* a full font is fine */
  }
  return { bytes: new Uint8Array(doc.saveToBuffer('compress').asUint8Array().slice()), xs, ys }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { bytes } = buildTablePdf()
  const out = path.join(ROOT, 'public', 'samples', 'table-roadmap.pdf')
  fs.writeFileSync(out, bytes)
  fs.writeFileSync(path.join(ROOT, 'tests', 'fixtures', 'table-roadmap.pdf'), bytes)
  console.log(`wrote ${out} (${bytes.length} bytes)`)
}
