import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EngineClient } from '../../engine/client.ts'
import { parseRanges } from '../../engine/ranges.ts'
import type { PageSize } from '../../engine/types.ts'
import { useNearViewport } from '../hooks.ts'
import { Icon } from '../icons.tsx'
import { uid } from '../store.ts'
import { baseName, FileChip, PDF, PdfInput, ResultCard, ToolShell, usePdfInput, useTask, type LoadedPdf, type Output, type ToolProps } from './shared.tsx'

interface PageItem {
  key: string
  /** page index in the source file */
  src: number
  /** extra clockwise turn in degrees: 0, 90, 180 or 270 */
  rot: number
}

const BOX = 168

/** A page thumbnail. Rotation is applied when drawing, so the box always matches what you will get. */
function PageThumb(p: { engine: EngineClient; fileKey: number; src: number; size: PageSize; rot: number; ready: boolean }) {
  const [ref, near] = useNearViewport(400, null)
  const cv = useRef<HTMLCanvasElement>(null)
  const base = useRef<HTMLCanvasElement | null>(null)
  const [loaded, setLoaded] = useState(false)

  const draw = useCallback(() => {
    const c = cv.current
    const b = base.current
    if (!c || !b) return
    const q = ((p.rot % 360) + 360) % 360
    const swap = q === 90 || q === 270
    c.width = swap ? b.height : b.width
    c.height = swap ? b.width : b.height
    const g = c.getContext('2d')!
    g.save()
    g.translate(c.width / 2, c.height / 2)
    g.rotate((q * Math.PI) / 180)
    g.drawImage(b, -b.width / 2, -b.height / 2)
    g.restore()
  }, [p.rot])

  useEffect(() => {
    if (!near || !p.ready || base.current) return
    let alive = true
    const scale = (BOX / Math.max(p.size.width, p.size.height)) * Math.min(2, window.devicePixelRatio || 1)
    p.engine
      .render(p.src, scale, [])
      .then((r) => {
        if (!alive) return
        const b = document.createElement('canvas')
        b.width = r.width
        b.height = r.height
        b.getContext('2d')!.putImageData(new ImageData(r.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0)
        base.current = b
        setLoaded(true)
        draw()
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [near, p.ready, p.engine, p.src, p.size.width, p.size.height, p.fileKey, draw])

  useEffect(draw, [draw, loaded])

  return (
    <div ref={ref} className={`pthumb ${loaded ? '' : 'loading'}`}>
      <canvas ref={cv} />
    </div>
  )
}

function Organizer(p: { engine: EngineClient; pdf: LoadedPdf; fileKey: number; onChangeFile: () => void; onOpenInEditor: ToolProps['onOpenInEditor'] }) {
  const { pdf, engine } = p
  const initial = useMemo<PageItem[]>(() => pdf.sizes.map((_, i) => ({ key: `p${i}`, src: i, rot: 0 })), [pdf])
  const [items, setItems] = useState<PageItem[]>(initial)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [ready, setReady] = useState(false)
  const [rangeText, setRangeText] = useState('')
  const [rangeErr, setRangeErr] = useState('')
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overKey, setOverKey] = useState<string | null>(null)
  const [out, setOut] = useState<Output | null>(null)
  const task = useTask()

  // Open the file in this tool's own engine session, just to draw thumbnails.
  useEffect(() => {
    let alive = true
    setReady(false)
    engine
      .open(pdf.bytes.slice(), pdf.password)
      .then((r) => alive && setReady(r.status === 'ok'))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [engine, pdf])

  const edit = (fn: (l: PageItem[]) => PageItem[]) => {
    setOut(null)
    setItems(fn)
  }
  const turn = (keys: Set<string>, d: number) => edit((l) => l.map((it) => (keys.has(it.key) ? { ...it, rot: (it.rot + d + 360) % 360 } : it)))
  const remove = (keys: Set<string>) => {
    edit((l) => l.filter((it) => !keys.has(it.key)))
    setSel((s) => new Set([...s].filter((k) => !keys.has(k))))
  }
  const duplicate = (key: string) =>
    edit((l) => {
      const i = l.findIndex((x) => x.key === key)
      return [...l.slice(0, i + 1), { ...l[i], key: uid('d') }, ...l.slice(i + 1)]
    })
  const shift = (d: -1 | 1) =>
    edit((l) => {
      const n = [...l]
      if (d === -1) {
        for (let i = 1; i < n.length; i++) if (sel.has(n[i].key) && !sel.has(n[i - 1].key)) [n[i - 1], n[i]] = [n[i], n[i - 1]]
      } else {
        for (let i = n.length - 2; i >= 0; i--) if (sel.has(n[i].key) && !sel.has(n[i + 1].key)) [n[i + 1], n[i]] = [n[i], n[i + 1]]
      }
      return n
    })
  const dropOn = (targetKey: string) => {
    const from = dragKey
    setDragKey(null)
    setOverKey(null)
    if (!from || from === targetKey) return
    edit((l) => {
      const a = l.findIndex((x) => x.key === from)
      const moved = l[a]
      const rest = l.filter((x) => x.key !== from)
      const b = rest.findIndex((x) => x.key === targetKey)
      // dragging forward lands after the target, dragging back lands before it
      rest.splice(a < l.findIndex((x) => x.key === targetKey) ? b + 1 : b, 0, moved)
      return rest
    })
  }
  const toggle = (key: string) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const selectRange = () => {
    const r = parseRanges(rangeText, items.length)
    setRangeErr(r.error ?? '')
    if (!r.error) setSel(new Set(r.pages.map((i) => items[i].key)))
  }

  const selected = useMemo(() => new Set(items.filter((it) => sel.has(it.key)).map((it) => it.key)), [items, sel])
  const dirty = items.length !== initial.length || items.some((it, i) => it.src !== initial[i].src || it.rot !== 0)
  const ops = (list: PageItem[]) => list.map((it) => ({ src: it.src, rotate: it.rot }))
  const build = (list: PageItem[], suffix: string) =>
    task.run(async () => {
      const r = await engine.rebuild({ bytes: pdf.bytes, password: pdf.password }, ops(list))
      setOut({ name: `${baseName(pdf.name)}-${suffix}.pdf`, bytes: r.bytes, mime: PDF, pages: r.pages })
    })

  const selCount = selected.size

  return (
    <>
      <FileChip pdf={pdf} onChange={p.onChangeFile} />

      {out && <ResultCard out={out} onOpenInEditor={p.onOpenInEditor} onAgain={() => setOut(null)} againLabel="Keep arranging" />}

      <div className="org-bar" role="toolbar" aria-label="Page actions">
        <div className="org-group">
          <button type="button" className="btn small" onClick={() => setSel(new Set(items.map((i) => i.key)))}>
            Select all
          </button>
          <button type="button" className="btn small" disabled={!selCount} onClick={() => setSel(new Set())}>
            None
          </button>
          <form
            className="org-range"
            onSubmit={(e) => {
              e.preventDefault()
              selectRange()
            }}
          >
            <input value={rangeText} onChange={(e) => setRangeText(e.target.value)} placeholder="Pages, e.g. 1-3, 5, 8-" aria-label="Select pages by number" aria-invalid={!!rangeErr} />
            <button type="submit" className="btn small">
              Select
            </button>
          </form>
        </div>
        <div className="org-group">
          <button type="button" className="btn small" disabled={!selCount} onClick={() => turn(selected, 270)} title="Rotate selected pages left">
            <Icon name="rotate" size={15} /> Left
          </button>
          <button type="button" className="btn small" disabled={!selCount} onClick={() => turn(selected, 90)} title="Rotate selected pages right">
            <Icon name="rotateCw" size={15} /> Right
          </button>
          <button type="button" className="btn small" disabled={!selCount} onClick={() => shift(-1)} title="Move selected pages earlier">
            <Icon name="arrowLeft" size={15} />
          </button>
          <button type="button" className="btn small" disabled={!selCount} onClick={() => shift(1)} title="Move selected pages later">
            <Icon name="arrowRight" size={15} />
          </button>
          <button type="button" className="btn small" disabled={!selCount || task.busy} onClick={() => void build(items.filter((i) => selected.has(i.key)), 'extract')} title="Save the selected pages as a new PDF">
            <Icon name="scissors" size={15} /> Extract
          </button>
          <button type="button" className="btn small danger" disabled={!selCount || selCount >= items.length} onClick={() => remove(selected)} title={selCount >= items.length ? 'A PDF needs at least one page' : 'Delete selected pages'}>
            <Icon name="trash" size={15} /> Delete
          </button>
        </div>
      </div>
      {rangeErr && <p className="error-text">{rangeErr}</p>}

      <ul className="pgrid" aria-label="Pages">
        {items.map((it, pos) => (
          <li
            key={it.key}
            className={`pcard ${selected.has(it.key) ? 'sel' : ''} ${dragKey === it.key ? 'dragging' : ''} ${overKey === it.key && dragKey !== it.key ? 'drop' : ''}`}
            draggable
            onDragStart={(e) => {
              setDragKey(it.key)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', it.key)
            }}
            onDragOver={(e) => {
              if (!dragKey) return
              e.preventDefault()
              e.stopPropagation()
              setOverKey(it.key)
            }}
            onDrop={(e) => {
              if (!dragKey) return
              e.preventDefault()
              e.stopPropagation()
              dropOn(it.key)
            }}
            onDragEnd={() => {
              setDragKey(null)
              setOverKey(null)
            }}
          >
            <button type="button" className="pcard-main" onClick={() => toggle(it.key)} aria-pressed={selected.has(it.key)} aria-label={`Page ${pos + 1}, from original page ${it.src + 1}${it.rot ? `, turned ${it.rot} degrees` : ''}`}>
              <PageThumb engine={engine} fileKey={p.fileKey} src={it.src} size={pdf.sizes[it.src]} rot={it.rot} ready={ready} />
              <span className="pcard-check" aria-hidden="true">
                <Icon name="check" size={14} />
              </span>
            </button>
            <div className="pcard-bar">
              <span className="pcard-num">
                {pos + 1}
                {it.src !== pos && <small> (was {it.src + 1})</small>}
              </span>
              <span className="pcard-actions">
                <button type="button" className="icon-btn sm" aria-label={`Rotate page ${pos + 1} left`} title="Rotate left" onClick={() => turn(new Set([it.key]), 270)}>
                  <Icon name="rotate" size={15} />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Rotate page ${pos + 1} right`} title="Rotate right" onClick={() => turn(new Set([it.key]), 90)}>
                  <Icon name="rotateCw" size={15} />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Duplicate page ${pos + 1}`} title="Duplicate" onClick={() => duplicate(it.key)}>
                  <Icon name="copy" size={15} />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Delete page ${pos + 1}`} title="Delete" disabled={items.length === 1} onClick={() => remove(new Set([it.key]))}>
                  <Icon name="trash" size={15} />
                </button>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <div className="tool-actions sticky">
        <span className="muted small">
          {items.length} page{items.length === 1 ? '' : 's'}
          {selected.size ? ` · ${selected.size} selected` : ''}
          {dirty ? ' · changed' : ' · drag pages to re-order them'}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost"
          disabled={!dirty}
          onClick={() => {
            edit(() => initial)
            setSel(new Set())
          }}
        >
          <Icon name="undo" size={16} /> Reset
        </button>
        <button type="button" className="btn primary" disabled={!dirty || !items.length || task.busy} onClick={() => void build(items, 'organized')}>
          <Icon name={task.busy ? 'loader' : 'download'} size={16} className={task.busy ? 'spin' : ''} />
          {task.busy ? 'Saving…' : 'Save PDF'}
        </button>
      </div>
      {task.error && <p className="error-text">{task.error}</p>}
    </>
  )
}

export function OrganizeTool({ engine, onOpenInEditor }: ToolProps) {
  const input = usePdfInput(engine)
  useEffect(() => () => void engine.closeDoc().catch(() => {}), [engine])
  return (
    <ToolShell title="Organize pages" blurb="Click pages to select them, drag to re-order. Rotate, duplicate, delete or extract, then save a new PDF." icon="pages" wide>
      {input.pdf ? <Organizer key={input.pdf.id} engine={engine} pdf={input.pdf} fileKey={input.pdf.id} onChangeFile={input.clear} onOpenInEditor={onOpenInEditor} /> : <PdfInput input={input} />}
    </ToolShell>
  )
}
