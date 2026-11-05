import type { Edit, TextRun } from '../engine/types.ts'
import type { DraftRestore, Snapshot } from '../ui/store.ts'

/**
 * A draft is "everything not yet exported" for one library file: the edits, the corrections and proofreading marks,
 * the text recognised on scanned pages and the pictures the edits use (those live in the library as `asset` files).
 * Undo history is not kept — a restored draft is the new starting point.
 */
export interface DraftImage {
  documentId: string
  width: number
  height: number
  type: string
}
export interface DraftV1 {
  v: 1
  snapshot: Snapshot
  ocr: Record<number, { lang: string; ms: number }>
  ocrRuns: Record<number, TextRun[]>
  images: Record<string, DraftImage>
}

/** The server takes ~4 MB of JSON per request. */
export const DRAFT_LIMIT = 3.8 * 1024 * 1024

export const draftEditCount = (s: Snapshot) => s.edits.length + Object.keys(s.corrections).length

/** The ids of the pictures that edits still use. */
export const imagesUsedBy = (edits: Edit[]): string[] => [...new Set(edits.flatMap((e) => (e.overlay?.type === 'image' ? [e.overlay.imageId] : [])))]

export function buildDraft(snapshot: Snapshot, ocr: DraftV1['ocr'], runs: Record<number, TextRun[]>, images: DraftV1['images']): DraftV1 {
  const ocrRuns: DraftV1['ocrRuns'] = {}
  for (const p of Object.keys(ocr)) ocrRuns[Number(p)] = runs[Number(p)] ?? []
  return { v: 1, snapshot, ocr, ocrRuns, images }
}

/** JSON for the server. If it is too big, the per-word boxes of recognised lines go first (the lines themselves stay). */
export function encodeDraft(d: DraftV1, limit = DRAFT_LIMIT): { draft: DraftV1; json: string } | null {
  // the limit is on what travels (UTF-8 bytes): Tamil, Hindi or Chinese text takes three bytes a character
  const size = (s: string) => new TextEncoder().encode(s).length
  let json = JSON.stringify(d)
  if (size(json) <= limit) return { draft: d, json }
  const lean: DraftV1 = { ...d, ocrRuns: Object.fromEntries(Object.entries(d.ocrRuns).map(([p, rs]) => [p, rs.map(({ words: _w, ...r }) => r as TextRun)])) }
  json = JSON.stringify(lean)
  return size(json) <= limit ? { draft: lean, json } : null
}

/** Accept only what we wrote; anything else is "no draft". */
export function parseDraft(x: unknown): DraftV1 | null {
  const d = x as Partial<DraftV1> | null
  if (!d || typeof d !== 'object' || d.v !== 1 || !d.snapshot || !Array.isArray(d.snapshot.edits)) return null
  return {
    v: 1,
    snapshot: { edits: d.snapshot.edits, corrections: d.snapshot.corrections ?? {}, verified: d.snapshot.verified ?? {} },
    ocr: d.ocr ?? {},
    ocrRuns: d.ocrRuns ?? {},
    images: d.images ?? {},
  }
}

/** The draft as the reducer wants it, minus edits that use pictures that could not be fetched. */
export function toRestore(d: DraftV1, missingImages: Set<string> = new Set(), pageCount = Infinity): DraftRestore {
  const edits = d.snapshot.edits.filter((e) => e.page < pageCount && !(e.overlay?.type === 'image' && missingImages.has(e.overlay.imageId)))
  const ocr: DraftRestore['ocr'] = {}
  const ocrRuns: DraftRestore['ocrRuns'] = {}
  for (const [p, v] of Object.entries(d.ocr)) {
    if (Number(p) >= pageCount) continue
    ocr[Number(p)] = v
    ocrRuns[Number(p)] = d.ocrRuns[Number(p)] ?? []
  }
  return { snapshot: { ...d.snapshot, edits }, ocr, ocrRuns }
}

/** Counts per kind, for the save history. */
export function summarizeEdits(s: Snapshot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of s.edits) out[e.kind] = (out[e.kind] ?? 0) + 1
  const corrected = Object.keys(s.corrections).length
  if (corrected) out.corrections = corrected
  return out
}
