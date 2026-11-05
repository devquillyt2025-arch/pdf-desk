import { useEffect, useMemo, useRef, useState } from 'react'
import type { NumberPosition, StampOptions } from '../../engine/tools.ts'
import type { Rgb } from '../../engine/types.ts'
import { useDebounced } from '../hooks.ts'
import { Icon } from '../icons.tsx'
import { baseName, FileChip, PDF, PdfInput, ResultCard, ToolShell, usePdfInput, useTask, type Output, type ToolProps } from './shared.tsx'

const FORMATS = ['{n}', 'Page {n}', 'Page {n} of {N}', '{n} / {N}', '- {n} -']
const POSITIONS: [NumberPosition, string][] = [
  ['bottom-center', 'Bottom centre'],
  ['bottom-right', 'Bottom right'],
  ['bottom-left', 'Bottom left'],
  ['top-center', 'Top centre'],
  ['top-right', 'Top right'],
  ['top-left', 'Top left'],
]
const COLORS: [string, Rgb][] = [
  ['Black', [0, 0, 0]],
  ['Dark grey', [85, 85, 85]],
  ['Grey', [150, 150, 150]],
  ['Red', [200, 30, 30]],
  ['Blue', [30, 80, 200]],
]
const clamp = (v: number, lo: number, hi: number, fallback: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback)

export function StampTool({ engine, onOpenInEditor }: ToolProps) {
  const input = usePdfInput(engine)
  const { pdf } = input

  const [numOn, setNumOn] = useState(true)
  const [format, setFormat] = useState('Page {n} of {N}')
  const [position, setPosition] = useState<NumberPosition>('bottom-center')
  const [numSize, setNumSize] = useState(10)
  const [start, setStart] = useState(1)
  const [skipFirst, setSkipFirst] = useState(false)
  const [numColor, setNumColor] = useState(0)

  const [wmOn, setWmOn] = useState(false)
  const [wmText, setWmText] = useState('CONFIDENTIAL')
  const [wmSize, setWmSize] = useState(72)
  const [wmOpacity, setWmOpacity] = useState(20)
  const [wmAngle, setWmAngle] = useState(45)
  const [wmColor, setWmColor] = useState(2)

  const [previewPage, setPreviewPage] = useState(0)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewErr, setPreviewErr] = useState('')
  const [out, setOut] = useState<Output | null>(null)
  const task = useTask()
  const lastUrl = useRef<string | null>(null)

  const opts = useMemo<StampOptions>(
    () => ({
      numbers: numOn
        ? { format, position, size: clamp(numSize, 4, 48, 10), start: Math.round(clamp(start, -9999, 99999, 1)), margin: 28, color: COLORS[numColor][1], skipFirst }
        : null,
      watermark: wmOn && wmText.trim() ? { text: wmText, size: clamp(wmSize, 8, 300, 72), opacity: clamp(wmOpacity, 3, 100, 20) / 100, angle: wmAngle, color: COLORS[wmColor][1] } : null,
    }),
    [numOn, format, position, numSize, start, skipFirst, numColor, wmOn, wmText, wmSize, wmOpacity, wmAngle, wmColor],
  )
  const nothing = !opts.numbers && !opts.watermark
  const dOpts = useDebounced(opts, 250)

  useEffect(() => {
    setOut(null)
    setPreviewPage(0)
  }, [pdf?.id])

  // Live preview: the engine stamps just the page being shown.
  useEffect(() => {
    if (!pdf) return
    let alive = true
    setPreviewErr('')
    engine
      .stampPreview({ bytes: pdf.bytes, password: pdf.password }, dOpts, previewPage, 640)
      .then((r) => {
        if (!alive) return
        const url = URL.createObjectURL(new Blob([r.png as BlobPart], { type: 'image/png' }))
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
        lastUrl.current = url
        setPreview(url)
      })
      .catch((e) => alive && setPreviewErr((e as Error).message))
    return () => {
      alive = false
    }
  }, [engine, pdf, dOpts, previewPage])
  useEffect(
    () => () => {
      if (lastUrl.current) URL.revokeObjectURL(lastUrl.current)
    },
    [],
  )

  const apply = () =>
    task.run(async () => {
      if (!pdf) return
      const r = await engine.stamp({ bytes: pdf.bytes, password: pdf.password }, opts)
      setOut({ name: `${baseName(pdf.name)}-stamped.pdf`, bytes: r.bytes, mime: PDF, pages: r.pages, warnings: r.warnings })
    })

  return (
    <ToolShell title="Page numbers & watermark" blurb="Number every page, stamp a line of text across it, or both. The preview shows exactly what will be saved." icon="hash" wide>
      {!pdf ? (
        <PdfInput input={input} />
      ) : (
        <>
          <FileChip pdf={pdf} onChange={input.clear} />
          {out && <ResultCard out={out} onOpenInEditor={onOpenInEditor} onAgain={() => setOut(null)} againLabel="Change settings" />}
          <div className="stamp-layout">
            <div className="stamp-opts">
              <fieldset className="opt-group">
                <legend>
                  <label className="check strong">
                    <input type="checkbox" checked={numOn} onChange={(e) => setNumOn(e.target.checked)} /> Page numbers
                  </label>
                </legend>
                <div className="opt-grid" aria-disabled={!numOn}>
                  <label className="field span2">
                    <span>Text — {'{n}'} is the page number, {'{N}'} the page count</span>
                    <input value={format} onChange={(e) => setFormat(e.target.value)} disabled={!numOn} />
                  </label>
                  <div className="chips span2">
                    {FORMATS.map((f) => (
                      <button key={f} type="button" className={`fchip ${format === f ? 'on' : ''}`} disabled={!numOn} onClick={() => setFormat(f)}>
                        {f}
                      </button>
                    ))}
                  </div>
                  <label className="field">
                    <span>Position</span>
                    <select value={position} onChange={(e) => setPosition(e.target.value as NumberPosition)} disabled={!numOn}>
                      {POSITIONS.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Colour</span>
                    <select value={numColor} onChange={(e) => setNumColor(Number(e.target.value))} disabled={!numOn}>
                      {COLORS.map(([l], i) => (
                        <option key={l} value={i}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Size (pt)</span>
                    <input type="number" min={4} max={48} value={numSize} onChange={(e) => setNumSize(Number(e.target.value))} disabled={!numOn} />
                  </label>
                  <label className="field">
                    <span>Start at</span>
                    <input type="number" value={start} onChange={(e) => setStart(Number(e.target.value))} disabled={!numOn} />
                  </label>
                  <label className="check span2">
                    <input type="checkbox" checked={skipFirst} onChange={(e) => setSkipFirst(e.target.checked)} disabled={!numOn} /> Leave the first page without a number
                  </label>
                </div>
              </fieldset>

              <fieldset className="opt-group">
                <legend>
                  <label className="check strong">
                    <input type="checkbox" checked={wmOn} onChange={(e) => setWmOn(e.target.checked)} /> Watermark
                  </label>
                </legend>
                <div className="opt-grid" aria-disabled={!wmOn}>
                  <label className="field span2">
                    <span>Text</span>
                    <input value={wmText} onChange={(e) => setWmText(e.target.value)} disabled={!wmOn} maxLength={60} />
                  </label>
                  <label className="field">
                    <span>Size (pt)</span>
                    <input type="number" min={8} max={300} value={wmSize} onChange={(e) => setWmSize(Number(e.target.value))} disabled={!wmOn} />
                  </label>
                  <label className="field">
                    <span>Angle</span>
                    <select value={wmAngle} onChange={(e) => setWmAngle(Number(e.target.value))} disabled={!wmOn}>
                      <option value={0}>Straight</option>
                      <option value={30}>Slight tilt</option>
                      <option value={45}>Diagonal ↗</option>
                      <option value={-45}>Diagonal ↘</option>
                      <option value={90}>Vertical</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Colour</span>
                    <select value={wmColor} onChange={(e) => setWmColor(Number(e.target.value))} disabled={!wmOn}>
                      {COLORS.map(([l], i) => (
                        <option key={l} value={i}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>See-through: {wmOpacity}% ink</span>
                    <input type="range" min={5} max={100} step={5} value={wmOpacity} onChange={(e) => setWmOpacity(Number(e.target.value))} disabled={!wmOn} />
                  </label>
                </div>
              </fieldset>
            </div>

            <div className="stamp-preview">
              <div className="stamp-preview-bar">
                <button type="button" className="icon-btn" aria-label="Previous page" disabled={previewPage <= 0} onClick={() => setPreviewPage((p) => p - 1)}>
                  <Icon name="arrowLeft" size={16} />
                </button>
                <span className="muted small">
                  Page {previewPage + 1} of {pdf.pages}
                </span>
                <button type="button" className="icon-btn" aria-label="Next page" disabled={previewPage >= pdf.pages - 1} onClick={() => setPreviewPage((p) => p + 1)}>
                  <Icon name="arrowRight" size={16} />
                </button>
              </div>
              <div className="stamp-sheet">{preview ? <img src={preview} alt={`Page ${previewPage + 1} with the chosen stamps`} /> : <span className="muted small">Drawing preview…</span>}</div>
              {previewErr && <p className="error-text">{previewErr}</p>}
            </div>
          </div>

          <div className="tool-actions sticky">
            <span className="muted small">{nothing ? 'Switch on page numbers or a watermark.' : `Applies to all ${pdf.pages} page${pdf.pages === 1 ? '' : 's'}.`}</span>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={nothing || task.busy} onClick={() => void apply()}>
              <Icon name={task.busy ? 'loader' : 'download'} size={16} className={task.busy ? 'spin' : ''} />
              {task.busy ? 'Stamping…' : 'Apply & save'}
            </button>
          </div>
          {task.error && <p className="error-text">{task.error}</p>}
        </>
      )}
    </ToolShell>
  )
}
