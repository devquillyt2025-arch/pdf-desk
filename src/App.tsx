import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Edit, FontStyle, PageInfo, Rect, TextLayer, TextLayerLine, TextRun, VerifyReport } from './engine/types.ts'
import { sameStyle } from './engine/plan.ts'
import { recognizePage, reviewReasons, withText } from './ocr/ocr.ts'
import { engine } from './ui/engine.ts'
import { ScrollRootContext, useEvent, usePageEdits, useStoredState } from './ui/hooks.ts'
import { Icon } from './ui/icons.tsx'
import { InlineEditor, type EditorResult } from './ui/InlineEditor.tsx'
import { FontsModal, PasswordModal, ReportModal } from './ui/Modals.tsx'
import { PageView } from './ui/PageView.tsx'
import { ChangesPanel, ProofPanel } from './ui/Panels.tsx'
import { docReducer, effectiveText, initialDoc, isScanPage, markVerified, pictureEditFor, removeEdit, setCorrection, uid, upsertEdit } from './ui/store.ts'
import { Thumbs } from './ui/Thumbs.tsx'
import type { EditingTarget, Tool } from './ui/types.ts'
import { Welcome } from './ui/Welcome.tsx'

const PAD = 28
const GAP = 20
const PX_PER_PT = 96 / 72
const DEFAULT_ADD_STYLE: FontStyle = { family: 'sans', bold: false, italic: false, size: 12, color: [0, 0, 0] }

interface Toast {
  id: number
  kind: 'info' | 'ok' | 'error'
  msg: string
  action?: { label: string; run: () => void }
}

/** Median colour of a thin ring just outside a rect on the rendered page: the paper behind the text. */
let scratch: CanvasRenderingContext2D | null = null
function sampleBg(page: number, rect: Rect, pageW: number): string {
  const cv = document.querySelector<HTMLCanvasElement>(`section.page[data-page="${page}"] canvas`)
  if (!cv || cv.width < 8) return '#ffffff'
  scratch ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const g = scratch
  if (!g) return '#ffffff'
  const s = cv.width / pageW
  const clampX = (v: number) => Math.min(cv.width - 1, Math.max(0, Math.round(v)))
  const clampY = (v: number) => Math.min(cv.height - 1, Math.max(0, Math.round(v)))
  const x0 = clampX(rect[0] * s - 3)
  const x1 = clampX(rect[2] * s + 3)
  const y0 = clampY(rect[1] * s - 3)
  const y1 = clampY(rect[3] * s + 3)
  const strips: [number, number, number, number][] = [
    [x0, y0, Math.max(1, x1 - x0), 2],
    [x0, clampY(y1 - 1), Math.max(1, x1 - x0), 2],
    [x0, y0, 2, Math.max(1, y1 - y0)],
    [clampX(x1 - 1), y0, 2, Math.max(1, y1 - y0)],
  ]
  const ch: number[][] = [[], [], []]
  for (const [x, y, w, h] of strips) {
    const sw = Math.min(w, cv.width - x)
    const sh = Math.min(h, cv.height - y)
    if (sw < 1 || sh < 1) continue
    g.canvas.width = sw
    g.canvas.height = sh
    g.drawImage(cv, x, y, sw, sh, 0, 0, sw, sh)
    const d = g.getImageData(0, 0, sw, sh).data
    for (let i = 0; i < d.length; i += 4) {
      ch[0].push(d[i])
      ch[1].push(d[i + 1])
      ch[2].push(d[i + 2])
    }
  }
  if (!ch[0].length) return '#ffffff'
  const med = (arr: number[]) => arr.sort((p, q) => p - q)[arr.length >> 1]
  return `rgb(${med(ch[0])}, ${med(ch[1])}, ${med(ch[2])})`
}

const readingOrder = (runs: TextRun[]) => [...runs].sort((a, b) => Math.round(a.baseline / 3) - Math.round(b.baseline / 3) || a.x - b.x)

export default function App() {
  const [doc, dispatch] = useReducer(docReducer, initialDoc)
  const { present: snap } = doc
  const [theme, setTheme] = useStoredState<'system' | 'light' | 'dark'>('pagedesk-theme', 'system')
  const [tool, setTool] = useState<Tool>('edit')
  const [zoom, setZoom] = useState(1)
  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [eraseRedact, setEraseRedact] = useState(false)
  const [addStyle, setAddStyle] = useState<FontStyle>(DEFAULT_ADD_STYLE)
  const [panelOpen, setPanelOpen] = useState(true)
  const [panelTab, setPanelTab] = useState<'changes' | 'proof'>('changes')
  const [thumbsOpen, setThumbsOpen] = useState(true)
  const [current, setCurrent] = useState(0)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [password, setPassword] = useState<{ bytes: Uint8Array; name: string; error: boolean } | null>(null)
  const [lang, setLang] = useStoredState('pagedesk-ocr-lang', 'eng')
  const [threshold, setThreshold] = useStoredState('pagedesk-flag-threshold', 90)
  const [ocrJob, setOcrJob] = useState<{ page: number; done: number; total: number; status: string; progress: number } | null>(null)
  const [highlightRunId, setHighlightRunId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [reportInfo, setReportInfo] = useState<{ report: VerifyReport; bytes: Uint8Array; edits: Edit[] } | null>(null)
  const [fontsOpen, setFontsOpen] = useState(false)
  const [fonts, setFonts] = useState<string[]>([])
  const [toast, setToast] = useState<Toast | null>(null)
  const [hintVisible, setHintVisible] = useState(true)
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const loadingPages = useRef(new Set<string>())
  const dragDepth = useRef(0)

  const hasDoc = doc.sizes.length > 0
  const k = zoom * PX_PER_PT
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
  const editsOf = usePageEdits(snap.edits)

  // ------------------------------------------------------------------------------------- theme
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
  }, [theme])

  // The tool hint shows for a few seconds whenever the tool (or compare mode) changes, then gets out of the way.
  useEffect(() => {
    setHintVisible(true)
    const t = setTimeout(() => setHintVisible(false), 4500)
    return () => clearTimeout(t)
  }, [tool, showOriginal, eraseRedact, doc.docId])

  // ------------------------------------------------------------------------------------ toasts
  const notify = useCallback((msg: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
    setToast({ id: Date.now(), kind, msg, action })
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.action ? 8000 : 5000)
    return () => clearTimeout(t)
  }, [toast])

  // --------------------------------------------------------------------------------- open files
  const openBytes = useEvent(async (bytes: Uint8Array, name: string, pw?: string) => {
    setLoading(true)
    const keep = bytes.slice()
    try {
      const res = await engine.open(bytes, pw)
      if (res.status === 'password') {
        setPassword({ bytes: keep, name, error: !!pw })
        return
      }
      if (res.status === 'error') {
        notify(res.message, 'error')
        return
      }
      setPassword(null)
      loadingPages.current.clear()
      dispatch({ type: 'open', fileName: name, sizes: res.sizes })
      setEditing(null)
      setTool('edit')
      setShowOriginal(false)
      setCurrent(0)
      setHighlightRunId(null)
      setReportInfo(null)
      setPanelTab('changes')
      const fit = (window.innerWidth - (thumbsOpen ? 168 : 0) - (panelOpen ? 360 : 0) - PAD * 2 - 24) / (res.sizes[0].width * PX_PER_PT)
      setZoom(Math.round(Math.max(0.5, Math.min(1.6, fit)) * 20) / 20)
      scroller?.scrollTo({ top: 0 })
    } catch (e) {
      notify(`Could not open the file: ${(e as Error).message}`, 'error')
    } finally {
      setLoading(false)
    }
  })

  const openFile = useEvent(async (file: File) => {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      notify('Please choose a PDF file.', 'error')
      return
    }
    await openBytes(new Uint8Array(await file.arrayBuffer()), file.name)
  })

  const openSample = useEvent(async (kind: 'text' | 'scan') => {
    const file = kind === 'text' ? 'invoice-searchable.pdf' : 'invoice-scanned.pdf'
    const res = await fetch(`${import.meta.env.BASE_URL}samples/${file}`)
    await openBytes(new Uint8Array(await res.arrayBuffer()), file)
  })

  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepth.current++
      setDragging(true)
    }
    const leave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const f = e.dataTransfer?.files?.[0]
      if (f) void openFile(f)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [openFile])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (snap.edits.length || Object.keys(snap.corrections).length) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [snap.edits.length, snap.corrections])

  // -------------------------------------------------------------------------- lazy page loading
  const ensurePage = useEvent(async (i: number) => {
    const key = `${doc.docId}:${i}`
    if (doc.infos[i] || loadingPages.current.has(key)) return
    loadingPages.current.add(key)
    try {
      const [info, runs] = await Promise.all([engine.analyze(i), engine.getRuns(i)])
      dispatch({ type: 'pageLoaded', info, runs })
    } catch (e) {
      loadingPages.current.delete(key)
      console.error('page load failed', e)
    }
  })

  // ------------------------------------------------------------------------------------- layout
  const tops = useMemo(() => {
    const out: number[] = []
    let y = PAD
    for (const s of doc.sizes) {
      out.push(y)
      y += s.height * k + GAP
    }
    return out
  }, [doc.sizes, k])

  const onScroll = useEvent(() => {
    if (!scroller || !tops.length) return
    const probe = scroller.scrollTop + scroller.clientHeight * 0.35
    let lo = 0
    let hi = tops.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (tops[mid] <= probe) lo = mid
      else hi = mid - 1
    }
    setCurrent(lo)
  })

  const scrollToPage = useEvent((i: number) => {
    scroller?.scrollTo({ top: Math.max(0, (tops[i] ?? 0) - 12), behavior: 'smooth' })
    setCurrent(i)
  })
  const scrollToRect = useEvent((page: number, rect: Rect) => {
    if (!scroller) return
    scroller.scrollTo({ top: Math.max(0, (tops[page] ?? 0) + rect[1] * k - scroller.clientHeight * 0.3), behavior: 'smooth' })
  })

  useEffect(() => {
    if (!scroller) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setZoom((z) => Math.min(4, Math.max(0.25, Math.round(z * (e.deltaY < 0 ? 1.08 : 1 / 1.08) * 100) / 100)))
    }
    scroller.addEventListener('wheel', onWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [scroller])

  // ------------------------------------------------------------------------------- review state
  const { flaggedByPage, reasonsByPage } = useMemo(() => {
    const f = new Map<number, Set<string>>()
    const r = new Map<number, Map<string, string>>()
    for (const [pg, runs] of Object.entries(doc.runs)) {
      const set = new Set<string>()
      const map = new Map<string, string>()
      for (const run of runs) {
        if (run.source !== 'ocr' || snap.verified[run.id]) continue
        const why = reviewReasons(run, threshold)
        if (why.length) {
          set.add(run.id)
          map.set(run.id, why.join(' · '))
        }
      }
      f.set(Number(pg), set)
      r.set(Number(pg), map)
    }
    return { flaggedByPage: f, reasonsByPage: r }
  }, [doc.runs, snap.verified, threshold])
  const EMPTY_SET = useRef(new Set<string>()).current
  const EMPTY_MAP = useRef(new Map<string, string>()).current

  const scanPages = useMemo(
    () =>
      Object.values(doc.infos)
        .filter((i) => isScanPage(i))
        .map((i) => i.index)
        .sort((a, b) => a - b),
    [doc.infos],
  )
  const totalFlagged = useMemo(() => [...flaggedByPage.values()].reduce((s, v) => s + v.size, 0), [flaggedByPage])
  const anyScan = scanPages.length > 0

  const proofStats = useMemo(() => {
    let total = 0
    let verified = 0
    for (const pg of scanPages) {
      for (const r of doc.runs[pg] ?? []) {
        if (r.source !== 'ocr') continue
        total++
        if (snap.verified[r.id]) verified++
      }
    }
    return { total, verified }
  }, [scanPages, doc.runs, doc.infos, snap.verified])

  // ---------------------------------------------------------------------------------------- OCR
  const runOcr = useEvent(async (pages: number[]) => {
    if (ocrJob || !pages.length) return
    setPanelOpen(true)
    setPanelTab('proof')
    let found = 0
    let doneCount = 0
    try {
      for (const page of pages) {
        setOcrJob({ page, done: doneCount, total: pages.length, status: 'preparing page', progress: 0 })
        const info = doc.infos[page] ?? (await engine.analyze(page))
        const dpi = Math.min(400, Math.max(250, info.imageDpi ?? 300))
        const png = await engine.renderPng(page, dpi / 72)
        const t0 = performance.now()
        const runs = await recognizePage(page, png, lang, (pr) => setOcrJob((j) => (j ? { ...j, status: pr.status, progress: pr.progress } : j)))
        dispatch({ type: 'ocrDone', page, runs, lang, ms: performance.now() - t0 })
        found += runs.length
        doneCount++
      }
      notify(`Recognised ${found} lines of text. Check the flagged ones before you export.`, 'ok')
    } catch (e) {
      const msg = (e as Error).message ?? String(e)
      notify(`Text recognition failed: ${msg}${lang !== 'eng' ? ' — non-English languages need an internet connection the first time.' : ''}`, 'error')
    } finally {
      setOcrJob(null)
    }
  })

  const recognizeAll = useEvent(async () => {
    const pages: number[] = []
    for (let i = 0; i < doc.sizes.length; i++) {
      const info = doc.infos[i] ?? (await engine.analyze(i))
      if (!doc.infos[i]) dispatch({ type: 'pageLoaded', info, runs: await engine.getRuns(i) })
      if (isScanPage(info)) pages.push(i)
    }
    if (!pages.length) notify('No scanned pages in this document.')
    else await runOcr(pages)
  })

  // ---------------------------------------------------------------------------------- editing
  const runsOf = (page: number) => doc.runs[page] ?? []
  const isScanRun = (run: TextRun) => run.source === 'ocr' || run.hidden

  const startRun = useEvent((page: number, runId: string) => {
    const run = runsOf(page).find((r) => r.id === runId)
    if (!run) return
    setEditing({ page, kind: 'run', runId, bg: sampleBg(page, run.rect, doc.sizes[page].width) })
    setHighlightRunId(null)
  })

  const startEdit = useEvent((editId: string) => {
    const e = snap.edits.find((x) => x.id === editId)
    if (!e) return
    if (e.kind === 'replace') startRun(e.page, e.run!.id)
    else if (e.kind === 'add') setEditing({ page: e.page, kind: 'add', editId, x: e.x!, baseline: e.baseline!, bg: sampleBg(e.page, [e.x!, e.baseline! - e.style.size, e.x! + 40, e.baseline!], doc.sizes[e.page].width) })
    else {
      dispatch({ type: 'commit', fn: removeEdit(editId) })
      notify('Erased area removed.', 'info', { label: 'Undo', run: () => dispatch({ type: 'undo' }) })
    }
  })

  const startAdd = useEvent((page: number, x: number, baseline: number) => {
    setEditing({ page, kind: 'add', x, baseline, bg: sampleBg(page, [x, baseline - addStyle.size, x + 40, baseline], doc.sizes[page].width) })
  })

  const doErase = useEvent((page: number, rect: Rect) => {
    const edit: Edit = { id: uid(), page, kind: 'erase', text: '', style: addStyle, rect, fill: 'auto', redact: eraseRedact }
    dispatch({ type: 'commit', fn: upsertEdit(edit) })
  })

  const commitEditor = useEvent((res: EditorResult, move?: 'next' | 'prev') => {
    const target = editing
    setEditing(null)
    if (!target) return
    if (target.kind === 'run') {
      const run = runsOf(target.page).find((r) => r.id === target.runId)
      if (!run) return
      const scan = isScanRun(run)
      const existing = pictureEditFor(snap.edits, run.id)
      const corrected = snap.corrections[run.id]
      const base = scan ? withText(run, corrected ?? run.text) : run
      if (scan && !res.alsoImage) {
        dispatch({ type: 'commit', fn: setCorrection(run, res.text, true) })
      } else if (res.text === base.text && sameStyle(res.style, base.style)) {
        if (existing) dispatch({ type: 'commit', fn: removeEdit(existing.id) })
        else if (scan) dispatch({ type: 'commit', fn: markVerified(run.id, true) })
      } else {
        dispatch({
          type: 'commit',
          fn: upsertEdit({ id: existing?.id ?? uid(), page: run.page, kind: 'replace', run: existing?.run ?? base, text: res.text, style: res.style, keepPrefix: res.keepPrefix }),
        })
      }
      if (move) {
        const order = readingOrder(runsOf(target.page))
        const i = order.findIndex((r) => r.id === run.id)
        const next = order[i + (move === 'next' ? 1 : -1)]
        if (next) setTimeout(() => startRun(target.page, next.id), 0)
      }
    } else {
      const existing = target.editId ? snap.edits.find((e) => e.id === target.editId) : undefined
      if (!res.text.trim()) {
        if (existing) dispatch({ type: 'commit', fn: removeEdit(existing.id) })
        return
      }
      setAddStyle(res.style)
      dispatch({
        type: 'commit',
        fn: upsertEdit({ id: existing?.id ?? uid(), page: target.page, kind: 'add', text: res.text, style: res.style, x: existing?.x ?? target.x, baseline: existing?.baseline ?? target.baseline }),
      })
    }
  })

  const deleteFromEditor = useEvent(() => {
    const target = editing
    setEditing(null)
    if (!target) return
    const id = target.kind === 'run' ? pictureEditFor(snap.edits, target.runId)?.id : target.editId
    if (id) dispatch({ type: 'commit', fn: removeEdit(id) })
  })

  const confirmProof = useEvent((run: TextRun, text: string) => {
    dispatch({ type: 'commit', fn: setCorrection(run, text, true) })
  })

  const focusProofRun = useEvent((run: TextRun) => {
    setHighlightRunId(run.id)
    scrollToRect(run.page, run.rect)
  })

  const jumpToEdit = useEvent((e: Edit) => {
    const r: Rect = e.kind === 'erase' ? e.rect! : e.kind === 'replace' ? e.run!.rect : [e.x!, e.baseline! - e.style.size, e.x! + 40, e.baseline!]
    scrollToRect(e.page, r)
  })

  const editorFor = (page: number) => {
    if (!editing || editing.page !== page) return null
    if (editing.kind === 'run') {
      const run = runsOf(page).find((r) => r.id === editing.runId)
      if (!run) return null
      const existing = pictureEditFor(snap.edits, run.id)
      const scan = isScanRun(run)
      return (
        <InlineEditor
          key={run.id}
          k={k}
          x={run.x}
          baseline={run.baseline}
          width={run.rect[2] - run.rect[0]}
          rect={run.rect}
          initialText={effectiveText(run, snap)}
          initialStyle={existing?.style ?? run.style}
          bg={editing.bg}
          scan={scan}
          alsoImage
          keepPrefix={existing?.keepPrefix ?? true}
          isNew={false}
          canDelete={!!existing}
          hasNeighbours
          onCommit={commitEditor}
          onCancel={() => setEditing(null)}
          onDelete={deleteFromEditor}
        />
      )
    }
    const existing = editing.editId ? snap.edits.find((e) => e.id === editing.editId) : undefined
    return (
      <InlineEditor
        key={editing.editId ?? `new-${editing.x}-${editing.baseline}`}
        k={k}
        x={editing.x}
        baseline={editing.baseline}
        width={0}
        rect={null}
        initialText={existing?.text ?? ''}
        initialStyle={existing?.style ?? addStyle}
        bg={editing.bg}
        scan={false}
        alsoImage
        keepPrefix
        isNew
        canDelete={!!existing}
        hasNeighbours={false}
        onCommit={commitEditor}
        onCancel={() => setEditing(null)}
        onDelete={deleteFromEditor}
      />
    )
  }

  // --------------------------------------------------------------------------------------- export
  const buildLayers = async (): Promise<TextLayer[]> => {
    const out: TextLayer[] = []
    for (let page = 0; page < doc.sizes.length; page++) {
      const info: PageInfo | undefined = doc.infos[page]
      if (!info || !isScanPage(info)) continue
      const runs = doc.runs[page] ?? []
      const pageEdits = snap.edits.filter((e) => e.page === page)
      const ocrd = !!doc.ocr[page]
      const changed = pageEdits.length > 0 || runs.some((r) => snap.corrections[r.id] !== undefined)
      const need = info.kind === 'scan' || info.kind === 'outlined' ? ocrd && runs.length > 0 : ocrd || changed
      if (!need) continue
      const erased = pageEdits.filter((e) => e.kind === 'erase').map((e) => e.rect!)
      const lines: TextLayerLine[] = []
      for (const r of runs) {
        const cx = (r.rect[0] + r.rect[2]) / 2
        const cy = (r.rect[1] + r.rect[3]) / 2
        if (erased.some((q) => cx >= q[0] && cx <= q[2] && cy >= q[1] && cy <= q[3])) continue
        const text = effectiveText(r, snap)
        if (!text.trim()) continue
        lines.push({ text, rect: r.rect, baseline: r.baseline, size: r.size, words: text === r.text ? r.words?.map((w) => ({ text: w.text, x0: w.x0, x1: w.x1 })) : undefined })
      }
      for (const e of pageEdits.filter((x) => x.kind === 'add' && x.text.trim())) {
        const [w] = await engine.measure([{ text: e.text, style: e.style }])
        lines.push({ text: e.text, rect: [e.x!, e.baseline! - e.style.size, e.x! + w, e.baseline! + e.style.size * 0.25], baseline: e.baseline!, size: e.style.size })
      }
      out.push({ page, lines })
    }
    return out
  }

  const doExport = useEvent(async () => {
    if (exporting || !hasDoc) return
    const worthSaving = snap.edits.length > 0 || Object.keys(snap.corrections).length > 0 || Object.keys(doc.ocr).length > 0
    if (!worthSaving) {
      notify('Nothing to save yet — edit some text, or recognise a scanned page first.')
      return
    }
    setEditing(null)
    setExporting(true)
    try {
      const layers = await buildLayers()
      const res = await engine.export(snap.edits, layers, { textLayer: true, jpegQuality: 90 })
      setReportInfo({ report: res.report, bytes: res.bytes, edits: snap.edits })
    } catch (e) {
      notify(`Export failed: ${(e as Error).message}`, 'error')
    } finally {
      setExporting(false)
    }
  })

  const download = () => {
    if (!reportInfo) return
    const blob = new Blob([reportInfo.bytes as BlobPart], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${doc.fileName.replace(/\.pdf$/i, '')}-edited.pdf`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const addFont = useEvent(async (f: File) => {
    try {
      await engine.addUserFont(f.name, new Uint8Array(await f.arrayBuffer()))
      setFonts((l) => [...l, f.name])
      notify(`Added font ${f.name}.`, 'ok')
    } catch (e) {
      notify(`Could not use that font: ${(e as Error).message}`, 'error')
    }
  })

  // -------------------------------------------------------------------------------- shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const typing = el.closest('input, textarea, select, [contenteditable="true"]')
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void doExport()
        return
      }
      if (typing) return
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
      } else if (!mod && hasDoc) {
        const key = e.key.toLowerCase()
        if (key === 'e') setTool('edit')
        else if (key === 't') setTool('add')
        else if (key === 'x') setTool('erase')
        else if (key === '+' || key === '=') setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100))
        else if (key === '-') setZoom((z) => Math.max(0.25, Math.round((z - 0.1) * 100) / 100))
        else if (key === 'escape') setEditing(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doExport, hasDoc])

  const pageKinds = useMemo(() => Object.values(doc.infos), [doc.infos])
  const docKind = !pageKinds.length ? null : pageKinds.every((i) => i.kind === 'text') ? 'Searchable' : pageKinds.some(isScanPage) ? 'Contains scans' : 'Searchable'
  const nChanges = snap.edits.length

  // ------------------------------------------------------------------------------------ render
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <Icon name="file" size={18} />
          </span>
          <span className="brand-name">PageDesk</span>
        </div>

        {hasDoc && (
          <>
            <div className="file-pill" title={doc.fileName}>
              <span className="file-name">{doc.fileName}</span>
              {docKind && <span className={`badge ${docKind === 'Searchable' ? 'ok' : 'warn'}`}>{docKind}</span>}
            </div>

            <div className="seg tools" role="radiogroup" aria-label="Tool">
              {(
                [
                  ['edit', 'Edit text', 'pencil', 'E'],
                  ['add', 'Add text', 'type', 'T'],
                  ['erase', 'Erase', 'eraser', 'X'],
                ] as const
              ).map(([id, label, icon, key]) => (
                <button key={id} type="button" role="radio" aria-checked={tool === id} className={tool === id ? 'on' : ''} onClick={() => setTool(id)} title={`${label} (${key})`}>
                  <Icon name={icon} size={16} />
                  <span className="lbl">{label}</span>
                </button>
              ))}
            </div>
            {tool === 'erase' && (
              <label className="check topcheck" title="Paint a black box and destroy the pixels underneath">
                <input type="checkbox" checked={eraseRedact} onChange={(e) => setEraseRedact(e.target.checked)} />
                Black box
              </label>
            )}
          </>
        )}

        <div className="spacer" />

        {hasDoc && (
          <>
            <div className="group">
              <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!doc.past.length} onClick={() => dispatch({ type: 'undo' })}>
                <Icon name="undo" />
              </button>
              <button type="button" className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!doc.future.length} onClick={() => dispatch({ type: 'redo' })}>
                <Icon name="redo" />
              </button>
            </div>
            <div className="group zoom">
              <button type="button" className="icon-btn" aria-label="Zoom out" title="Zoom out (-)" onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.1) * 100) / 100))}>
                <Icon name="zoomOut" />
              </button>
              <span className="zoom-label" aria-live="polite">
                {Math.round(zoom * 100)}%
              </span>
              <button type="button" className="icon-btn" aria-label="Zoom in" title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100))}>
                <Icon name="zoomIn" />
              </button>
            </div>
            <button type="button" className={`btn ghost ${showOriginal ? 'on' : ''}`} aria-pressed={showOriginal} onClick={() => setShowOriginal((v) => !v)} title="Show the original, without your changes">
              <Icon name="eye" size={16} />
              <span className="lbl">Original</span>
            </button>
            <button type="button" className={`icon-btn ${thumbsOpen ? 'on' : ''}`} aria-label="Toggle page list" aria-pressed={thumbsOpen} title="Pages" onClick={() => setThumbsOpen((v) => !v)}>
              <Icon name="sidebar" />
            </button>
            <button type="button" className={`icon-btn ${panelOpen ? 'on' : ''}`} aria-label="Toggle side panel" aria-pressed={panelOpen} title="Changes & proofreading" onClick={() => setPanelOpen((v) => !v)}>
              <Icon name="panel" />
            </button>
          </>
        )}

        <button type="button" className="icon-btn" aria-label="Fonts for other scripts" title="Fonts for other scripts" onClick={() => setFontsOpen(true)}>
          <Icon name="font" />
        </button>
        <button type="button" className="icon-btn" aria-label={`Theme: ${theme}`} title={`Theme: ${theme} (click to change)`} onClick={() => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')}>
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" size={16} />
          <span className="lbl">Open</span>
        </button>
        {hasDoc && (
          <button type="button" className="btn primary" disabled={exporting} onClick={() => void doExport()} title="Save, then verify (Ctrl+S)">
            <Icon name={exporting ? 'loader' : 'download'} size={16} className={exporting ? 'spin' : ''} />
            {exporting ? 'Verifying…' : 'Save & verify'}
            {!exporting && nChanges > 0 && <span className="count">{nChanges}</span>}
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void openFile(f)
            e.target.value = ''
          }}
        />
      </header>

      {!hasDoc ? (
        <Welcome onOpen={() => fileInput.current?.click()} onSample={(kind) => void openSample(kind)} dragging={dragging} loading={loading} />
      ) : (
        <div className="body" data-thumbs={thumbsOpen} data-panel={panelOpen}>
          {thumbsOpen && <Thumbs engine={engine} docId={doc.docId} sizes={doc.sizes} infos={doc.infos} editsOf={editsOf} current={current} onGo={scrollToPage} />}

          <ScrollRootContext.Provider value={scroller}>
            <div className={`viewer tool-${tool}`} ref={setScroller} onScroll={onScroll}>
              <div className={`hint ${hintVisible ? 'show' : ''}`} aria-live="polite">
                {showOriginal
                  ? 'Showing the original — your changes are hidden.'
                  : tool === 'edit'
                    ? 'Click any text to edit it.'
                    : tool === 'add'
                      ? 'Click where the new text should go.'
                      : eraseRedact
                        ? 'Drag over an area to redact it with a black box.'
                        : 'Drag over an area to erase what’s there.'}
              </div>
              <div className="pages" style={{ padding: PAD, gap: GAP }}>
                {doc.sizes.map((size, i) => (
                  <PageView
                    key={`${doc.docId}:${i}`}
                    index={i}
                    size={size}
                    k={k}
                    dpr={dpr}
                    docId={doc.docId}
                    engine={engine}
                    info={doc.infos[i]}
                    runs={doc.runs[i] ?? []}
                    edits={editsOf(i)}
                    showOriginal={showOriginal}
                    tool={tool}
                    flagged={flaggedByPage.get(i) ?? EMPTY_SET}
                    flagReasons={reasonsByPage.get(i) ?? EMPTY_MAP}
                    verified={snap.verified}
                    corrections={snap.corrections}
                    proofMode={panelOpen && panelTab === 'proof'}
                    activeRunId={editing?.page === i && editing.kind === 'run' ? editing.runId : null}
                    highlightRunId={highlightRunId && doc.runs[i]?.some((r) => r.id === highlightRunId) ? highlightRunId : null}
                    ocrBusy={!!ocrJob}
                    ocrHere={!!doc.ocr[i]}
                    editor={editorFor(i)}
                    onVisible={ensurePage}
                    onPickRun={startRun}
                    onPickEdit={startEdit}
                    onAddAt={startAdd}
                    onErase={doErase}
                    onRecognize={(p) => void runOcr([p])}
                  />
                ))}
              </div>
              <div className="page-indicator" aria-live="polite">
                Page {current + 1} / {doc.sizes.length}
              </div>
            </div>
          </ScrollRootContext.Provider>

          {panelOpen && (
            <aside className="panel" aria-label="Changes and proofreading">
              <div className="tabs" role="tablist">
                <button type="button" role="tab" aria-selected={panelTab === 'changes'} className={panelTab === 'changes' ? 'on' : ''} onClick={() => setPanelTab('changes')}>
                  Changes
                  {nChanges > 0 && <span className="count">{nChanges}</span>}
                </button>
                <button type="button" role="tab" aria-selected={panelTab === 'proof'} className={panelTab === 'proof' ? 'on' : ''} onClick={() => setPanelTab('proof')}>
                  Proofread
                  {totalFlagged > 0 ? <span className="count warn">{totalFlagged}</span> : anyScan && proofStats.total === 0 ? <span className="dot" title="Scanned pages need recognising" /> : null}
                </button>
              </div>
              <div className="panel-body">
                {panelTab === 'changes' ? (
                  <ChangesPanel edits={snap.edits} corrections={Object.keys(snap.corrections).length} onJump={jumpToEdit} onRemove={(id) => dispatch({ type: 'commit', fn: removeEdit(id) })} />
                ) : (
                  <ProofPanel
                    engine={engine}
                    docId={doc.docId}
                    runs={doc.runs}
                    infos={doc.infos}
                    snapshot={snap}
                    threshold={threshold}
                    setThreshold={setThreshold}
                    lang={lang}
                    setLang={setLang}
                    ocrJob={ocrJob}
                    scanPages={scanPages}
                    currentPage={current}
                    onRecognize={(pages) => (pages.length === 1 ? void runOcr(pages) : void recognizeAll())}
                    onFocusRun={focusProofRun}
                    onConfirm={confirmProof}
                  />
                )}
              </div>
            </aside>
          )}
        </div>
      )}

      {dragging && hasDoc && (
        <div className="drop-overlay">
          <Icon name="upload" size={40} />
          <p>Drop to open this PDF</p>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role="status">
          <Icon name={toast.kind === 'error' ? 'alert' : toast.kind === 'ok' ? 'checkCircle' : 'info'} size={18} />
          <span>{toast.msg}</span>
          {toast.action && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                toast.action!.run()
                setToast(null)
              }}
            >
              {toast.action.label}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon name="x" size={15} />
          </button>
        </div>
      )}

      {password && <PasswordModal error={password.error} onClose={() => setPassword(null)} onSubmit={(pw) => void openBytes(password.bytes.slice(), password.name, pw)} />}
      {fontsOpen && <FontsModal fonts={fonts} onAdd={(f) => void addFont(f)} onClose={() => setFontsOpen(false)} />}
      {reportInfo && <ReportModal report={reportInfo.report} edits={reportInfo.edits} proof={proofStats} fileName={doc.fileName} size={reportInfo.bytes.length} onDownload={download} onClose={() => setReportInfo(null)} />}
    </div>
  )
}
