import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EngineClient } from '../engine/client.ts'
import { contentBox, hitOverlay, moveOverlay, normRect, overlayBounds, resizeOverlay, selectTextRects } from '../engine/overlay.ts'
import { tableBounds } from '../engine/table.ts'
import type { Edit, Overlay, PageInfo, PageSize, Pt, Rect, TextRun } from '../engine/types.ts'
import { OverlayLayer } from './OverlayLayer.tsx'
import { TableLayer } from './TableLayer.tsx'
import { Icon } from './icons.tsx'
import { useDebounced, useNearViewport, useTextEdits } from './hooks.ts'
import { isDragTool, isTextMarkTool, markOverlay, penOverlay, resizeBox, shapeFor, type Corner } from './draw.ts'
import { clampMove, editMarkRect, insideEditedTable, rectsTouch, unionRect } from './select.ts'
import { selId, type DrawStyle, type FindBox, type PageCallbacks, type PicInfo, type SelKey, type TableApi, type TableView, type Tool } from './types.ts'

const MAX_PIXELS = 24_000_000

interface Props extends PageCallbacks {
  index: number
  size: PageSize
  /** css px per pt */
  k: number
  dpr: number
  docId: number
  engine: EngineClient
  info: PageInfo | undefined
  runs: TextRun[]
  edits: Edit[]
  showOriginal: boolean
  tool: Tool
  style: DrawStyle
  images: ReadonlyMap<string, PicInfo>
  /** what the Select tool has picked on this page */
  selection: ReadonlyArray<SelKey>
  findBoxes: FindBox[]
  /** the table being edited, if it is on this page */
  table: TableView | null
  tableApi: TableApi
  /** run ids needing human review (OCR) */
  flagged: ReadonlySet<string>
  flagReasons: ReadonlyMap<string, string>
  verified: Readonly<Record<string, true>>
  corrections: Readonly<Record<string, string>>
  /** show the green 'checked by you' marks (only while proofreading) */
  proofMode: boolean
  activeRunId: string | null
  highlightRunId: string | null
  ocrBusy: boolean
  ocrHere: boolean
  editor: ReactNode
}

const pad = 1.5

/** What the move handle (Edit tool) is attached to. */
type GripTarget = { kind: 'run'; id: string } | { kind: 'edit'; id: string } | { kind: 'overlay'; id: string }

/** A thing the Select tool can pick, with where it is on this page. */
interface Movable {
  key: SelKey
  rect: Rect
  /** overlays only: for an exact hit test (a thin line, a ring) */
  overlay?: Overlay
  label?: string
  fontSize?: number
}

type Gesture =
  | { kind: 'grip'; target: GripTarget; start: Pt; rect: Rect; orig?: Overlay; label?: string; fontSize?: number; dx: number; dy: number; moved: boolean }
  | { kind: 'erase'; start: Pt }
  | { kind: 'table'; start: Pt }
  | { kind: 'draw'; tool: Tool; start: Pt; pts: Pt[] }
  | { kind: 'mark'; tool: Tool; a: Pt; b: Pt }
  /** the Select tool dragging everything that is picked */
  | { kind: 'group'; items: Movable[]; start: Pt; box: Rect; dx: number; dy: number; moved: boolean; /** a plain click on one of several picked things narrows the pick to it */ narrowTo: SelKey | null }
  /** the Select tool's rubber band */
  | { kind: 'marquee'; start: Pt; add: boolean }
  | { kind: 'resize'; id: string; orig: Overlay; corner: Corner; box: Rect }
  | { kind: 'end'; id: string; orig: Overlay; which: 'a' | 'b' }

function PageViewImpl(p: Props) {
  const { index, size, k, engine } = p
  const [ref, near] = useNearViewport()
  const canvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<Rect | null>(null)
  // the overlay being drawn, moved or resized right now (not yet part of the document)
  const [draft, setDraft] = useState<{ id: string | null; overlay: Overlay } | null>(null)
  const latest = useRef<Overlay | null>(null)
  const gesture = useRef<Gesture | null>(null)
  // the thing under the pointer that can be moved (it shows a move handle), and a ghost while it is being dragged
  const [hover, setHover] = useState<GripTarget | null>(null)
  const [ghost, setGhost] = useState<{ rect: Rect; label?: string; fontSize?: number } | null>(null)
  // where along the thing under the pointer the move handle sits: right where the pointer is (page pt)
  const [gripX, setGripX] = useState<number | null>(null)
  // the Select tool is dragging these (keys) by (dx, dy) — shown live, written to the document on release
  const [carry, setCarry] = useState<{ keys: ReadonlySet<string>; dx: number; dy: number } | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverIn = (t: GripTarget, x?: number) => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    if (x !== undefined) setGripX(x)
    setHover(t)
  }
  // the handle follows the pointer along the thing; small steps are ignored so it does not re-render on every pixel
  const followPointer = (x: number) => setGripX((prev) => (prev !== null && Math.abs(prev - x) < 4 ? prev : x))
  // a short delay, so the pointer can travel from the thing to its handle without the handle vanishing
  const hoverOutSoon = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current)
    leaveTimer.current = setTimeout(() => setHover(null), 140)
  }
  useEffect(() => () => void (leaveTimer.current && clearTimeout(leaveTimer.current)), [])

  useEffect(() => {
    if (near) p.onVisible(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, index])

  // Only text edits change the page picture; overlays are drawn on top by the SVG layer.
  const textEdits = useTextEdits(p.edits)
  const overlayEdits = useMemo(() => p.edits.filter((e) => e.kind === 'overlay' && e.overlay), [p.edits])

  const wanted = Math.min(k * p.dpr, Math.sqrt(MAX_PIXELS / (size.width * size.height)))
  const renderScale = useDebounced(wanted, 160)

  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    if (!near) {
      // far from the viewport: give the pixels back
      cv.width = 1
      cv.height = 1
      return
    }
    let alive = true
    setBusy(true)
    engine
      .render(index, renderScale, p.showOriginal ? [] : textEdits)
      .then((res) => {
        if (!alive || !canvas.current) return
        const c = canvas.current
        c.width = res.width
        c.height = res.height
        c.getContext('2d')!.putImageData(new ImageData(res.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, res.width, res.height), 0, 0)
      })
      .catch((e) => console.error('render failed', e))
      .finally(() => alive && setBusy(false))
    return () => {
      alive = false
    }
  }, [near, renderScale, textEdits, p.showOriginal, p.docId, engine, index])

  const toPt = (e: React.PointerEvent | React.MouseEvent): Pt => {
    const r = overlay.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]
  }

  const coveredRuns = useMemo(() => new Set(p.edits.filter((e) => e.kind === 'replace').map((e) => e.run!.id)), [p.edits])
  const selectableRuns = useMemo(() => p.runs.filter((r) => !coveredRuns.has(r.id)), [p.runs, coveredRuns])

  // Everything the Select tool can pick up on this page, lowest first (so the last one that is hit is on top).
  const movables = useMemo<Movable[]>(() => {
    const out: Movable[] = selectableRuns
      .filter((r) => !insideEditedTable(r.rect, index, p.edits))
      .map((r) => ({ key: { kind: 'run', id: r.id, page: index }, rect: r.rect, label: p.corrections[r.id] ?? r.text, fontSize: r.size }))
    for (const e of p.edits) {
      if (e.kind === 'table' && e.table && !e.table.deleted) out.push({ key: { kind: 'table', id: e.id, page: index }, rect: tableBounds(e.table.model) })
      else if ((e.kind === 'replace' && e.run) || e.kind === 'add') out.push({ key: { kind: 'edit', id: e.id, page: index }, rect: editMarkRect(e), label: e.text, fontSize: e.style.size })
    }
    for (const e of overlayEdits) out.push({ key: { kind: 'overlay', id: e.id, page: index }, rect: overlayBounds(e.overlay!), overlay: e.overlay! })
    return out
  }, [selectableRuns, p.edits, overlayEdits, p.corrections, index])
  const picked = useMemo(() => new Set(p.selection.map(selId)), [p.selection])
  const hitMovable = ([x, y]: Pt): Movable | undefined => {
    const tol = 4 / Math.max(0.3, k)
    for (let i = movables.length - 1; i >= 0; i--) {
      const m = movables[i]
      const hit = m.overlay ? hitOverlay(m.overlay, x, y, tol) : x >= m.rect[0] - pad && x <= m.rect[2] + pad && y >= m.rect[1] - pad && y <= m.rect[3] + pad
      if (hit) return m
    }
    return undefined
  }

  const show = (o: Overlay | null, id: string | null) => {
    latest.current = o
    setDraft(o ? { id, overlay: o } : null)
  }
  const topHit = ([x, y]: Pt) => [...overlayEdits].reverse().find((e) => hitOverlay(e.overlay!, x, y, 4 / Math.max(0.3, k)))

  const onPointerDown = (e: React.PointerEvent) => {
    // a second finger means pinch / pan, not another stroke: drop what the first one had begun
    if (!e.isPrimary) {
      if (gesture.current) finish(false)
      return
    }
    if (e.button !== 0 || p.showOriginal) return
    const pt = toPt(e)
    const capture = () => (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (p.tool === 'erase') {
      gesture.current = { kind: 'erase', start: pt }
      setDrag(null)
      capture()
    } else if (p.tool === 'table') {
      gesture.current = { kind: 'table', start: pt }
      setDrag(null)
      capture()
    } else if (isDragTool(p.tool)) {
      gesture.current = { kind: 'draw', tool: p.tool, start: pt, pts: [pt] }
      capture()
    } else if (isTextMarkTool(p.tool)) {
      gesture.current = { kind: 'mark', tool: p.tool, a: pt, b: pt }
      capture()
    } else if (p.tool === 'select') {
      const hit = hitMovable(pt)
      const add = e.shiftKey || e.ctrlKey || e.metaKey
      if (hit) {
        const wasPicked = picked.has(selId(hit.key))
        if (add) p.onSelect(index, [hit.key], 'toggle')
        else if (!wasPicked) p.onSelect(index, [hit.key], 'set')
        if (add && wasPicked) return // it was taken out of the pick: nothing to drag
        // dragging moves the whole pick (this thing included)
        const items = add || wasPicked ? [...movables.filter((m) => picked.has(selId(m.key))), ...(wasPicked ? [] : [hit])] : [hit]
        gesture.current = { kind: 'group', items, start: pt, box: unionRect(items.map((m) => m.rect)), dx: 0, dy: 0, moved: false, narrowTo: wasPicked && !add && items.length > 1 ? hit.key : null }
        capture()
      } else {
        // empty space: a rubber band picks what it touches (a plain click picks nothing)
        if (!add) p.onSelect(index, [], 'set')
        gesture.current = { kind: 'marquee', start: pt, add }
        capture()
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!e.isPrimary) return
    const g = gesture.current
    const pt = toPt(e)
    if (!g) {
      const t = e.target as HTMLElement
      if (p.tool === 'select') {
        // anything that can be picked up shows the move cursor — dragging it is the move
        if (overlay.current) overlay.current.style.cursor = !p.showOriginal && hitMovable(pt) ? 'move' : ''
        return
      }
      // Edit tool. Nothing is being dragged: which drawn thing (if any) is under the pointer? Text and marks tell us
      // themselves; either way the handle follows the pointer along the top edge, but holds still while you reach for it.
      if (t.closest('.move-grip')) return
      if (t.closest('.run, .mark')) return followPointer(pt[0])
      if (p.tool !== 'edit' || p.showOriginal) return hover && setHover(null)
      const hit = topHit(pt)
      if (hit) {
        followPointer(pt[0])
        return hoverIn({ kind: 'overlay', id: hit.id })
      }
      // on the way up to its handle (which sits just above it) the handle must not disappear
      if (hover?.kind === 'overlay') {
        const cur = overlayEdits.find((o) => o.id === hover.id)
        const b = cur ? overlayBounds(cur.overlay!) : null
        const gap = 40 / Math.max(0.3, k)
        if (b && pt[0] >= b[0] - 6 && pt[0] <= b[2] + 6 && pt[1] >= b[1] - gap && pt[1] <= b[3]) return
      }
      if (hover?.kind === 'overlay') setHover(null)
      return
    }
    if (g.kind === 'grip') {
      let dx = pt[0] - g.start[0]
      let dy = pt[1] - g.start[1]
      if (e.shiftKey) (Math.abs(dx) >= Math.abs(dy) ? (dy = 0) : (dx = 0)) // Shift keeps it on one line
      ;[dx, dy] = clampMove(g.rect, dx, dy, size)
      g.dx = dx
      g.dy = dy
      if (Math.hypot(dx, dy) > 1) g.moved = true
      if (g.moved) {
        if (g.target.kind === 'overlay' && g.orig) show(moveOverlay(g.orig, dx, dy), g.target.id)
        else setGhost({ rect: [g.rect[0] + dx, g.rect[1] + dy, g.rect[2] + dx, g.rect[3] + dy], label: g.label, fontSize: g.fontSize })
      }
    } else if (g.kind === 'group') {
      let dx = pt[0] - g.start[0]
      let dy = pt[1] - g.start[1]
      if (e.shiftKey) (Math.abs(dx) >= Math.abs(dy) ? (dy = 0) : (dx = 0)) // Shift keeps it level
      ;[dx, dy] = clampMove(g.box, dx, dy, size)
      g.dx = dx
      g.dy = dy
      if (Math.hypot(dx, dy) > 1.5) g.moved = true
      if (g.moved) {
        setCarry((c) => (c ? { ...c, dx, dy } : { keys: new Set(g.items.map((m) => selId(m.key))), dx, dy }))
        if (overlay.current) overlay.current.style.cursor = 'grabbing'
      }
    } else if (g.kind === 'marquee') {
      const [sx, sy] = g.start
      setDrag([Math.min(sx, pt[0]), Math.min(sy, pt[1]), Math.max(sx, pt[0]), Math.max(sy, pt[1])])
    } else if (g.kind === 'erase' || g.kind === 'table') {
      const [sx, sy] = g.start
      setDrag([Math.min(sx, pt[0]), Math.min(sy, pt[1]), Math.max(sx, pt[0]), Math.max(sy, pt[1])])
    } else if (g.kind === 'draw') {
      if (g.tool === 'pen') {
        g.pts.push(pt)
        show(penOverlay(g.pts, p.style), null)
      } else show(shapeFor(g.tool, g.start, pt, p.style, e.shiftKey), null)
    } else if (g.kind === 'mark') {
      g.b = pt
      let rects = selectTextRects(selectableRuns, g.a, g.b)
      // no text there (a picture, a scan that has not been recognised): a highlighter still works as a plain box
      if (!rects.length && g.tool === 'highlight' && Math.abs(g.b[0] - g.a[0]) > 4 && Math.abs(g.b[1] - g.a[1]) > 4) rects = [normRect([g.a[0], g.a[1], g.b[0], g.b[1]])]
      show(markOverlay(g.tool, rects, p.style), null)
    } else if (g.kind === 'resize') {
      const keep = g.orig.type === 'image' || g.orig.type === 'ink'
      show(resizeOverlay(g.orig, resizeBox(g.box, g.corner, pt, keep && !e.shiftKey)), g.id)
    } else if (g.kind === 'end' && (g.orig.type === 'line' || g.orig.type === 'arrow')) {
      let to: Pt = pt
      if (e.shiftKey) {
        const from = g.which === 'a' ? g.orig.b : g.orig.a
        const len = Math.hypot(pt[0] - from[0], pt[1] - from[1])
        const ang = Math.round(Math.atan2(pt[1] - from[1], pt[0] - from[0]) / (Math.PI / 4)) * (Math.PI / 4)
        to = [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len]
      }
      show({ ...g.orig, [g.which]: to }, g.id)
    }
  }

  const finish = (commit: boolean) => {
    const g = gesture.current
    const made = latest.current
    gesture.current = null
    latest.current = null
    setDraft(null)
    const r = drag
    setDrag(null)
    setGhost(null)
    setCarry(null)
    if (overlay.current) overlay.current.style.cursor = ''
    if (!g || !commit) return
    if (g.kind === 'group') {
      if (g.moved) p.onMoveSelection(index, g.items.map((m) => m.key), g.dx, g.dy)
      else if (g.narrowTo) p.onSelect(index, [g.narrowTo], 'set') // a plain click on one of several picked things
    } else if (g.kind === 'marquee') {
      if (r && r[2] - r[0] > 3 && r[3] - r[1] > 3) {
        const keys = movables.filter((m) => rectsTouch(m.rect, r)).map((m) => m.key)
        p.onSelect(index, keys, g.add ? 'add' : 'set')
      }
    } else if (g.kind === 'grip') {
      if (!g.moved) return
      if (g.target.kind === 'overlay') {
        if (made) p.onUpdateOverlay(g.target.id, made)
      } else if (g.target.kind === 'run') p.onMoveRun(index, g.target.id, g.dx, g.dy)
      else p.onMoveEdit(g.target.id, g.dx, g.dy)
    } else if (g.kind === 'erase') {
      if (r && r[2] - r[0] > 3 && r[3] - r[1] > 3) p.onErase(index, r)
    } else if (g.kind === 'table') {
      // a drag reads the table from the text in the box; a plain click finds the table under the pointer
      if (r && r[2] - r[0] > 14 && r[3] - r[1] > 14) p.onTableRegion(index, r)
      else p.onTableDetect(index, g.start[0], g.start[1])
    } else if ((g.kind === 'draw' || g.kind === 'mark') && made) p.onCreateOverlay(index, made)
    else if ((g.kind === 'resize' || g.kind === 'end') && made) p.onUpdateOverlay(g.id, made)
  }

  const onOverlayClick = (e: React.MouseEvent) => {
    const [x, y] = toPt(e)
    if (p.tool === 'add') p.onAddAt(index, x, y + 9.5)
    else if (p.tool === 'image' || p.tool === 'sign') p.onPlace(index, x, y)
  }

  const beginHandle = (e: React.PointerEvent, g: Gesture) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    gesture.current = g
  }

  // what the SVG layer shows: the stored overlays, with the one being dragged swapped for its draft — and, while the
  // Select tool carries a pick, every picked shape at its new place
  const items = useMemo(() => {
    const list = overlayEdits.map((e) => ({
      id: e.id,
      overlay: carry?.keys.has(`overlay:${e.id}`) ? moveOverlay(e.overlay!, carry.dx, carry.dy) : draft?.id === e.id ? draft.overlay : e.overlay!,
    }))
    if (draft && draft.id === null) list.push({ id: '__draft', overlay: draft.overlay })
    return list
  }, [overlayEdits, draft, carry])

  // One shape picked on its own gets handles to resize it; any other pick gets a plain frame per thing.
  const onlyOverlay = p.tool === 'select' && p.selection.length === 1 && p.selection[0].kind === 'overlay' ? p.selection[0].id : null
  const selected = onlyOverlay ? items.find((i) => i.id === onlyOverlay) : undefined
  const frames = p.tool === 'select' && !p.showOriginal && !selected ? movables.filter((m) => picked.has(selId(m.key))) : []
  const shifted = (m: Movable): Rect => (carry?.keys.has(selId(m.key)) ? [m.rect[0] + carry.dx, m.rect[1] + carry.dy, m.rect[2] + carry.dx, m.rect[3] + carry.dy] : m.rect)
  const ghosts = carry ? movables.filter((m) => m.key.kind !== 'overlay' && carry.keys.has(selId(m.key))) : []

  // The move handle (Edit tool): above whatever is under the pointer, at the pointer.
  const target: GripTarget | null = !p.showOriginal && p.tool === 'edit' ? hover : null
  const grip = (() => {
    if (!target) return null
    if (target.kind === 'run') {
      const r = p.runs.find((x) => x.id === target.id)
      return r && !coveredRuns.has(r.id) ? { target, rect: r.rect, label: p.corrections[r.id] ?? r.text, fontSize: r.size, orig: undefined } : null
    }
    if (target.kind === 'edit') {
      const e = textEdits.find((x) => x.id === target.id)
      return e ? { target, rect: editMarkRect(e), label: e.text, fontSize: e.style.size, orig: undefined } : null
    }
    const it = items.find((x) => x.id === target.id)
    const stored = overlayEdits.find((x) => x.id === target.id)
    return it && stored ? { target, rect: overlayBounds(stored.overlay!), label: undefined, fontSize: undefined, orig: stored.overlay! } : null
  })()
  // while it is being dragged the handle goes with it
  const g0 = gesture.current
  const dragging = g0?.kind === 'grip' && grip && g0.target.kind === grip.target.kind && g0.target.id === grip.target.id ? g0 : null
  // along the top edge, where the pointer is (kept within the thing); below it if the top of the page is in the way
  const gripBelow = !!grip && grip.rect[1] * k < 34
  const gripPos = grip ? { x: Math.min(Math.max(gripX ?? grip.rect[0], grip.rect[0]), grip.rect[2]) + (dragging?.dx ?? 0), y: (gripBelow ? grip.rect[3] : grip.rect[1]) + (dragging?.dy ?? 0) } : null
  const outlined = p.info?.kind === 'outlined'
  const needsOcr = !p.ocrHere && ((p.info?.kind === 'scan' && p.runs.length === 0) || outlined)
  const px = (v: number) => v * k
  const boxStyle = (r: Rect, d = 0) => ({ left: px(r[0] - d), top: px(r[1] - d), width: px(r[2] - r[0] + d * 2), height: px(r[3] - r[1] + d * 2) })

  return (
    <section ref={ref} className="page" data-page={index} aria-label={`Page ${index + 1}`} style={{ width: px(size.width), height: px(size.height) }}>
      <canvas ref={canvas} className="page-canvas" style={{ width: px(size.width), height: px(size.height) }} />
      {!p.showOriginal && <OverlayLayer size={size} items={items} images={p.images} />}
      {busy && <div className="page-busy" aria-hidden="true" />}

      <div
        ref={overlay}
        className={`overlay tool-${p.tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onClick={onOverlayClick}
      >
        {!p.showOriginal && p.tool === 'edit' &&
          p.runs.map((r) => {
            if (coveredRuns.has(r.id) || r.id === p.activeRunId) return null
            const reasons = p.flagReasons.get(r.id)
            const flag = p.flagged.has(r.id)
            return (
              <button
                key={r.id}
                type="button"
                className={`run ${flag ? 'flag' : ''} ${p.proofMode && p.verified[r.id] ? 'ok' : ''} ${p.highlightRunId === r.id ? 'hl' : ''}`}
                style={boxStyle(r.rect, pad)}
                title={reasons ? `${reasons} — check it in the Proofread tab` : 'Click to edit'}
                aria-label={`Edit “${p.corrections[r.id] ?? r.text}”`}
                onPointerEnter={(ev) => hoverIn({ kind: 'run', id: r.id }, toPt(ev)[0])}
                onPointerLeave={hoverOutSoon}
                onClick={(e) => {
                  e.stopPropagation()
                  p.onPickRun(index, r.id)
                }}
              />
            )
          })}

        {!p.showOriginal &&
          p.tool !== 'add' &&
          p.runs.map((r) =>
            r.source === 'ocr' && p.flagged.has(r.id) && r.id !== p.activeRunId
              ? (r.words ?? [])
                  .filter((w) => w.conf < 90)
                  .map((w, i) => (
                    <span key={`${r.id}w${i}`} className="word-flag" style={{ left: px(w.x0), top: px(r.rect[3] - 0.5), width: px(w.x1 - w.x0) }} />
                  ))
              : null,
          )}

        {!p.showOriginal &&
          textEdits
            .filter((e) => e.kind !== 'table') // a table has its own grid
            .map((e) => {
            const interactive = p.tool === 'edit' || p.tool === 'add' || p.tool === 'erase'
            const movable = e.kind === 'replace' || e.kind === 'add'
            return (
              <button
                key={e.id}
                type="button"
                tabIndex={interactive ? 0 : -1}
                className={`mark mark-${e.kind} ${interactive ? '' : 'inert'}`}
                style={boxStyle(editMarkRect(e), pad)}
                title={e.kind === 'erase' ? 'Erased area (click to remove)' : e.move ? 'Moved — click to change' : 'Edited — click to change'}
                aria-label={e.kind === 'erase' ? 'Erased area' : `${e.move ? 'Moved' : 'Edited'} text “${e.text}”`}
                onPointerEnter={(ev) => movable && hoverIn({ kind: 'edit', id: e.id }, toPt(ev)[0])}
                onPointerLeave={hoverOutSoon}
                onClick={(ev) => {
                  ev.stopPropagation()
                  p.onPickEdit(e.id)
                }}
              />
            )
          })}

        {p.highlightRunId && p.tool !== 'edit' && p.runs.filter((r) => r.id === p.highlightRunId).map((r) => <span key="hl" className="hl-box" style={boxStyle(r.rect, 3)} />)}

        {!p.showOriginal && p.findBoxes.map((b, i) => <span key={`f${i}`} className={`find-box ${b.current ? 'cur' : ''}`} style={boxStyle(b.rect, 1)} />)}

        {p.table && p.table.page === index && p.tool === 'table' && !p.showOriginal && <TableLayer view={p.table} k={k} api={p.tableApi} />}

        {ghost && (
          <div className="move-ghost" style={boxStyle(ghost.rect, 1)}>
            {ghost.label && <span style={{ fontSize: px(ghost.fontSize ?? 10) }}>{ghost.label}</span>}
          </div>
        )}
        {ghosts.map((m) => (
          <div key={selId(m.key)} className="move-ghost" style={boxStyle(shifted(m), 1)}>
            {m.label && <span style={{ fontSize: px(m.fontSize ?? 10) }}>{m.label}</span>}
          </div>
        ))}
        {grip && gripPos && (
          <button
            type="button"
            className={`move-grip ${gripBelow ? 'below' : ''} ${dragging ? 'dragging' : ''}`}
            style={{ left: px(gripPos.x), top: px(gripPos.y) + (gripBelow ? 3 : -3) }}
            aria-label="Move"
            title="Drag to move — hold Shift to keep it level"
            onPointerEnter={() => hoverIn(grip.target)}
            onPointerLeave={hoverOutSoon}
            onPointerDown={(e) => beginHandle(e, { kind: 'grip', target: grip.target, start: toPt(e), rect: grip.rect, orig: grip.orig, label: grip.label, fontSize: grip.fontSize, dx: 0, dy: 0, moved: false })}
          >
            <Icon name="move" size={14} />
          </button>
        )}

        {drag && <div className={p.tool === 'table' ? 'table-box' : p.tool === 'select' ? 'marquee-box' : 'erase-box'} style={boxStyle(drag)} />}

        {selected && !p.showOriginal && <SelectionFrame item={selected} k={k} onDelete={() => p.onDeleteOverlay(selected.id)} onHandle={beginHandle} />}
        {frames.map((m) => (
          <span key={selId(m.key)} className={`sel-box ${m.key.kind}`} style={boxStyle(shifted(m), 2)} aria-hidden="true" />
        ))}
        {frames.length > 1 && (
          <span className="sel-count" style={{ left: px(unionRect(frames.map(shifted))[0] - 2), top: px(unionRect(frames.map(shifted))[1] - 2) }} aria-live="polite">
            {frames.length} selected
          </span>
        )}

        {needsOcr && !p.showOriginal && (
          <div className="scan-banner" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <Icon name="scan" size={18} />
            <div>
              <strong>{outlined ? 'This page has no real text.' : 'This page is a scan.'}</strong>
              <span>{outlined ? 'Its letters are drawn as shapes. Recognise them to make the text editable and searchable.' : 'Recognise its text to make it editable and searchable.'}</span>
            </div>
            <button type="button" className="btn primary" disabled={p.ocrBusy} onClick={() => p.onRecognize(index)}>
              {p.ocrBusy ? 'Working…' : 'Recognise text'}
            </button>
          </div>
        )}

        {p.editor}
      </div>
      <div className="page-num" aria-hidden="true">
        {index + 1}
      </div>
    </section>
  )
}

/** Dashed frame around the selected overlay, with handles to resize it (or move a line's ends) and a delete button. */
function SelectionFrame(p: {
  item: { id: string; overlay: Overlay }
  k: number
  onDelete: () => void
  onHandle: (e: React.PointerEvent, g: Gesture) => void
}) {
  const { id, overlay: o } = p.item
  const b = overlayBounds(o)
  const box = contentBox(o)
  const px = (v: number) => v * p.k
  const corners: { c: Corner; x: number; y: number }[] = box
    ? [
        { c: 'nw', x: box[0], y: box[1] },
        { c: 'ne', x: box[2], y: box[1] },
        { c: 'sw', x: box[0], y: box[3] },
        { c: 'se', x: box[2], y: box[3] },
      ]
    : []
  return (
    <>
      <div className="sel-frame" style={{ left: px(b[0] - 2), top: px(b[1] - 2), width: px(b[2] - b[0] + 4), height: px(b[3] - b[1] + 4) }} />
      {corners.map((h) => (
        <span
          key={h.c}
          className={`handle h-${h.c}`}
          style={{ left: px(h.x), top: px(h.y) }}
          onPointerDown={(e) => p.onHandle(e, { kind: 'resize', id, orig: o, corner: h.c, box: box! })}
          aria-hidden="true"
        />
      ))}
      {(o.type === 'line' || o.type === 'arrow') &&
        (['a', 'b'] as const).map((w) => (
          <span key={w} className="handle h-end" style={{ left: px(o[w][0]), top: px(o[w][1]) }} onPointerDown={(e) => p.onHandle(e, { kind: 'end', id, orig: o, which: w })} aria-hidden="true" />
        ))}
      <button
        type="button"
        className="sel-del"
        style={{ left: px(b[2] + 2), top: px(b[1] - 2) }}
        aria-label="Delete this"
        title="Delete (Del)"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          p.onDelete()
        }}
      >
        <Icon name="trash" size={14} />
      </button>
    </>
  )
}

export const PageView = memo(PageViewImpl)
