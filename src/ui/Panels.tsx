import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client.ts'
import { OVERLAY_LABEL } from '../engine/overlay.ts'
import type { Edit, PageInfo, TextRun } from '../engine/types.ts'
import { LANGUAGES, reviewReasons } from '../ocr/ocr.ts'
import { useNearViewport } from './hooks.ts'
import { Icon } from './icons.tsx'
import { TOUCH } from './touch.ts'
import type { Snapshot } from './store.ts'

// --------------------------------------------------------------------------------------- changes

const KIND_LABEL = { replace: 'Edited text', add: 'Added text', erase: 'Erased area', table: 'Table' } as const
/** a line that was only dragged elsewhere (its words are as they were) */
const onlyMoved = (e: Edit) => e.kind === 'replace' && !!e.move && e.text === e.run!.text
const label = (e: Edit) => (e.kind === 'overlay' ? OVERLAY_LABEL[e.overlay!.type] : onlyMoved(e) ? 'Moved text' : KIND_LABEL[e.kind])
/** One short line about an overlay for the Changes list (the page underneath is never altered). */
const overlayNote = (e: Edit) => {
  const o = e.overlay!
  if (o.type === 'highlight' || o.type === 'underline' || o.type === 'strike') return `${o.rects.length} line${o.rects.length === 1 ? '' : 's'} of text`
  return 'Added on top'
}

export function ChangesPanel(p: { edits: Edit[]; corrections: number; onJump: (e: Edit) => void; onRemove: (id: string) => void }) {
  if (!p.edits.length && !p.corrections) {
    return (
      <div className="empty">
        <Icon name="pencil" size={28} />
        <h3>No changes yet</h3>
        <p>
          {TOUCH ? (
            'Tap any text to edit it, or pick a tool from the bar below to add text, highlight, draw, sign or erase.'
          ) : (
            <>
          Click any text to edit it. <kbd>T</kbd> adds text, <kbd>H</kbd> highlights, <kbd>G</kbd> signs, <kbd>X</kbd> erases — or press <kbd>Ctrl</kbd>+<kbd>F</kbd> to find and replace.
            </>
          )}
        </p>
      </div>
    )
  }
  return (
    <div className="changes">
      <ul className="list">
        {p.edits.map((e) => (
          <li key={e.id} className="change">
            <button type="button" className="change-main" onClick={() => p.onJump(e)}>
              <span className={`badge kind-${e.kind}`}>{label(e)}</span>
              <span className="change-text">
                {onlyMoved(e) && (
                  <>
                    <ins>{e.text}</ins>
                    <span className="muted small"> · {Math.round(Math.abs(e.move![0]))} pt {e.move![0] >= 0 ? 'right' : 'left'}, {Math.round(Math.abs(e.move![1]))} pt {e.move![1] >= 0 ? 'down' : 'up'}</span>
                  </>
                )}
                {e.kind === 'replace' && !onlyMoved(e) && (
                  <>
                    <del>{e.run!.text}</del>
                    <Icon name="arrowRight" size={13} />
                    <ins>{e.text || '(removed)'}</ins>
                  </>
                )}
                {e.kind === 'add' && <ins>{e.text}</ins>}
                {e.kind === 'erase' && <span className="muted">{e.redact ? 'Redacted with a black box' : 'Content removed'}</span>}
                {e.kind === 'overlay' && <span className="muted">{overlayNote(e)}</span>}
                {e.kind === 'table' && <span className="muted">{e.table!.deleted ? 'Table removed' : `Redrawn as ${e.table!.model.ys.length - 1} rows × ${e.table!.model.xs.length - 1} columns`}</span>}
              </span>
              <span className="muted small">Page {e.page + 1}</span>
            </button>
            <button type="button" className="icon-btn" aria-label="Remove this change" title="Remove this change" onClick={() => p.onRemove(e.id)}>
              <Icon name="x" size={15} />
            </button>
          </li>
        ))}
      </ul>
      {p.corrections > 0 && (
        <p className="note">
          <Icon name="info" size={15} /> {p.corrections} recognised word{p.corrections === 1 ? '' : 's'} corrected in the searchable layer (the scan picture is unchanged).
        </p>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------ proofread

const cropCache = new Map<string, ImageData>()

function Crop({ engine, docId, run, root }: { engine: EngineClient; docId: number; run: TextRun; root: HTMLElement | null }) {
  const [ref, near] = useNearViewport(300, root)
  const cv = useRef<HTMLCanvasElement>(null)
  const key = `${docId}:${run.id}`
  useEffect(() => {
    if (!near || !cv.current) return
    let alive = true
    const draw = (img: ImageData) => {
      const c = cv.current
      if (!alive || !c) return
      c.width = img.width
      c.height = img.height
      c.getContext('2d')!.putImageData(img, 0, 0)
    }
    const hit = cropCache.get(key)
    if (hit) return draw(hit), undefined
    const padX = Math.max(3, run.size * 0.4)
    const padY = Math.max(2, run.size * 0.25)
    const rect: [number, number, number, number] = [run.rect[0] - padX, run.rect[1] - padY, run.rect[2] + padX, run.rect[3] + padY]
    const scale = Math.min(5, Math.max(2.5, 560 / (rect[2] - rect[0])))
    engine
      .renderClip(run.page, rect, scale)
      .then((r) => {
        const img = new ImageData(r.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, r.width, r.height)
        cropCache.set(key, img)
        draw(img)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [near, key, engine, run])
  return (
    <div ref={ref} className="crop">
      <canvas ref={cv} aria-label={`Scan crop of “${run.text}”`} role="img" />
    </div>
  )
}

const ProofRow = memo(function ProofRow(p: {
  engine: EngineClient
  docId: number
  run: TextRun
  text: string
  verified: boolean
  reasons: string[]
  active: boolean
  root: HTMLElement | null
  onFocus: (run: TextRun) => void
  onConfirm: (run: TextRun, text: string) => void
  onNext: (run: TextRun) => void
}) {
  const [value, setValue] = useState(p.text)
  useEffect(() => setValue(p.text), [p.text])
  const dirty = value !== p.text
  const confirm = () => {
    p.onConfirm(p.run, value)
  }
  return (
    <li className={`proof-row ${p.verified ? 'verified' : ''} ${p.reasons.length ? 'flagged' : ''} ${p.active ? 'active' : ''}`} data-run={p.run.id}>
      <Crop engine={p.engine} docId={p.docId} run={p.run} root={p.root} />
      <div className="proof-edit">
        <input
          aria-label={`Recognised text, page ${p.run.page + 1}`}
          value={value}
          spellCheck={false}
          onFocus={() => p.onFocus(p.run)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              confirm()
              p.onNext(p.run)
            } else if (e.key === 'Escape') {
              setValue(p.text)
            }
          }}
        />
        <button
          type="button"
          className={`btn small ${p.verified && !dirty ? 'ghost ok' : 'primary'}`}
          onClick={() => {
            confirm()
            p.onNext(p.run)
          }}
          aria-label={p.verified && !dirty ? 'Verified' : 'Confirm this text matches the scan'}
          title="Confirm this text matches the scan (Enter)"
        >
          <Icon name="check" size={15} />
          {p.verified && !dirty ? 'Verified' : 'Matches scan'}
        </button>
      </div>
      {p.reasons.length > 0 && !p.verified && (
        <p className="reason">
          <Icon name="alert" size={14} /> {p.reasons.join(' · ')}
        </p>
      )}
    </li>
  )
})

export function ProofPanel(p: {
  engine: EngineClient
  docId: number
  runs: Record<number, TextRun[]>
  infos: Record<number, PageInfo>
  snapshot: Snapshot
  threshold: number
  setThreshold: (n: number) => void
  lang: string
  setLang: (l: string) => void
  ocrJob: { page: number; done: number; total: number; status: string; progress: number } | null
  scanPages: number[]
  currentPage: number
  onRecognize: (pages: number[]) => void
  onFocusRun: (run: TextRun) => void
  onConfirm: (run: TextRun, text: string) => void
}) {
  const [filter, setFilter] = useState<'review' | 'all'>('review')
  const [root, setRoot] = useState<HTMLElement | null>(null)
  const list = useRef<HTMLUListElement>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [ocrOpen, setOcrOpen] = useState(false)

  const rows = useMemo(() => {
    const out: { run: TextRun; reasons: string[]; verified: boolean; text: string }[] = []
    for (const page of p.scanPages) {
      const info = p.infos[page]
      for (const run of p.runs[page] ?? []) {
        if ((info?.kind === 'scan' || info?.kind === 'outlined') && run.source !== 'ocr') continue
        const verified = !!p.snapshot.verified[run.id]
        const reasons = run.source === 'ocr' ? reviewReasons(run, p.threshold) : []
        out.push({ run, reasons, verified, text: p.snapshot.corrections[run.id] ?? run.text })
      }
    }
    return out
  }, [p.scanPages, p.infos, p.runs, p.snapshot.verified, p.snapshot.corrections, p.threshold])

  const total = rows.length
  const verifiedN = rows.filter((r) => r.verified).length
  const needReview = rows.filter((r) => r.reasons.length && !r.verified).length
  const shown = filter === 'all' ? rows : rows.filter((r) => !r.verified && r.reasons.length > 0)
  const unscanned = p.scanPages.filter((pg) => {
    const k = p.infos[pg]?.kind
    return (k === 'scan' && !p.runs[pg]?.length) || (k === 'outlined' && !p.runs[pg]?.some((r) => r.source === 'ocr'))
  })

  const focusNext = (run: TextRun) => {
    const i = shown.findIndex((r) => r.run.id === run.id)
    const next = shown[i + 1]
    if (!next) return
    requestAnimationFrame(() => list.current?.querySelector<HTMLInputElement>(`[data-run="${CSS.escape(next.run.id)}"] input`)?.focus())
  }

  return (
    <div className="proof">
      <div className="proof-head">
        <div className="proof-stats" aria-live="polite">
          <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={verifiedN} aria-label="Runs verified by you">
            <span style={{ width: total ? `${(verifiedN / total) * 100}%` : '0%' }} />
          </div>
          <p>
            <strong>{verifiedN}</strong> of {total} verified by you
            {needReview > 0 && (
              <>
                {' · '}
                <span className="warn-text">{needReview} need review</span>
              </>
            )}
          </p>
        </div>

        {total > 0 && !p.ocrJob && (
          <button type="button" className="ocr-toggle" aria-expanded={ocrOpen} onClick={() => setOcrOpen((o) => !o)}>
            <span>
              <Icon name="scan" size={16} /> Text recognition
            </span>
            <Icon name={ocrOpen ? 'chevronUp' : 'chevronDown'} size={16} />
          </button>
        )}
        <div className="ocr-box" hidden={total > 0 && !p.ocrJob && !ocrOpen}>
          <label className="field">
            <span>Language</span>
            <select value={p.lang} onChange={(e) => p.setLang(e.target.value)} disabled={!!p.ocrJob}>
              {LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
          <div className="row">
            <button type="button" className="btn" disabled={!!p.ocrJob || !p.scanPages.length} onClick={() => p.onRecognize([p.currentPage])}>
              <Icon name="scan" size={16} /> This page
            </button>
            <button type="button" className="btn" disabled={!!p.ocrJob || !p.scanPages.length} onClick={() => p.onRecognize(p.scanPages)}>
              All scanned pages
            </button>
          </div>
          {p.ocrJob && (
            <div className="ocr-progress" aria-live="polite">
              <div className="meter indeterminate">
                <span style={{ width: `${Math.round(p.ocrJob.progress * 100)}%` }} />
              </div>
              <small>
                Page {p.ocrJob.page + 1} ({p.ocrJob.done + 1}/{p.ocrJob.total}) · {p.ocrJob.status}
              </small>
            </div>
          )}
          {p.lang !== 'eng' && <small className="muted">First use of this language downloads its data once (needs internet).</small>}
        </div>

        <div className="proof-filter">
          <div className="seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={filter === 'review'} className={filter === 'review' ? 'on' : ''} onClick={() => setFilter('review')}>
              Needs review
            </button>
            <button type="button" role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>
              All text
            </button>
          </div>
          <label className="slider" title="Words below this confidence are flagged">
            <span>Flag below {p.threshold}%</span>
            <input type="range" min={50} max={99} value={p.threshold} onChange={(e) => p.setThreshold(parseInt(e.target.value))} />
          </label>
        </div>
      </div>

      {unscanned.length > 0 && (
        <p className="note">
          <Icon name="info" size={15} /> {unscanned.length === 1 ? `Page ${unscanned[0] + 1} hasn’t` : `${unscanned.length} scanned pages haven’t`} been recognised yet.
        </p>
      )}

      <ul
        className="proof-list"
        ref={(el) => {
          list.current = el
          if (el !== root) setRoot(el)
        }}
      >
        {shown.map((r) => (
          <ProofRow
            key={r.run.id}
            engine={p.engine}
            docId={p.docId}
            run={r.run}
            text={r.text}
            verified={r.verified}
            reasons={r.reasons}
            active={activeId === r.run.id}
            root={root}
            onFocus={(run) => {
              setActiveId(run.id)
              p.onFocusRun(run)
            }}
            onConfirm={p.onConfirm}
            onNext={focusNext}
          />
        ))}
        {!shown.length && (
          <li className="empty small">
            <Icon name={total ? 'shield' : 'scan'} size={26} />
            <h3>{total ? (filter === 'review' ? 'Nothing left to review' : 'No text') : 'No recognised text yet'}</h3>
            <p>
              {total
                ? 'Switch to “All text” to read every line against the scan.'
                : p.scanPages.length
                  ? 'Run “This page” or “All scanned pages” to recognise the text.'
                  : 'This document has no scanned pages — its text is already exact.'}
            </p>
          </li>
        )}
      </ul>
    </div>
  )
}
