import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { EngineClient } from '../engine/client.ts'
import type { Edit, PageInfo, PageSize, Rect, TextRun } from '../engine/types.ts'
import { Icon } from './icons.tsx'
import { useDebounced, useNearViewport } from './hooks.ts'
import type { PageCallbacks, Tool } from './types.ts'

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

function editMarkRect(e: Edit): Rect {
  if (e.kind === 'erase') return e.rect!
  if (e.kind === 'replace') return e.run!.rect
  const size = e.style.size
  return [e.x!, e.baseline! - size, e.x! + Math.max(size, e.text.length * size * 0.55), e.baseline! + size * 0.3]
}

function PageViewImpl(p: Props) {
  const { index, size, k, engine } = p
  const [ref, near] = useNearViewport()
  const canvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState<Rect | null>(null)
  const dragStart = useRef<[number, number] | null>(null)

  useEffect(() => {
    if (near) p.onVisible(index)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, index])

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
      .render(index, renderScale, p.showOriginal ? [] : p.edits)
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
  }, [near, renderScale, p.edits, p.showOriginal, p.docId, engine, index])

  const toPt = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = overlay.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (p.tool !== 'erase' || e.button !== 0) return
    dragStart.current = toPt(e)
    setDrag(null)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return
    const [x, y] = toPt(e)
    const [sx, sy] = dragStart.current
    setDrag([Math.min(sx, x), Math.min(sy, y), Math.max(sx, x), Math.max(sy, y)])
  }
  const onPointerUp = () => {
    const r = drag
    dragStart.current = null
    setDrag(null)
    if (p.tool === 'erase' && r && r[2] - r[0] > 3 && r[3] - r[1] > 3) p.onErase(index, r)
  }
  const onOverlayClick = (e: React.MouseEvent) => {
    if (p.tool !== 'add') return
    const [x, y] = toPt(e)
    p.onAddAt(index, x, y + 9.5)
  }

  const coveredRuns = new Set(p.edits.filter((e) => e.kind === 'replace').map((e) => e.run!.id))
  const outlined = p.info?.kind === 'outlined'
  const needsOcr = !p.ocrHere && ((p.info?.kind === 'scan' && p.runs.length === 0) || outlined)
  const px = (v: number) => v * k

  return (
    <section ref={ref} className="page" data-page={index} aria-label={`Page ${index + 1}`} style={{ width: px(size.width), height: px(size.height) }}>
      <canvas ref={canvas} className="page-canvas" style={{ width: px(size.width), height: px(size.height) }} />
      {busy && <div className="page-busy" aria-hidden="true" />}

      <div
        ref={overlay}
        className={`overlay tool-${p.tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
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
                style={{ left: px(r.rect[0] - pad), top: px(r.rect[1] - pad), width: px(r.rect[2] - r.rect[0] + pad * 2), height: px(r.rect[3] - r.rect[1] + pad * 2) }}
                title={reasons ? `${reasons} — check it in the Proofread tab` : 'Click to edit'}
                aria-label={`Edit “${p.corrections[r.id] ?? r.text}”`}
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
          p.edits.map((e) => {
            const [x0, y0, x1, y1] = editMarkRect(e)
            return (
              <button
                key={e.id}
                type="button"
                className={`mark mark-${e.kind}`}
                style={{ left: px(x0 - pad), top: px(y0 - pad), width: px(x1 - x0 + pad * 2), height: px(y1 - y0 + pad * 2) }}
                title={e.kind === 'erase' ? 'Erased area (click to remove)' : 'Edited — click to change'}
                aria-label={e.kind === 'erase' ? 'Erased area' : `Edited text “${e.text}”`}
                onClick={(ev) => {
                  ev.stopPropagation()
                  p.onPickEdit(e.id)
                }}
              />
            )
          })}

        {p.highlightRunId && p.tool !== 'edit' && p.runs.filter((r) => r.id === p.highlightRunId).map((r) => <span key="hl" className="hl-box" style={{ left: px(r.rect[0] - 3), top: px(r.rect[1] - 3), width: px(r.rect[2] - r.rect[0] + 6), height: px(r.rect[3] - r.rect[1] + 6) }} />)}

        {drag && <div className="erase-box" style={{ left: px(drag[0]), top: px(drag[1]), width: px(drag[2] - drag[0]), height: px(drag[3] - drag[1]) }} />}

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

export const PageView = memo(PageViewImpl)
