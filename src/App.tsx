import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Edit, FontStyle, Overlay, PageInfo, Rect, Rgb, TableEdit, TableModel, TextLayer, TextLayerLine, TextRun, VerifyReport } from './engine/types.ts'
import { colCount, deleteColumns, deleteRows, distributeColumns, fitWidth, insertColumn, insertRow, mapCells, moveBoundary, rowCount, setBorders, tableBounds, translateTable, zebra, type CellRange } from './engine/table.ts'
import { findMatches, replaceIn, type FindOptions } from './engine/find.ts'
import { overlayBounds } from './engine/overlay.ts'
import { sameStyle } from './engine/plan.ts'
import { cloudApi, type CloudDoc } from './cloud/api.ts'
import { buildDraft, draftEditCount, encodeDraft, imagesUsedBy, parseDraft, summarizeEdits, toRestore, type DraftImage, type DraftV1 } from './cloud/draft.ts'
import { ago, LibraryModal } from './cloud/LibraryModal.tsx'
import { useCloud } from './cloud/useCloud.ts'
import { useSettingsSync } from './cloud/useSettingsSync.ts'
import { recognizePage, reviewReasons, withText } from './ocr/ocr.ts'
import { DEFAULT_DRAW, imageOverlay, restyle, signatureOverlay, type Signature } from './ui/draw.ts'
import { addUserFont, engine } from './ui/engine.ts'
import { FindPanel } from './ui/FindPanel.tsx'
import { ScrollRootContext, useEvent, usePageEdits, useStoredState } from './ui/hooks.ts'
import { Icon } from './ui/icons.tsx'
import { TOUCH } from './ui/touch.ts'
import { prepareImage } from './ui/imageprep.ts'
import { InlineEditor, type EditorResult } from './ui/InlineEditor.tsx'
import { MoreMenu, type MoreItem } from './ui/MoreMenu.tsx'
import { ConfirmModal, FontsModal, PasswordModal, ReportModal, SignatureModal } from './ui/Modals.tsx'
import { PageView } from './ui/PageView.tsx'
import { ChangesPanel, ProofPanel } from './ui/Panels.tsx'
import { Ribbon, SIGN_COLORS } from './ui/Ribbon.tsx'
import { TablePanel, type TableOps } from './ui/TablePanel.tsx'
import { docReducer, effectiveText, initialDoc, isScanPage, markVerified, pictureEditFor, removeEdit, setCorrection, uid, updateOverlayEdit, upsertEdit, type Snapshot } from './ui/store.ts'
import { Thumbs } from './ui/Thumbs.tsx'
import { TOOLS, type ToolId } from './ui/tools/meta.ts'
import { ToolView } from './ui/tools/ToolView.tsx'
import { allKeysOnPage, clampMove, isDeletable, isScanRun, itemRect, moveEditIn, moveItems, moveRunIn, resolveSelection, unionRect } from './ui/select.ts'
import { selId, type DrawStyle, type EditingTarget, type FindBox, type PicInfo, type SelKey, type TableApi, type TableView, type Tool } from './ui/types.ts'
import { Welcome } from './ui/Welcome.tsx'

/** Which screen is showing: the start page, the PDF editor, or one of the PDF tools. */
type View = 'home' | 'editor' | ToolId

const PAD = 28
const GAP = 20
const PX_PER_PT = 96 / 72
const DEFAULT_ADD_STYLE: FontStyle = { family: 'sans', bold: false, italic: false, size: 12, color: [0, 0, 0] }
const NO_BOXES: FindBox[] = []
const NO_SEL: SelKey[] = []

/** A finger, not a mouse: the help says "tap", and the tools that drag on the page mention how to scroll. */
const DRAGS_ON_PAGE = new Set<Tool>(['select', 'erase', 'highlight', 'underline', 'strike', 'rect', 'ellipse', 'line', 'arrow', 'pen', 'table'])
const touchHint = (tool: Tool, text: string) => (TOUCH ? text.replace(/\bClick\b/g, 'Tap') + (DRAGS_ON_PAGE.has(tool) ? ' Two fingers scroll and zoom.' : '') : text)

/** One line of help that appears for a few seconds when you pick a tool. */
const HINTS: Record<Tool, (redact: boolean) => string> = {
  select: () => (TOUCH ? 'Tap anything to select it, then drag it to move it, or drag a box around several.' : 'Click anything to select it, then drag it to move it. Shift-click adds to the selection, drag a box around several, or press Ctrl+A for the whole page.'),
  edit: () => 'Click any text to edit it.',
  add: () => 'Click where the new text should go.',
  erase: (redact) => (redact ? 'Drag over an area to redact it with a black box.' : 'Drag over an area to erase what’s there.'),
  highlight: () => 'Drag across text to highlight it — or drag a box over a picture.',
  underline: () => 'Drag across text to underline it.',
  strike: () => 'Drag across text to strike it out.',
  rect: () => 'Drag to draw a rectangle. Hold Shift for a square.',
  ellipse: () => 'Drag to draw an ellipse. Hold Shift for a circle.',
  line: () => 'Drag to draw a line. Hold Shift to snap to 45°.',
  arrow: () => 'Drag from the tail to the point of the arrow.',
  pen: () => 'Draw freehand.',
  image: () => 'Click where the picture should go.',
  sign: () => 'Click where your signature should go.',
  table: () => 'Click inside a table to edit it — or drag a box around a table that has no lines.',
}

/** Opening a file from the cloud library: which library file it is, and the draft to carry on from. */
interface OpenOpts {
  cloudId?: string
  draft?: DraftV1 | null
  /** when that draft was last saved */
  draftAt?: string
}

type DraftStatus = { kind: 'idle' | 'dirty' | 'saving' | 'saved' | 'error'; at?: string; msg?: string }

interface Toast {
  id: number
  kind: 'info' | 'ok' | 'error'
  msg: string
  action?: { label: string; run: () => void }
}

/** Hand a file to the browser as a download. */
function saveBytes(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
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

/** `run` should now read `text` (as a picture edit, like typing it in the editor): adds, updates or removes its edit. */
function withRunText(s: Snapshot, run: TextRun, text: string): Snapshot {
  const scan = run.source === 'ocr' || run.hidden
  const existing = pictureEditFor(s.edits, run.id)
  const base = scan ? withText(run, s.corrections[run.id] ?? run.text) : run
  if (text === base.text && !existing?.move && (!existing || sameStyle(existing.style, base.style))) return existing ? removeEdit(existing.id)(s) : s
  return upsertEdit({ id: existing?.id ?? uid(), page: run.page, kind: 'replace', run: existing?.run ?? base, text, style: existing?.style ?? run.style, keepPrefix: existing?.keepPrefix, ...(existing?.move ? { move: existing.move } : {}) })(s)
}

export default function App() {
  const [doc, dispatch] = useReducer(docReducer, initialDoc)
  const { present: snap } = doc
  const [view, setView] = useState<View>('home')
  const [confirmClose, setConfirmClose] = useState(false)
  const viewRef = useRef<View>('home')
  viewRef.current = view
  const docIdRef = useRef(0)
  docIdRef.current = doc.docId
  const [theme, setTheme] = useStoredState<'system' | 'light' | 'dark'>('pagedesk-theme', 'system')
  const [tool, setTool] = useState<Tool>('edit')
  const [zoom, setZoom] = useState(1)
  const [editing, setEditing] = useState<EditingTarget | null>(null)
  const [showOriginal, setShowOriginal] = useState(false)
  const [eraseRedact, setEraseRedact] = useState(false)
  const [addStyle, setAddStyle] = useState<FontStyle>(DEFAULT_ADD_STYLE)
  // (on a phone the panel floats over the page, so it starts closed there)
  const [panelOpen, setPanelOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 720)
  const [panelTab, setPanelTab] = useState<'changes' | 'proof' | 'find' | 'table'>('changes')
  // the table being edited: where it is, which edit holds it (once changed) and the table as first found
  const [tableCtx, setTableCtx] = useState<{ page: number; editId: string | null; base: TableEdit } | null>(null)
  const [tableSel, setTableSel] = useState<CellRange | null>(null)
  const [tableCell, setTableCell] = useState<[number, number] | null>(null)
  const liveTable = useRef<TableModel | null>(null)
  const tableBusy = useRef(0)
  const openTableRef = useRef<(page: number, edit: TableEdit, editId: string | null) => void>(() => {})
  const [drawStyle, setDrawStyle] = useStoredState<DrawStyle>('pagedesk-draw-style', DEFAULT_DRAW)
  // What the Select tool has picked (on one page). Stored as it was picked; `picked` below is what it still means.
  const [selection, setSelection] = useState<SelKey[]>([])
  const [images, setImages] = useState<ReadonlyMap<string, PicInfo>>(new Map())
  const [pendingImage, setPendingImage] = useState<{ id: string; name: string; aspect: number } | null>(null)
  const [signature, setSignature] = useStoredState<Signature | null>('pagedesk-signature', null)
  const [signInk, setSignInk] = useState<Rgb>(SIGN_COLORS[0].rgb)
  const [signOpen, setSignOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findReplacement, setFindReplacement] = useState('')
  const [findOpts, setFindOpts] = useStoredState<FindOptions>('pagedesk-find-opts', { matchCase: false, wholeWord: false })
  const [findIndex, setFindIndex] = useState(0)
  const [readingAll, setReadingAll] = useState<{ done: number; total: number } | null>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const allRead = useRef(0)
  const [thumbsOpen, setThumbsOpen] = useState(true)
  const [current, setCurrent] = useState(0)
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [password, setPassword] = useState<{ bytes: Uint8Array; name: string; error: boolean; opts?: OpenOpts } | null>(null)
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

  // ------------------------------------------------------------------------------------ cloud
  const cloud = useCloud()
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [cloudBusy, setCloudBusy] = useState<string | null>(null)
  /** the library file that is open in the editor (its draft is kept up to date), or null for a local file */
  const [docCloud, setDocCloud] = useState<{ id: string } | null>(null)
  const [draftStatus, setDraftStatus] = useState<DraftStatus>({ kind: 'idle' })
  const [keeping, setKeeping] = useState<'idle' | 'busy' | 'done'>('idle')
  const [, setClock] = useState(0)
  /** the opened file exactly as it was loaded, for "Save to cloud" */
  const original = useRef<Uint8Array | null>(null)
  const imageBytes = useRef(new Map<string, { bytes: Uint8Array; type: string; width: number; height: number }>())
  const imageDocs = useRef(new Map<string, string>())
  /** what the cloud's draft holds right now (identity of the state it came from, and its JSON) */
  const lastDraft = useRef<{ json: string | null; snap: Snapshot | null; ocr: unknown }>({ json: null, snap: null, ocr: null })
  const draftQueue = useRef<Promise<void>>(Promise.resolve())
  const latest = useRef<{ snap: Snapshot | null; ocr: unknown }>({ snap: null, ocr: null })

  const hasDoc = doc.sizes.length > 0
  /** the editor is on screen (a document can stay open in the background while you use the home page or a tool) */
  const inEditor = hasDoc && view === 'editor'
  const k = zoom * PX_PER_PT
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
  const editsOf = usePageEdits(snap.edits)
  latest.current = { snap, ocr: doc.ocr }

  // ------------------------------------------------------------------------------ the Select tool's pick
  const runsOfPage = useCallback((page: number) => doc.runs[page] ?? [], [doc.runs])
  const resolvedPick = useMemo(() => resolveSelection(selection, snap, runsOfPage), [selection, snap, runsOfPage])
  // the same array for as long as the pick means the same things, so pages that are not involved do not redraw
  const pickCache = useRef<{ key: string; list: SelKey[] }>({ key: '', list: [] })
  const pickKey = resolvedPick.map(selId).join('|')
  if (pickCache.current.key !== pickKey) pickCache.current = { key: pickKey, list: resolvedPick }
  const picked = pickCache.current.list
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const pickByPage = useMemo(() => {
    const m = new Map<number, SelKey[]>()
    for (const k of picked) m.set(k.page, [...(m.get(k.page) ?? []), k])
    return m
  }, [picked])
  /** the one shape that is picked on its own (it gets resize handles and the style controls) */
  const selectedId = picked.length === 1 && picked[0].kind === 'overlay' ? picked[0].id : null
  const setSelectedId = useCallback((id: string | null, page = 0) => setSelection(id ? [{ kind: 'overlay', id, page }] : []), [])

  // ------------------------------------------------------------------------------------- theme
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    // the phone's status bar (and an installed app's title bar) takes the app's colour, in the chosen theme
    for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      const dark = theme === 'system' ? m.media.includes('dark') : theme === 'dark'
      m.content = dark ? '#111a2e' : '#ffffff'
    }
  }, [theme])

  // A selection only makes sense with the Select tool.
  useEffect(() => {
    if (tool !== 'select') setSelectedId(null)
  }, [tool])

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
  /** Put a draft's pictures back into the editor. Pictures that cannot be fetched are reported, and their marks left out. */
  const fetchDraftImages = async (d: DraftV1): Promise<Set<string>> => {
    const missing = new Set<string>()
    const fresh = new Map<string, PicInfo>()
    for (const [id, im] of Object.entries(d.images)) {
      try {
        const { bytes } = await cloudApi.download(im.documentId)
        await engine.addImage(id, bytes)
        imageBytes.current.set(id, { bytes, type: im.type, width: im.width, height: im.height })
        imageDocs.current.set(id, im.documentId)
        fresh.set(id, { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: im.type || 'image/png' })), width: im.width, height: im.height })
      } catch {
        missing.add(id)
      }
    }
    if (fresh.size) setImages((prev) => new Map([...prev, ...fresh]))
    return missing
  }

  const openBytes = useEvent(async (bytes: Uint8Array, name: string, pw?: string, opts?: OpenOpts) => {
    setLoading(true)
    const keep = bytes.slice()
    try {
      const res = await engine.open(bytes, pw)
      if (res.status === 'password') {
        setPassword({ bytes: keep, name, error: !!pw, opts })
        return
      }
      if (res.status === 'error') {
        notify(res.message, 'error')
        return
      }
      setPassword(null)
      loadingPages.current.clear()
      // anything still waiting to be sent for the file that is open now goes first (it is a no-op when nothing is pending)
      await writeDraft()
      // pictures placed on the previous file are not needed any more
      for (const pic of images.values()) URL.revokeObjectURL(pic.url)
      setImages(new Map())
      setPendingImage(null)
      imageBytes.current.clear()
      imageDocs.current.clear()
      let restore: ReturnType<typeof toRestore> | undefined
      if (opts?.draft) {
        const missing = await fetchDraftImages(opts.draft)
        restore = toRestore(opts.draft, missing, res.sizes.length)
        if (missing.size) notify(`${missing.size} picture${missing.size === 1 ? '' : 's'} from the draft could not be loaded and ${missing.size === 1 ? 'was' : 'were'} left out.`, 'error')
      }
      original.current = keep
      // a restored draft is what the cloud holds already: nothing to save until something changes
      lastDraft.current = restore ? { json: '', snap: restore.snapshot, ocr: restore.ocr } : { json: null, snap: null, ocr: null }
      setDocCloud(opts?.cloudId ? { id: opts.cloudId } : null)
      setDraftStatus(restore ? { kind: 'saved', at: opts?.draftAt } : { kind: 'idle' })
      setKeeping('idle')
      dispatch({ type: 'open', fileName: name, sizes: res.sizes, restore })
      if (restore) notify('Picked up where you left off — your unsaved edits are back.', 'ok')
      setView('editor')
      setEditing(null)
      setSelectedId(null)
      setFindQuery('')
      setTool('edit')
      setShowOriginal(false)
      setCurrent(0)
      setHighlightRunId(null)
      setReportInfo(null)
      setPanelTab('changes')
      // fit the page into what is left beside the side columns (the page list hides below 940 px, the panel floats over below 720 px)
      const vw = window.innerWidth
      const fit = (vw - (vw > 940 && thumbsOpen ? 168 : 0) - (vw > 720 && panelOpen ? 360 : 0) - PAD * 2 - 24) / (res.sizes[0].width * PX_PER_PT)
      setZoom(Math.round(Math.max(0.3, Math.min(1.6, fit)) * 20) / 20)
      savedScroll.current = 0
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

  const openSample = useEvent(async (kind: 'text' | 'scan' | 'table') => {
    const file = kind === 'text' ? 'invoice-searchable.pdf' : kind === 'scan' ? 'invoice-scanned.pdf' : 'table-roadmap.pdf'
    const res = await fetch(`${import.meta.env.BASE_URL}samples/${file}`)
    await openBytes(new Uint8Array(await res.arrayBuffer()), file)
  })

  // ---------------------------------------------------------------------------------- navigation
  /** Back to the start page. An open document stays open (and offered again there), so nothing is lost. */
  const goHome = useEvent(() => {
    setEditing(null)
    setView('home')
  })
  // The browser's Back button (an Android swipe, too) moves between the start page, the editor and the tools, like
  // screens in an app, instead of leaving the site. An open document is never lost by it (Home keeps it open).
  const popTo = useEvent((v: View | undefined) => {
    const target: View = v && (v !== 'editor' || hasDoc) ? v : 'home'
    setEditing(null)
    setView(target)
    if (target !== v) history.replaceState({ pagedesk: target }, '')
  })
  useEffect(() => {
    history.replaceState({ pagedesk: 'home' }, '')
    const onPop = (e: PopStateEvent) => popTo(e.state?.pagedesk)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [popTo])
  useEffect(() => {
    if (history.state?.pagedesk !== view) history.pushState({ pagedesk: view }, '')
  }, [view])
  const closeDoc = useEvent(() => {
    dispatch({ type: 'close' })
    setDocCloud(null)
    setDraftStatus({ kind: 'idle' })
    original.current = null
    loadingPages.current.clear()
    void engine.closeDoc().catch(() => {})
    setEditing(null)
    setReportInfo(null)
    setHighlightRunId(null)
    setConfirmClose(false)
    setView('home')
  })
  const hasUnsaved = snap.edits.length > 0 || Object.keys(snap.corrections).length > 0
  const requestClose = useEvent(() => {
    if (ocrJob) notify('Text recognition is still running — wait for it to finish, then close the file.')
    else if (hasUnsaved) setConfirmClose(true)
    else closeDoc()
  })
  const openFromTool = useEvent((bytes: Uint8Array, name: string) => void openBytes(bytes.slice(), name))

  // ------------------------------------------------------------- cloud: library, drafts, settings
  const progress = (what: string) => (done: number, total: number) => setCloudBusy(`${what} ${Math.round((done / Math.max(1, total)) * 100)}%`)

  /** Open a library file; `withDraft` carries on from its unsaved edits, otherwise it opens fresh (and drops the old draft). */
  const openFromCloud = useEvent(async (d: CloudDoc, withDraft: boolean) => {
    setCloudBusy('Downloading…')
    try {
      const { bytes } = await cloudApi.download(d.id, progress('Downloading'))
      let draft: DraftV1 | null = null
      if (d.draft && withDraft) {
        draft = parseDraft((await cloudApi.getDraft(d.id))?.state)
        if (!draft) notify('The saved draft could not be read, so the file was opened without it.', 'error')
      } else if (d.draft) {
        await cloudApi.deleteDraft(d.id)
        // if that very file is open, its edits were just thrown away on purpose: do not let the "send what is pending"
        // step before opening bring the draft back
        if (docCloud?.id === d.id) lastDraft.current = { json: null, snap: latest.current.snap, ocr: latest.current.ocr }
      }
      setLibraryOpen(false)
      await openBytes(bytes, d.name, undefined, { cloudId: d.id, draft, draftAt: d.draft?.updatedAt })
      void cloud.refresh()
    } catch (e) {
      notify(`Could not open it from the cloud: ${(e as Error).message}`, 'error')
    } finally {
      setCloudBusy(null)
    }
  })

  const downloadFromCloud = useEvent(async (d: CloudDoc) => {
    setCloudBusy('Downloading…')
    try {
      const { bytes, name } = await cloudApi.download(d.id, progress('Downloading'))
      saveBytes(bytes, name)
    } catch (e) {
      notify(`Could not download it: ${(e as Error).message}`, 'error')
    } finally {
      setCloudBusy(null)
    }
  })

  const deleteFromCloud = useEvent(async (d: CloudDoc) => {
    try {
      await cloudApi.deleteDocument(d.id)
      if (docCloud?.id === d.id) {
        setDocCloud(null)
        setDraftStatus({ kind: 'idle' })
      }
      await cloud.refresh()
      notify(`Deleted ${d.name} from the cloud.`, 'ok')
    } catch (e) {
      notify(`Could not delete it: ${(e as Error).message}`, 'error')
    }
  })

  /** Put the open file in the library. From then on its unsaved edits are kept as a draft. */
  const saveToCloud = useEvent(async () => {
    if (cloud.status !== 'ready') return setLibraryOpen(true)
    const bytes = original.current
    if (!bytes || !hasDoc || cloudBusy) return
    setCloudBusy('Uploading…')
    try {
      const r = await cloudApi.upload(bytes, { name: doc.fileName, kind: 'original', pages: doc.sizes.length }, progress('Uploading'))
      const list = await cloudApi.listDocuments()
      if (list.documents.find((x) => x.id === r.id)?.draft) {
        // this exact file was saved before and has unsaved edits kept: never write over them from here
        notify('This file is already in your library with a draft. Open it from the library to carry on, or choose “Start over” there.', 'info', { label: 'Open library', run: () => setLibraryOpen(true) })
      } else {
        setDocCloud({ id: r.id })
        notify(r.existing ? 'This file was already in your library — linked to it. Unsaved edits are kept as a draft.' : 'Saved to your cloud library. Unsaved edits are kept as a draft from now on.', 'ok')
      }
      void cloud.refresh()
    } catch (e) {
      notify(`Could not save to the cloud: ${(e as Error).message}`, 'error')
    } finally {
      setCloudBusy(null)
    }
  })

  /** Write the current edits to the cloud as this file's draft (one at a time, newest wins). */
  const writeDraft = useEvent(async () => {
    const id = docCloud?.id
    if (!id || cloud.status !== 'ready') return
    const s = snap
    const o = doc.ocr
    const runs = doc.runs
    // A write that is still queued or in flight when you open another file must not touch that file's draft state:
    // it finishes its upload for the old file and leaves everything else alone.
    const session = doc.docId
    const live = () => docIdRef.current === session
    const status = (v: DraftStatus | ((st: DraftStatus) => DraftStatus)) => live() && setDraftStatus(v)
    const remember = (v: { json: string | null; snap: Snapshot | null; ocr: unknown }) => {
      if (live()) lastDraft.current = v
    }
    // "saved" only while nothing newer has been made since
    const settled = (at?: string): DraftStatus => (latest.current.snap === s && latest.current.ocr === o ? { kind: 'saved', at } : { kind: 'dirty', at })
    draftQueue.current = draftQueue.current.then(async () => {
      if (!live()) return
      if (lastDraft.current.snap === s && lastDraft.current.ocr === o) {
        status((st) => (st.kind === 'dirty' ? settled(st.at) : st))
        return
      }
      status((st) => ({ ...st, kind: 'saving' }))
      try {
        if (draftEditCount(s) === 0 && Object.keys(o).length === 0) {
          // nothing left to keep (everything was undone): drop the old draft
          if (lastDraft.current.json !== null) await cloudApi.deleteDraft(id)
          remember({ json: null, snap: s, ocr: o })
          status(latest.current.snap === s && latest.current.ocr === o ? { kind: 'idle' } : { kind: 'dirty' })
          return
        }
        const images: Record<string, DraftImage> = {}
        for (const imgId of imagesUsedBy(s.edits)) {
          const have = imageBytes.current.get(imgId)
          if (!have) continue
          let documentId = imageDocs.current.get(imgId)
          if (!documentId) {
            documentId = (await cloudApi.upload(have.bytes, { name: `picture-${imgId}`, kind: 'asset' })).id
            imageDocs.current.set(imgId, documentId)
          }
          images[imgId] = { documentId, width: have.width, height: have.height, type: have.type }
        }
        const enc = encodeDraft(buildDraft(s, o, runs, images))
        if (!enc) {
          status({ kind: 'error', msg: 'This draft is too large to keep in the cloud. Save & verify and keep the PDF instead.' })
          return
        }
        let at: string | undefined
        if (enc.json === lastDraft.current.json) status((st) => settled(st.at ?? new Date().toISOString()))
        else {
          at = await cloudApi.putDraft(id, enc.draft, draftEditCount(s))
          status(settled(at))
        }
        remember({ json: enc.json, snap: s, ocr: o })
      } catch (e) {
        status({ kind: 'error', msg: (e as Error).message })
      }
    })
    await draftQueue.current
  })

  // Edits are sent a moment after you stop making them.
  useEffect(() => {
    if (!docCloud || cloud.status !== 'ready' || !hasDoc) return
    if (lastDraft.current.snap === snap && lastDraft.current.ocr === doc.ocr) return
    setDraftStatus((st) => (st.kind === 'dirty' || st.kind === 'saving' ? st : { ...st, kind: 'dirty' }))
    const t = setTimeout(() => void writeDraft(), 2500)
    return () => clearTimeout(t)
  }, [snap, doc.ocr, docCloud, cloud.status, hasDoc, writeDraft])

  // The "saved 3 min ago" label keeps itself fresh.
  useEffect(() => {
    if (!docCloud) return
    const t = setInterval(() => setClock((c) => c + 1), 30_000)
    return () => clearInterval(t)
  }, [docCloud])

  // Preferences follow you between devices.
  const applySetting = useEvent((key: string, v: unknown) => {
    if (key === 'pagedesk-signature') setSignature((v ?? null) as Signature | null)
    else if (key === 'pagedesk-draw-style' && v && typeof v === 'object') setDrawStyle(v as DrawStyle)
    else if (key === 'pagedesk-theme' && (v === 'system' || v === 'light' || v === 'dark')) setTheme(v)
    else if (key === 'pagedesk-ocr-lang' && typeof v === 'string') setLang(v)
    else if (key === 'pagedesk-flag-threshold' && typeof v === 'number') setThreshold(v)
    else if (key === 'pagedesk-find-opts' && v && typeof v === 'object') setFindOpts(v as FindOptions)
  })
  useSettingsSync(cloud.status === 'ready', { 'pagedesk-signature': signature, 'pagedesk-draw-style': drawStyle, 'pagedesk-theme': theme, 'pagedesk-ocr-lang': lang, 'pagedesk-flag-threshold': threshold, 'pagedesk-find-opts': findOpts }, applySetting)

  const openLibrary = useEvent(() => {
    setLibraryOpen(true)
    if (cloud.status === 'ready') void cloud.refresh()
  })
  const recentDocs = useMemo(() => {
    const own = cloud.documents.filter((d) => d.kind !== 'asset')
    return [...own.filter((d) => d.draft), ...own.filter((d) => !d.draft)].slice(0, 4)
  }, [cloud.documents])

  // Files dropped anywhere on the home page or the editor open in the editor. Each PDF tool has its own drop
  // zones (they stop the event), and a stray drop on a tool page is ignored rather than opening a different screen.
  useEffect(() => {
    const editable = () => viewRef.current === 'home' || viewRef.current === 'editor'
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files') || !editable()) return
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
      if (f && editable()) void openFile(f)
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

  // Leaving with unsaved edits asks first — unless they are already safe in the cloud as a draft.
  const draftSafe = !!docCloud && cloud.status === 'ready' && draftStatus.kind === 'saved'
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!draftSafe && (snap.edits.length || Object.keys(snap.corrections).length)) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [snap.edits.length, snap.corrections, draftSafe])

  // -------------------------------------------------------------------------- lazy page loading
  const ensurePage = useEvent(async (i: number) => {
    const startId = doc.docId
    const key = `${startId}:${i}`
    if (doc.infos[i] || loadingPages.current.has(key)) return
    loadingPages.current.add(key)
    try {
      const [info, runs] = await Promise.all([engine.analyze(i), engine.getRuns(i)])
      if (docIdRef.current !== startId) return // the document was closed or replaced meanwhile
      dispatch({ type: 'pageLoaded', info, runs })
    } catch (e) {
      loadingPages.current.delete(key)
      console.error('page load failed', e)
    }
  })

  // Pages that were recognised before (a restored draft) need their page info loaded, so Save can write their text layer.
  useEffect(() => {
    for (const p of Object.keys(doc.ocr)) if (!doc.infos[Number(p)]) void ensurePage(Number(p))
  }, [doc.docId, doc.ocr, doc.infos, ensurePage])

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

  // The editor stays mounted (hidden) while you visit the home page or a tool, but a hidden element forgets
  // its scroll offset, so remember it and put it back.
  const savedScroll = useRef(0)
  useLayoutEffect(() => {
    if (view === 'editor' && scroller) scroller.scrollTop = savedScroll.current
  }, [view, scroller])

  const onScroll = useEvent(() => {
    if (!scroller || !tops.length) return
    if (viewRef.current === 'editor') savedScroll.current = scroller.scrollTop
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
  const isPhone = () => window.matchMedia('(max-width: 720px)').matches
  const scrollToRect = useEvent((page: number, rect: Rect, sheetOver = panelOpen && isPhone()) => {
    if (!scroller) return
    // (on a phone the open panel is a sheet over the lower part of the screen: keep the thing in the strip above it)
    scroller.scrollTo({ top: Math.max(0, (tops[page] ?? 0) + rect[1] * k - scroller.clientHeight * (sheetOver ? 0.08 : 0.3)), behavior: 'smooth' })
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

  // Two fingers on the page (phones and tablets): pinch to zoom and drag to pan. One finger stays with the tool —
  // it scrolls the page, or draws / moves, depending on the tool (see `touch-action` in the CSS).
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const scrollTarget = useRef<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const t = scrollTarget.current
    scrollTarget.current = null
    if (!t || !scroller) return
    scroller.scrollLeft = t.left
    scroller.scrollTop = t.top
  }, [zoom, scroller])
  useEffect(() => {
    if (!scroller) return
    type Pinch = { z0: number; d0: number; px: number; py: number }
    let g: Pinch | null = null
    const centre = (t: TouchList) => {
      const r = scroller.getBoundingClientRect()
      const a = t[0]
      const b = t[1]
      return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) }
    }
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return void (g = null)
      const c = centre(e.touches)
      const z = zoomRef.current
      // the point of the page under the fingers, in "100 %" units, so it can be kept there while the zoom changes
      g = { z0: z, d0: Math.max(1, c.d), px: (scroller.scrollLeft + c.x - PAD) / z, py: (scroller.scrollTop + c.y - PAD) / z }
    }
    const onMove = (e: TouchEvent) => {
      if (!g || e.touches.length !== 2) return
      e.preventDefault()
      const c = centre(e.touches)
      const z = Math.min(4, Math.max(0.25, Math.round(g.z0 * (c.d / g.d0) * 100) / 100))
      const left = g.px * z + PAD - c.x
      const top = g.py * z + PAD - c.y
      if (z === zoomRef.current) {
        scroller.scrollLeft = left
        scroller.scrollTop = top
      } else {
        scrollTarget.current = { left, top }
        setZoom(z)
      }
    }
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) g = null
    }
    scroller.addEventListener('touchstart', onStart, { passive: true })
    scroller.addEventListener('touchmove', onMove, { passive: false })
    scroller.addEventListener('touchend', onEnd)
    scroller.addEventListener('touchcancel', onEnd)
    return () => {
      scroller.removeEventListener('touchstart', onStart)
      scroller.removeEventListener('touchmove', onMove)
      scroller.removeEventListener('touchend', onEnd)
      scroller.removeEventListener('touchcancel', onEnd)
    }
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
  const runsOf = runsOfPage

  const startRun = useEvent((page: number, runId: string) => {
    const run = runsOf(page).find((r) => r.id === runId)
    if (!run) return
    const [mx, my] = pictureEditFor(snap.edits, run.id)?.move ?? [0, 0] // a line that was moved is edited where it now is
    setEditing({ page, kind: 'run', runId, bg: sampleBg(page, [run.rect[0] + mx, run.rect[1] + my, run.rect[2] + mx, run.rect[3] + my], doc.sizes[page].width) })
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
        // nothing typed: undo a text edit — but a line that was only moved stays where it was put
        if (existing && !existing.move) dispatch({ type: 'commit', fn: removeEdit(existing.id) })
        else if (!existing && scan) dispatch({ type: 'commit', fn: markVerified(run.id, true) })
      } else {
        dispatch({
          type: 'commit',
          fn: upsertEdit({ id: existing?.id ?? uid(), page: run.page, kind: 'replace', run: existing?.run ?? base, text: res.text, style: res.style, keepPrefix: res.keepPrefix, ...(existing?.move ? { move: existing.move } : {}) }),
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
    const r: Rect = e.kind === 'table' ? tableBounds(e.table!.model) : e.kind === 'overlay' ? overlayBounds(e.overlay!) : e.kind === 'erase' ? e.rect! : e.kind === 'replace' ? e.run!.rect : [e.x!, e.baseline! - e.style.size, e.x! + 40, e.baseline!]
    // on a phone, tapping a change puts the sheet away so the change itself can be seen
    if (isPhone()) setPanelOpen(false)
    scrollToRect(e.page, r, false)
    if (e.kind === 'overlay') {
      setTool('select')
      setSelectedId(e.id, e.page)
    } else if (e.kind === 'table') {
      setTool('table')
      // (the tool-change effect closes any session, so open ours on the next tick)
      setTimeout(() => openTableRef.current(e.page, e.table!, e.id), 0)
    }
  })

  // ------------------------------------------------------- overlays: markup, shapes, pen, signature, pictures
  const createOverlay = useEvent((page: number, overlay: Overlay) => {
    dispatch({ type: 'commit', fn: upsertEdit({ id: uid('o'), page, kind: 'overlay', text: '', style: addStyle, overlay }) })
  })
  const updateOverlay = useEvent((id: string, overlay: Overlay) => dispatch({ type: 'commit', fn: updateOverlayEdit(id, overlay) }))
  const deleteOverlay = useEvent((id: string) => {
    dispatch({ type: 'commit', fn: removeEdit(id) })
    setSelectedId(null)
  })

  // ---------------------------------------------------- Select tool: pick things, then move them together
  const selectKeys = useEvent((page: number, keys: SelKey[], mode: 'set' | 'toggle' | 'add') => {
    // a pick lives on one page: picking on another page starts over
    const map = new Map((mode === 'set' ? [] : pickedRef.current.filter((k) => k.page === page)).map((k) => [selId(k), k]))
    for (const k of keys) {
      if (mode === 'toggle' && map.has(selId(k))) map.delete(selId(k))
      else map.set(selId(k), k)
    }
    setSelection([...map.values()])
  })
  /** The whole pick moves by the same amount, as one undo step. */
  const moveSelection = useEvent((_page: number, keys: SelKey[], dx: number, dy: number) => {
    dispatch({ type: 'commit', fn: (s) => moveItems(s, keys, runsOfPage, dx, dy) })
  })
  /** Ctrl+A: everything on the page you are looking at that can be moved. */
  const selectAll = useEvent(() => {
    const keys = allKeysOnPage(snap, current, runsOfPage)
    setTool('select')
    setEditing(null)
    setSelection(keys)
    if (!keys.length) notify('There is nothing to select on this page yet. A scanned page needs its text recognised first.')
  })
  /** Arrow keys: nudge the pick, never off the page. */
  const nudgeSelection = useEvent((dx: number, dy: number) => {
    const rects = picked.map((k) => itemRect(snap, k, runsOfPage)).filter((r): r is Rect => !!r)
    if (!rects.length) return
    const [mx, my] = clampMove(unionRect(rects), dx, dy, doc.sizes[picked[0].page])
    if (mx || my) moveSelection(picked[0].page, picked, mx, my)
  })
  /** Delete: removes what you added yourself; the page's own text is changed with Erase instead. */
  const deleteSelection = useEvent(() => {
    const gone = new Set(picked.filter((k) => isDeletable(snap, k)).map((k) => k.id))
    if (!gone.size) return notify('Only things you added can be deleted. To remove the page’s own text, use the Erase tool.')
    dispatch({ type: 'commit', fn: (s) => ({ ...s, edits: s.edits.filter((e) => !gone.has(e.id)) }) })
    setSelection(picked.filter((k) => !gone.has(k.id)))
    if (gone.size > 1) notify(`Deleted ${gone.size} things.`, 'info', { label: 'Undo', run: () => dispatch({ type: 'undo' }) })
  })
  const selectedEdit = selectedId ? snap.edits.find((e) => e.id === selectedId && e.kind === 'overlay') : undefined
  const restyleSelected = useEvent((patch: Partial<DrawStyle>) => {
    if (selectedEdit?.overlay) updateOverlay(selectedEdit.id, restyle(selectedEdit.overlay, patch))
  })
  const changeStyle = useEvent((patch: Partial<DrawStyle>) => setDrawStyle({ ...drawStyle, ...patch }))

  const pickImage = useEvent(() => imageInput.current?.click())
  const imageChosen = useEvent(async (file: File) => {
    try {
      const prep = await prepareImage(file, { maxSide: 2400 })
      const id = uid('img')
      const { width, height } = await engine.addImage(id, prep.bytes)
      imageBytes.current.set(id, { bytes: prep.bytes, type: prep.type || 'image/png', width, height })
      const url = URL.createObjectURL(new Blob([prep.bytes as BlobPart], { type: prep.type || 'image/png' }))
      setImages((prev) => new Map(prev).set(id, { url, width, height }))
      setPendingImage({ id, name: file.name, aspect: width / height })
      setTool('image')
      notify('Click on the page where the picture should go.')
    } catch (e) {
      notify((e as Error).message, 'error')
    }
  })

  const adoptSignature = useEvent((sig: Signature) => {
    setSignature(sig)
    setSignOpen(false)
    setTool('sign')
    notify('Click on the page where the signature should go.')
  })
  const newSignature = useEvent(() => setSignOpen(true))

  /** A click with the Picture or Signature tool puts the pending picture / saved signature there and selects it. */
  const place = useEvent((page: number, x: number, y: number) => {
    const size = doc.sizes[page]
    let overlay: Overlay | null = null
    if (tool === 'image') {
      if (!pendingImage) return notify('Choose a picture first.')
      overlay = imageOverlay(pendingImage.id, pendingImage.aspect, x, y, 180, size)
    } else if (tool === 'sign') {
      if (!signature) return setSignOpen(true)
      overlay = signatureOverlay(signature, x, y, 150, signInk, size)
    }
    if (!overlay) return
    const id = uid('o')
    dispatch({ type: 'commit', fn: upsertEdit({ id, page, kind: 'overlay', text: '', style: addStyle, overlay }) })
    setSelectedId(id, page)
    setTool('select')
  })

  // ----------------------------------------------------------------------------------- find & replace
  const orderedRuns = useMemo(
    () =>
      Object.keys(doc.runs)
        .map(Number)
        .sort((a, b) => a - b)
        .flatMap((pg) => readingOrder(doc.runs[pg])),
    [doc.runs],
  )
  const findActive = panelOpen && panelTab === 'find' && inEditor
  const matches = useMemo(() => (findActive && findQuery ? findMatches(orderedRuns, (r) => effectiveText(r, snap), findQuery, findOpts) : []), [findActive, findQuery, orderedRuns, snap, findOpts])
  const findCurrent = Math.min(findIndex, Math.max(0, matches.length - 1))
  const findByPage = useMemo(() => {
    const m = new Map<number, FindBox[]>()
    matches.forEach((mt, i) => m.set(mt.run.page, [...(m.get(mt.run.page) ?? []), { rect: mt.rect, current: i === findCurrent }]))
    return m
  }, [matches, findCurrent])
  const unreadablePages = Object.values(doc.infos).filter((i) => isScanPage(i) && !doc.runs[i.index]?.length).length

  const goMatch = useEvent((i: number) => {
    setFindIndex(i)
    const m = matches[i]
    if (m) scrollToRect(m.run.page, m.rect)
  })
  // a new search starts at its first match
  useEffect(() => {
    setFindIndex(0)
  }, [findQuery, findOpts])
  useEffect(() => {
    if (findQuery && matches.length) scrollToRect(matches[0].run.page, matches[0].rect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findQuery, findOpts, matches.length > 0])

  // Find needs every page's text, so read the pages we have not looked at yet (once per document).
  useEffect(() => {
    if (!findActive || allRead.current === doc.docId) return
    allRead.current = doc.docId
    let alive = true
    let finished = false
    void (async () => {
      const n = doc.sizes.length
      for (let i = 0; i < n && alive; i++) {
        setReadingAll({ done: i, total: n })
        await ensurePage(i)
      }
      finished = alive
      setReadingAll(null)
    })()
    return () => {
      alive = false
      if (!finished) allRead.current = 0
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findActive, doc.docId])

  const openFind = useEvent(() => {
    setPanelOpen(true)
    setPanelTab('find')
    setTimeout(() => {
      findInput.current?.focus()
      findInput.current?.select()
    }, 30)
  })
  const replaceOne = useEvent(() => {
    const m = matches[findCurrent]
    if (!m) return
    const text = replaceIn(effectiveText(m.run, snap), findQuery, findReplacement, findOpts, m.nth)
    dispatch({ type: 'commit', fn: (s) => withRunText(s, m.run, text) })
  })
  const replaceAll = useEvent(() => {
    const touched = [...new Set(matches.map((m) => m.run))]
    if (!touched.length) return
    const count = matches.length
    dispatch({ type: 'commit', fn: (s) => touched.reduce((acc, run) => withRunText(acc, run, replaceIn(effectiveText(run, acc), findQuery, findReplacement, findOpts)), s) })
    notify(`Replaced ${count} match${count === 1 ? '' : 'es'}. Check them, then Save & verify.`, 'ok', { label: 'Undo', run: () => dispatch({ type: 'undo' }) })
  })

  // ------------------------------------------------------------------------------------------- tables
  const tableEditObj = tableCtx?.editId ? snap.edits.find((e) => e.id === tableCtx.editId && e.kind === 'table') : undefined
  const tableData: TableEdit | null = tableEditObj?.table ?? tableCtx?.base ?? null
  // the model the next change starts from: our own latest one while a change is still being fitted
  if (!tableBusy.current) liveTable.current = tableData?.model ?? null

  const openTable = useEvent((page: number, edit: TableEdit, editId: string | null) => {
    setTableCtx({ page, editId, base: edit })
    setTableSel(null)
    setTableCell(null)
    setPanelOpen(true)
    setPanelTab('table')
  })
  openTableRef.current = openTable
  const tableMiss = (reason?: string) =>
    notify(
      reason === 'scan'
        ? 'Table editing needs a page with real text and lines. This page is a scan or a picture.'
        : reason === 'no-text'
          ? 'No table found in that box. It needs at least two columns of text.'
          : 'No table with ruled lines here. If the table has no lines, drag a box around it instead.',
      'info',
    )
  const textEditRect = (e: Edit): Rect => (e.kind === 'replace' ? e.run!.rect : e.kind === 'erase' ? e.rect! : [e.x!, e.baseline! - e.style.size, e.x! + Math.max(e.style.size, e.text.length * e.style.size * 0.55), e.baseline! + e.style.size * 0.3])
  const overlapping = (a: Rect, b: Rect) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
  const tryTable = (page: number, found: { edit: TableEdit | null; reason?: string }) => {
    if (!found.edit) return tableMiss(found.reason)
    const zone = found.edit.clear[0]
    // already edited? carry on with that edit instead of starting a second one over the same table
    const again = snap.edits.find((e) => e.kind === 'table' && e.page === page && e.table && overlapping(e.table.clear[0], zone))
    if (again) return openTable(page, again.table!, again.id)
    const clash = snap.edits.some((e) => e.page === page && (e.kind === 'replace' || e.kind === 'add' || e.kind === 'erase') && found.edit!.clear.some((r) => overlapping(r, textEditRect(e))))
    if (clash) return notify('This table already has text edits in it. Undo or remove them (see the Changes tab), then edit the table.', 'error')
    openTable(page, found.edit, null)
  }
  const detectTableAt = useEvent(async (page: number, x: number, y: number) => {
    const inside = snap.edits.find((e) => e.kind === 'table' && e.page === page && e.table && x >= tableBounds(e.table.model)[0] - 4 && x <= tableBounds(e.table.model)[2] + 4 && y >= tableBounds(e.table.model)[1] - 4 && y <= tableBounds(e.table.model)[3] + 4)
    if (inside) return openTable(page, inside.table!, inside.id)
    try {
      tryTable(page, await engine.detectTable(page, x, y))
    } catch (e) {
      notify(`Could not read the table: ${(e as Error).message}`, 'error')
    }
  })
  const inferTableIn = useEvent(async (page: number, rect: Rect) => {
    try {
      tryTable(page, await engine.inferTable(page, rect))
    } catch (e) {
      notify(`Could not read the table: ${(e as Error).message}`, 'error')
    }
  })

  /** Change the table: `fn` makes the new model (null = nothing left), then rows grow to fit wrapped text. */
  const commitTable = useEvent(async (fn: (m: TableModel) => TableModel | null, fit: 'grow' | 'exact' | false = 'grow') => {
    const ctx = tableCtx
    const model = liveTable.current
    if (!ctx || !model) return
    tableBusy.current++
    try {
      const clear = (tableData ?? ctx.base).clear
      const id = ctx.editId ?? uid('tb')
      let next = fn(model)
      const deleted = !next
      // a new or widened column must not push the table off the right-hand side of the page
      if (next) next = fitWidth(next, Math.max(doc.sizes[ctx.page].width - 12, tableBounds(model)[2]))
      if (next && fit) next = await engine.fitTable(next, fit)
      const result = next ?? model
      liveTable.current = result
      dispatch({ type: 'commit', fn: upsertEdit({ id, page: ctx.page, kind: 'table', text: '', style: addStyle, table: { model: result, clear, deleted } }) })
      if (!ctx.editId) setTableCtx({ ...ctx, editId: id })
      if (deleted) {
        setTableSel(null)
        setTableCell(null)
      }
    } finally {
      tableBusy.current--
    }
  })
  const sameCell = (s: CellRange) => ({ r0: s.r0, r1: s.r1, c0: s.c0, c1: s.c1 })
  const tableOps: TableOps = {
    insertRow: (where) => {
      const s = tableSel
      if (!s) return
      const at = where === 'above' ? s.r0 : s.r1 + 1
      void commitTable((m) => insertRow(m, at, where === 'above' ? s.r0 : s.r1))
      setTableSel({ r0: at, r1: at, c0: 0, c1: (liveTable.current ? colCount(liveTable.current) : 1) - 1 })
    },
    insertColumn: (where) => {
      const s = tableSel
      if (!s) return
      const at = where === 'left' ? s.c0 : s.c1 + 1
      void commitTable((m) => insertColumn(m, at, where === 'left' ? s.c0 : s.c1))
      setTableSel({ r0: 0, r1: (liveTable.current ? rowCount(liveTable.current) : 1) - 1, c0: at, c1: at })
    },
    deleteRows: () => {
      const s = tableSel
      if (s) void commitTable((m) => deleteRows(m, s.r0, s.r1))
      setTableSel(null)
    },
    deleteColumns: () => {
      const s = tableSel
      if (s) void commitTable((m) => deleteColumns(m, s.c0, s.c1))
      setTableSel(null)
    },
    evenColumns: () => void commitTable(distributeColumns),
    fitRows: () => void commitTable((m) => m, 'exact'),
    setBorders: (patch) => void commitTable((m) => setBorders(m, patch), false),
    borderPreset: (name) => {
      const flags = { all: [true, true, true], outside: [true, false, false], inside: [false, true, true], rows: [false, true, false], columns: [false, false, true], none: [false, false, false] }[name]
      void commitTable((m) => setBorders(m, { outer: flags[0], innerH: flags[1], innerV: flags[2] }), false)
    },
    setFill: (c) => {
      const s = tableSel
      if (s) void commitTable((m) => mapCells(m, sameCell(s), (cell) => ({ ...cell, fill: c })), false)
    },
    setText: (patch) => {
      const s = tableSel
      if (s) void commitTable((m) => mapCells(m, sameCell(s), (cell) => ({ ...cell, ...patch })))
    },
    stripe: (c) => void commitTable((m) => zebra(m, c, 1), false),
    setWrap: (on) => void commitTable((m) => ({ ...m, wrap: on }), on ? 'grow' : false),
    deleteTable: () => void commitTable(() => null),
    restore: () => void commitTable((m) => m, false),
  }
  /** The move handle of a line of the page's own text. */
  const moveRun = useEvent((page: number, runId: string, dx: number, dy: number) => {
    const run = runsOf(page).find((r) => r.id === runId)
    if (run) dispatch({ type: 'commit', fn: (s) => moveRunIn(s, run, dx, dy) })
  })
  /** The move handle of text you edited or added. */
  const moveEdit = useEvent((editId: string, dx: number, dy: number) => dispatch({ type: 'commit', fn: (s) => moveEditIn(s, editId, dx, dy) }))
  /** The move handle of the table: keeps it on the page, and never squeezes it while it moves. */
  const onTableMove = useEvent((dx: number, dy: number) => {
    const m = liveTable.current
    if (!m || !tableCtx) return
    const [x0, y0, x1, y1] = tableBounds(m)
    const pg = doc.sizes[tableCtx.page]
    const cx = Math.min(Math.max(dx, 4 - x0), Math.max(pg.width - 12, x1) - x1)
    const cy = Math.min(Math.max(dy, 4 - y0), pg.height - 4 - y1)
    void commitTable((t) => translateTable(t, cx, cy), false)
  })
  const onTableBoundary = useEvent((axis: 'x' | 'y', i: number, pos: number) => void commitTable((m) => moveBoundary(m, axis, i, pos)))
  const onTableCellText = useEvent((r: number, c: number, text: string, move: 'next' | 'prev' | 'down' | null) => {
    const m = liveTable.current
    if (m && m.cells[r]?.[c] && m.cells[r][c].text !== text) void commitTable((t) => mapCells(t, { r0: r, r1: r, c0: c, c1: c }, (cell) => ({ ...cell, text })))
    if (!m || !move) return setTableCell(null)
    const R = rowCount(m)
    const C = colCount(m)
    let [nr, nc] = [r, c]
    if (move === 'next') [nr, nc] = c + 1 < C ? [r, c + 1] : [r + 1, 0]
    else if (move === 'prev') [nr, nc] = c > 0 ? [r, c - 1] : [r - 1, C - 1]
    else nr = r + 1
    if (nr < 0 || nr >= R) return setTableCell(null)
    setTableSel({ r0: nr, r1: nr, c0: nc, c1: nc })
    setTableCell([nr, nc])
  })
  const tableApi = useMemo<TableApi>(() => ({ onSelect: setTableSel, onBoundary: onTableBoundary, onEdit: setTableCell, onCellText: onTableCellText, onMove: onTableMove }), [onTableBoundary, onTableCellText, onTableMove])
  const tableView = useMemo<TableView | null>(() => (tableCtx && tableData && !tableData.deleted ? { page: tableCtx.page, model: tableData.model, sel: tableSel, editing: tableCell } : null), [tableCtx, tableData, tableSel, tableCell])
  // leaving the Table tool ends the table session (the edits stay)
  useEffect(() => {
    if (tool === 'table') return
    setTableCtx(null)
    setTableSel(null)
    setTableCell(null)
    setPanelTab((t) => (t === 'table' ? 'changes' : t))
  }, [tool])

  const editorFor = (page: number) => {
    if (!editing || editing.page !== page) return null
    if (editing.kind === 'run') {
      const run = runsOf(page).find((r) => r.id === editing.runId)
      if (!run) return null
      const existing = pictureEditFor(snap.edits, run.id)
      const scan = isScanRun(run)
      const [mx, my] = existing?.move ?? [0, 0] // the editor opens where the line now is
      return (
        <InlineEditor
          key={run.id}
          k={k}
          x={run.x + mx}
          baseline={run.baseline + my}
          width={run.rect[2] - run.rect[0]}
          rect={[run.rect[0] + mx, run.rect[1] + my, run.rect[2] + mx, run.rect[3] + my]}
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
        // a line that was moved: its hidden, searchable text moves with the picture of it
        const [mx, my] = pictureEditFor(snap.edits, r.id)?.move ?? [0, 0]
        lines.push({
          text,
          rect: [r.rect[0] + mx, r.rect[1] + my, r.rect[2] + mx, r.rect[3] + my],
          baseline: r.baseline + my,
          size: r.size,
          words: text === r.text ? r.words?.map((w) => ({ text: w.text, x0: w.x0 + mx, x1: w.x1 + mx })) : undefined,
        })
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
      setKeeping('idle')
      setReportInfo({ report: res.report, bytes: res.bytes, edits: snap.edits })
      if (cloud.status === 'ready') {
        // the save history: what was changed and whether the check passed (not the PDF itself)
        cloudApi
          .logSave({ fileName: doc.fileName, pages: doc.sizes.length, size: res.bytes.length, editCount: res.report.editCount, summary: summarizeEdits(snap), verified: res.report.ok, collateral: res.report.collateral, documentId: docCloud?.id ?? null })
          .then(() => cloud.refresh())
          .catch(() => {})
      }
    } catch (e) {
      notify(`Export failed: ${(e as Error).message}`, 'error')
    } finally {
      setExporting(false)
    }
  })

  const download = () => {
    if (reportInfo) saveBytes(reportInfo.bytes, `${doc.fileName.replace(/\.pdf$/i, '')}-edited.pdf`)
  }

  /** Store the saved PDF in the cloud library, next to the file it came from. */
  const keepInLibrary = useEvent(async () => {
    if (!reportInfo) return
    if (cloud.status !== 'ready') return setLibraryOpen(true)
    setKeeping('busy')
    try {
      await cloudApi.upload(reportInfo.bytes, { name: `${doc.fileName.replace(/\.pdf$/i, '')}-edited.pdf`, kind: 'saved', pages: doc.sizes.length, parentId: docCloud?.id ?? null })
      setKeeping('done')
      void cloud.refresh()
    } catch (e) {
      setKeeping('idle')
      notify(`Could not keep it in the library: ${(e as Error).message}`, 'error')
    }
  })

  const addFont = useEvent(async (f: File) => {
    try {
      await addUserFont(f.name, new Uint8Array(await f.arrayBuffer()))
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
        e.preventDefault() // never let the browser "save page as" over the app
        if (inEditor) void doExport()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        // select everything on this page — but never take Ctrl+A away from a text box
        if (inEditor && !typing) {
          e.preventDefault()
          selectAll()
        }
        return
      }
      if (mod && e.key.toLowerCase() === 'f') {
        if (inEditor) {
          e.preventDefault()
          openFind()
        }
        return
      }
      if (typing || !inEditor) return // shortcuts belong to the editor only
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' })
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        dispatch({ type: 'redo' })
      } else if (!mod) {
        const key = e.key.toLowerCase()
        const tools: Record<string, Tool> = { v: 'select', e: 'edit', t: 'add', x: 'erase', h: 'highlight', u: 'underline', k: 'strike', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', p: 'pen', b: 'table' }
        const hasPick = tool === 'select' && pickedRef.current.length > 0
        const ts = tool === 'table' && tableData && !tableData.deleted ? tableSel : null
        if (ts && (key === 'enter' || key === 'f2')) {
          e.preventDefault()
          setTableCell([ts.r0, ts.c0])
        } else if (ts && (key === 'delete' || key === 'backspace')) {
          e.preventDefault()
          void commitTable((m) => mapCells(m, ts, (c) => ({ ...c, text: '' })))
        } else if (ts && key.startsWith('arrow') && tableData) {
          e.preventDefault()
          const R = rowCount(tableData.model)
          const C = colCount(tableData.model)
          const r = Math.max(0, Math.min(R - 1, ts.r0 + (key === 'arrowdown' ? 1 : key === 'arrowup' ? -1 : 0)))
          const c = Math.max(0, Math.min(C - 1, ts.c0 + (key === 'arrowright' ? 1 : key === 'arrowleft' ? -1 : 0)))
          setTableSel({ r0: r, r1: r, c0: c, c1: c })
        } else if (tools[key]) setTool(tools[key])
        else if (key === 'i') pickImage()
        else if (key === 'g') (signature ? setTool('sign') : newSignature())
        else if (key === '+' || key === '=') setZoom((z) => Math.min(4, Math.round((z + 0.1) * 100) / 100))
        else if (key === '-') setZoom((z) => Math.max(0.25, Math.round((z - 0.1) * 100) / 100))
        else if (key === 'escape') {
          setEditing(null)
          setSelectedId(null)
          if (tool === 'image' || tool === 'sign') setTool('select')
        } else if (hasPick && (key === 'delete' || key === 'backspace')) {
          e.preventDefault()
          deleteSelection()
        } else if (hasPick && key.startsWith('arrow')) {
          e.preventDefault()
          const d = e.shiftKey ? 10 : 1
          nudgeSelection(key === 'arrowleft' ? -d : key === 'arrowright' ? d : 0, key === 'arrowup' ? -d : key === 'arrowdown' ? d : 0)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doExport, inEditor, openFind, pickImage, newSignature, signature, tool, selectAll, deleteSelection, nudgeSelection, tableData, tableSel, commitTable])

  const pageKinds = useMemo(() => Object.values(doc.infos), [doc.infos])
  const docKind = !pageKinds.length ? null : pageKinds.every((i) => i.kind === 'text') ? 'Searchable' : pageKinds.some(isScanPage) ? 'Contains scans' : 'Searchable'
  const nChanges = snap.edits.length
  const toolMeta = view !== 'home' && view !== 'editor' ? TOOLS.find((t) => t.id === view) : undefined
  // On a phone the side panel is a bottom sheet: drag its handle down to put it away.
  const sheet = useRef<HTMLElement>(null)
  const dragSheet = (e: React.PointerEvent) => {
    const el = sheet.current
    if (!el) return
    const y0 = e.clientY
    let dy = 0
    const move = (ev: PointerEvent) => {
      dy = Math.max(0, ev.clientY - y0)
      el.style.transition = 'none'
      el.style.transform = `translateY(${dy}px)`
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      el.style.transition = ''
      if (dy > 80) setPanelOpen(false)
      else el.style.transform = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  const cycleTheme = () => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')
  // what the top bar has no room for on a phone (the bar itself shows these on wider screens)
  const moreItems: MoreItem[] = [
    ...(inEditor ? [{ key: 'original', label: 'Show the original', icon: 'eye' as const, on: showOriginal, onSelect: () => setShowOriginal((v) => !v) }] : []),
    ...(cloud.status === 'ready' || cloud.status === 'locked' ? [{ key: 'cloud', label: 'Cloud library', icon: cloud.status === 'ready' ? ('cloudCheck' as const) : ('cloud' as const), onSelect: openLibrary }] : []),
    { key: 'fonts', label: 'Fonts for other scripts', icon: 'font', onSelect: () => setFontsOpen(true) },
    { key: 'theme', label: `Theme: ${theme}`, icon: theme === 'dark' ? 'moon' : 'sun', onSelect: cycleTheme },
    { key: 'open', label: 'Open a PDF…', icon: 'upload', onSelect: () => fileInput.current?.click() },
  ]

  // ------------------------------------------------------------------------------------ render
  return (
    <div className="app" data-view={view === 'home' || view === 'editor' ? view : 'tool'}>
      <header className="topbar" data-view={view === 'home' || view === 'editor' ? view : 'tool'}>
        <button type="button" className="brand" onClick={goHome} aria-label="PageDesk — back to the home page" title="Back to the home page">
          <span className="logo" aria-hidden="true">
            <Icon name="file" size={18} />
          </span>
          <span className="brand-name">PageDesk</span>
        </button>

        {view !== 'home' && (
          <button type="button" className="btn home-btn" onClick={goHome} aria-label="Home" title="Back to the home page — an open document stays open">
            <Icon name="home" size={16} />
            <span className="lbl">Home</span>
          </button>
        )}
        {toolMeta && (
          <span className="crumb" aria-current="page">
            <Icon name={toolMeta.icon} size={16} />
            {toolMeta.title}
          </span>
        )}

        {inEditor && (
          <>
            <div className="file-pill" title={doc.fileName}>
              <span className="file-name">{doc.fileName}</span>
              {docKind && <span className={`badge ${docKind === 'Searchable' ? 'ok' : 'warn'}`}>{docKind}</span>}
            </div>
            {(cloud.status === 'ready' || cloud.status === 'locked') && (
              <button
                type="button"
                className={`cloud-chip ${docCloud ? draftStatus.kind : 'plain'}`}
                disabled={!!cloudBusy && cloud.status === 'ready' && !docCloud}
                onClick={() => (cloud.status !== 'ready' ? openLibrary() : !docCloud ? void saveToCloud() : draftStatus.kind === 'error' ? void writeDraft() : openLibrary())}
                title={
                  cloud.status !== 'ready'
                    ? 'Enter your passcode to use the cloud library'
                    : !docCloud
                      ? 'Keep this PDF in your cloud library; unsaved edits are then kept as a draft'
                      : draftStatus.kind === 'error'
                        ? `${draftStatus.msg ?? 'The draft could not be saved.'} Click to try again.`
                        : 'Open your cloud library'
                }
              >
                <Icon name={cloudBusy ? 'loader' : cloud.status !== 'ready' ? 'lock' : !docCloud ? 'cloudUp' : draftStatus.kind === 'error' ? 'alert' : 'cloudCheck'} size={15} className={cloudBusy || draftStatus.kind === 'saving' ? 'spin' : ''} />
                <span className="lbl">
                  {cloudBusy ??
                    (cloud.status !== 'ready'
                      ? 'Unlock cloud'
                      : !docCloud
                        ? 'Save to cloud'
                        : draftStatus.kind === 'saving'
                          ? 'Saving draft…'
                          : draftStatus.kind === 'dirty'
                            ? 'Saving soon…'
                            : draftStatus.kind === 'error'
                              ? 'Draft not saved — retry'
                              : draftStatus.at
                                ? `Draft saved ${ago(draftStatus.at)}`
                                : 'In your library')}
                </span>
              </button>
            )}
          </>
        )}

        <div className="spacer" />

        {inEditor && (
          <>
            <div className="group">
              <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!doc.past.length} onClick={() => dispatch({ type: 'undo' })}>
                <Icon name="undo" />
              </button>
              <button type="button" className="icon-btn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!doc.future.length} onClick={() => dispatch({ type: 'redo' })}>
                <Icon name="redo" />
              </button>
            </div>
            <div className="group zoom tb-opt">
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
            <button type="button" className={`btn ghost tb-opt ${showOriginal ? 'on' : ''}`} aria-pressed={showOriginal} onClick={() => setShowOriginal((v) => !v)} title="Show the original, without your changes">
              <Icon name="eye" size={16} />
              <span className="lbl">Original</span>
            </button>
            <button type="button" className={`icon-btn tb-thumbs ${thumbsOpen ? 'on' : ''}`} aria-label="Toggle page list" aria-pressed={thumbsOpen} title="Pages" onClick={() => setThumbsOpen((v) => !v)}>
              <Icon name="sidebar" />
            </button>
            <button type="button" className={`icon-btn tb-panel ${panelOpen ? 'on' : ''}`} aria-label="Toggle side panel" aria-pressed={panelOpen} title="Changes & proofreading" onClick={() => setPanelOpen((v) => !v)}>
              <Icon name="panel" />
            </button>
          </>
        )}

        {(cloud.status === 'ready' || cloud.status === 'locked') && (
          <button type="button" className={`icon-btn tb-opt tb-cloud ${libraryOpen ? 'on' : ''}`} aria-label="Cloud library" title="Cloud library" onClick={openLibrary}>
            <Icon name={cloud.status === 'ready' ? 'cloudCheck' : 'cloud'} />
          </button>
        )}
        <button type="button" className="icon-btn tb-opt" aria-label="Fonts for other scripts" title="Fonts for other scripts" onClick={() => setFontsOpen(true)}>
          <Icon name="font" />
        </button>
        <button type="button" className="icon-btn tb-opt" aria-label={`Theme: ${theme}`} title={`Theme: ${theme} (click to change)`} onClick={cycleTheme}>
          <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
        </button>
        <MoreMenu items={moreItems} zoom={inEditor ? { value: zoom, onChange: setZoom } : undefined} />
        <button type="button" className="btn tb-open" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" size={16} />
          <span className="lbl">Open</span>
        </button>
        {inEditor && (
          <button type="button" className="btn primary" disabled={exporting} onClick={() => void doExport()} title="Save, then verify (Ctrl+S)" aria-label={exporting ? 'Verifying…' : 'Save & verify'}>
            <Icon name={exporting ? 'loader' : 'download'} size={16} className={exporting ? 'spin' : ''} />
            <span className="sv-text">{exporting ? 'Verifying…' : 'Save & verify'}</span>
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

      {view === 'home' && (
        <Welcome
          library={cloud.status === 'ready' || cloud.status === 'locked' ? { signedIn: cloud.status === 'ready', recent: recentDocs, busy: !!cloudBusy, onOpen: (d, withDraft) => void openFromCloud(d, withDraft), onLibrary: openLibrary } : null}
          onOpen={() => fileInput.current?.click()}
          onSample={(kind) => void openSample(kind)}
          onTool={setView}
          dragging={dragging}
          loading={loading}
          resume={hasDoc ? { fileName: doc.fileName, changes: nChanges } : null}
          onResume={() => setView('editor')}
          onCloseDoc={requestClose}
        />
      )}
      {view !== 'home' && view !== 'editor' && <ToolView key={view} id={view} onOpenInEditor={openFromTool} />}
      {hasDoc && (
        <div className={`editor-shell ${view === 'editor' ? '' : 'is-hidden'}`} data-typing={!!editing}>
        <Ribbon
          tool={tool}
          onTool={setTool}
          style={drawStyle}
          onStyle={changeStyle}
          selected={selectedEdit?.overlay ?? null}
          pickCount={picked.length}
          onSelectAll={selectAll}
          onRestyle={restyleSelected}
          signInk={signInk}
          onSignInk={setSignInk}
          hasSignature={!!signature}
          onNewSignature={newSignature}
          onPickImage={pickImage}
          pending={pendingImage?.name ?? null}
          eraseRedact={eraseRedact}
          onEraseRedact={setEraseRedact}
          findOpen={panelOpen && panelTab === 'find'}
          onFind={openFind}
          panelOpen={panelOpen}
          panelCount={nChanges}
          onPanel={() => setPanelOpen((v) => !v)}
        />
        <div className="body" data-thumbs={thumbsOpen} data-panel={panelOpen}>
          {thumbsOpen && <Thumbs engine={engine} docId={doc.docId} sizes={doc.sizes} infos={doc.infos} editsOf={editsOf} current={current} onGo={scrollToPage} />}

          <ScrollRootContext.Provider value={scroller}>
            <div className={`viewer tool-${tool}`} ref={setScroller} onScroll={onScroll}>
              <div className={`hint ${hintVisible ? 'show' : ''}`} aria-live="polite">
                {showOriginal ? 'Showing the original — your changes are hidden.' : touchHint(tool, HINTS[tool](eraseRedact))}
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
                    style={drawStyle}
                    images={images}
                    selection={pickByPage.get(i) ?? NO_SEL}
                    findBoxes={findByPage.get(i) ?? NO_BOXES}
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
                    onCreateOverlay={createOverlay}
                    onUpdateOverlay={updateOverlay}
                    onDeleteOverlay={deleteOverlay}
                    onSelect={selectKeys}
                    onMoveSelection={moveSelection}
                    onPlace={place}
                    onMoveRun={moveRun}
                    onMoveEdit={moveEdit}
                    table={tableView && tableView.page === i ? tableView : null}
                    tableApi={tableApi}
                    onTableDetect={detectTableAt}
                    onTableRegion={inferTableIn}
                  />
                ))}
              </div>
              <div className="page-indicator" aria-live="polite">
                Page {current + 1} / {doc.sizes.length}
              </div>
            </div>
          </ScrollRootContext.Provider>

          {panelOpen && <div className="sheet-scrim" onClick={() => setPanelOpen(false)} aria-hidden="true" />}
          {panelOpen && (
            <aside className="panel" ref={sheet} data-tab={panelTab} aria-label="Changes and proofreading">
              <div className="sheet-grip" onPointerDown={dragSheet} aria-hidden="true" />
              <div className="tabs" role="tablist">
                <button type="button" role="tab" aria-selected={panelTab === 'changes'} className={panelTab === 'changes' ? 'on' : ''} onClick={() => setPanelTab('changes')}>
                  Changes
                  {nChanges > 0 && <span className="count">{nChanges}</span>}
                </button>
                <button type="button" role="tab" aria-selected={panelTab === 'proof'} className={panelTab === 'proof' ? 'on' : ''} onClick={() => setPanelTab('proof')}>
                  Proofread
                  {totalFlagged > 0 ? <span className="count warn">{totalFlagged}</span> : anyScan && proofStats.total === 0 ? <span className="dot" title="Scanned pages need recognising" /> : null}
                </button>
                <button type="button" role="tab" aria-selected={panelTab === 'find'} className={panelTab === 'find' ? 'on' : ''} onClick={openFind}>
                  Find
                </button>
                {tableCtx && (
                  <button type="button" role="tab" aria-selected={panelTab === 'table'} className={panelTab === 'table' ? 'on' : ''} onClick={() => setPanelTab('table')}>
                    Table
                  </button>
                )}
              </div>
              <div className="panel-body">
                {panelTab === 'changes' ? (
                  <ChangesPanel edits={snap.edits} corrections={Object.keys(snap.corrections).length} onJump={jumpToEdit} onRemove={(id) => dispatch({ type: 'commit', fn: removeEdit(id) })} />
                ) : panelTab === 'table' && tableData ? (
                  <TablePanel model={tableData.model} sel={tableSel} deleted={tableData.deleted} ops={tableOps} />
                ) : panelTab === 'find' ? (
                  <FindPanel
                    inputRef={findInput}
                    query={findQuery}
                    onQuery={setFindQuery}
                    replacement={findReplacement}
                    onReplacement={setFindReplacement}
                    opts={findOpts}
                    onOpts={setFindOpts}
                    matches={matches}
                    current={findCurrent}
                    onCurrent={goMatch}
                    loading={readingAll}
                    unreadablePages={unreadablePages}
                    onReplaceOne={replaceOne}
                    onReplaceAll={replaceAll}
                  />
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
        </div>
      )}

      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void imageChosen(f)
          e.target.value = ''
        }}
      />

      {dragging && inEditor && (
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

      {signOpen && <SignatureModal onUse={adoptSignature} onClose={() => setSignOpen(false)} />}
      {confirmClose && (
        <ConfirmModal title="Close this file without saving?" confirmLabel="Close and discard" onConfirm={closeDoc} onClose={() => setConfirmClose(false)}>
          <p className="lead">
            <strong>{doc.fileName}</strong> has {nChanges + Object.keys(snap.corrections).length} unsaved change{nChanges + Object.keys(snap.corrections).length === 1 ? '' : 's'}.
          </p>
          <p className="muted small">If you close it now they are lost. Choose “Keep editing”, then Save &amp; verify, to keep them.</p>
        </ConfirmModal>
      )}
      {password && <PasswordModal error={password.error} onClose={() => setPassword(null)} onSubmit={(pw) => void openBytes(password.bytes.slice(), password.name, pw, password.opts)} />}
      {fontsOpen && <FontsModal fonts={fonts} onAdd={(f) => void addFont(f)} onClose={() => setFontsOpen(false)} />}
      {reportInfo && (
        <ReportModal
          report={reportInfo.report}
          edits={reportInfo.edits}
          proof={proofStats}
          fileName={doc.fileName}
          size={reportInfo.bytes.length}
          keep={cloud.status === 'ready' || cloud.status === 'locked' ? { state: keeping, signedIn: cloud.status === 'ready', onKeep: () => void keepInLibrary() } : null}
          onDownload={download}
          onClose={() => setReportInfo(null)}
        />
      )}
      {libraryOpen && <LibraryModal cloud={cloud} openId={docCloud?.id ?? null} busy={cloudBusy} onOpen={(d, withDraft) => void openFromCloud(d, withDraft)} onDownload={(d) => void downloadFromCloud(d)} onDelete={deleteFromCloud} onClose={() => setLibraryOpen(false)} />}
    </div>
  )
}
