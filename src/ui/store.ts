import type { Edit, Overlay, PageInfo, PageSize, TextRun } from '../engine/types.ts'

/** Everything the user can undo. */
export interface Snapshot {
  edits: Edit[]
  /** runId -> corrected text for the searchable layer of a scan (the picture is NOT changed) */
  corrections: Record<string, string>
  /** runIds a human has checked against the scan */
  verified: Record<string, true>
}

export interface DocState {
  docId: number
  fileName: string
  sizes: PageSize[]
  infos: Record<number, PageInfo>
  /** clickable runs per page: PDF text, or OCR results once a scan was recognised */
  runs: Record<number, TextRun[]>
  ocr: Record<number, { lang: string; ms: number }>
  present: Snapshot
  past: Snapshot[]
  future: Snapshot[]
}

/** What a saved draft puts back when its file is opened again: the edits, and the text recognised on scanned pages. */
export interface DraftRestore {
  snapshot: Snapshot
  ocr: DocState['ocr']
  ocrRuns: Record<number, TextRun[]>
}

export const emptySnapshot = (): Snapshot => ({ edits: [], corrections: {}, verified: {} })

export const initialDoc: DocState = {
  docId: 0,
  fileName: '',
  sizes: [],
  infos: {},
  runs: {},
  ocr: {},
  present: emptySnapshot(),
  past: [],
  future: [],
}

export type DocAction =
  | { type: 'open'; fileName: string; sizes: PageSize[]; restore?: DraftRestore }
  | { type: 'close' }
  | { type: 'pageLoaded'; info: PageInfo; runs: TextRun[] }
  | { type: 'ocrDone'; page: number; runs: TextRun[]; lang: string; ms: number }
  | { type: 'commit'; fn: (s: Snapshot) => Snapshot }
  | { type: 'undo' }
  | { type: 'redo' }

const MAX_HISTORY = 200

export function docReducer(state: DocState, a: DocAction): DocState {
  switch (a.type) {
    case 'open': {
      const base = { ...initialDoc, docId: state.docId + 1, fileName: a.fileName, sizes: a.sizes }
      // a restored draft starts with no undo history: it is the starting point
      return a.restore ? { ...base, present: a.restore.snapshot, ocr: a.restore.ocr, runs: { ...a.restore.ocrRuns } } : base
    }
    case 'close':
      return { ...initialDoc, docId: state.docId + 1 }
    case 'pageLoaded': {
      // a page that was recognised keeps its recognised lines when the page itself is analysed later
      const keep = state.ocr[a.info.index] && state.runs[a.info.index]
      return { ...state, infos: { ...state.infos, [a.info.index]: a.info }, runs: keep ? state.runs : { ...state.runs, [a.info.index]: a.runs } }
    }
    case 'ocrDone': {
      // Fresh recognition invalidates old corrections / proofreading marks for that page.
      const corrections = { ...state.present.corrections }
      const verified = { ...state.present.verified }
      for (const r of state.runs[a.page] ?? []) {
        delete corrections[r.id]
        delete verified[r.id]
      }
      return {
        ...state,
        runs: { ...state.runs, [a.page]: a.runs },
        ocr: { ...state.ocr, [a.page]: { lang: a.lang, ms: a.ms } },
        present: { ...state.present, corrections, verified },
      }
    }
    case 'commit': {
      const next = a.fn(state.present)
      if (next === state.present) return state
      return { ...state, present: next, past: [...state.past, state.present].slice(-MAX_HISTORY), future: [] }
    }
    case 'undo': {
      if (!state.past.length) return state
      const prev = state.past[state.past.length - 1]
      return { ...state, present: prev, past: state.past.slice(0, -1), future: [state.present, ...state.future] }
    }
    case 'redo': {
      if (!state.future.length) return state
      const [next, ...rest] = state.future
      return { ...state, present: next, past: [...state.past, state.present], future: rest }
    }
  }
}

// ------------------------------------------------------------------------------ snapshot helpers

export const upsertEdit =
  (edit: Edit) =>
  (s: Snapshot): Snapshot => {
    const i = s.edits.findIndex((e) => e.id === edit.id)
    const edits = i >= 0 ? s.edits.map((e) => (e.id === edit.id ? edit : e)) : [...s.edits, edit]
    return { ...s, edits }
  }

export const removeEdit =
  (id: string) =>
  (s: Snapshot): Snapshot => {
    if (!s.edits.some((e) => e.id === id)) return s
    return { ...s, edits: s.edits.filter((e) => e.id !== id) }
  }

/** Change what an overlay draws (moved, resized, recoloured). */
export const updateOverlayEdit =
  (id: string, overlay: Overlay) =>
  (s: Snapshot): Snapshot => {
    if (!s.edits.some((e) => e.id === id)) return s
    return { ...s, edits: s.edits.map((e) => (e.id === id ? { ...e, overlay } : e)) }
  }

export const setCorrection =
  (run: TextRun, text: string, verified: boolean) =>
  (s: Snapshot): Snapshot => {
    const corrections = { ...s.corrections }
    if (text === run.text) delete corrections[run.id]
    else corrections[run.id] = text
    const v = { ...s.verified }
    if (verified) v[run.id] = true
    else delete v[run.id]
    return { ...s, corrections, verified: v }
  }

export const markVerified =
  (runId: string, on: boolean) =>
  (s: Snapshot): Snapshot => {
    if (on === !!s.verified[runId]) return s
    const verified = { ...s.verified }
    if (on) verified[runId] = true
    else delete verified[runId]
    return { ...s, verified }
  }

export const pictureEditFor = (edits: Edit[], runId: string) => edits.find((e) => e.kind === 'replace' && e.run?.id === runId)

/** The text a run should carry in the searchable layer. */
export const effectiveText = (run: TextRun, s: Snapshot) => pictureEditFor(s.edits, run.id)?.text ?? s.corrections[run.id] ?? run.text

/** Pages that are edited like scans: recognise the text first, then patch the picture. */
export const isScanPage = (info: PageInfo | undefined) => info?.kind === 'scan' || info?.kind === 'scan-ocr' || info?.kind === 'outlined'

let counter = 0
export const uid = (p = 'e') => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`
