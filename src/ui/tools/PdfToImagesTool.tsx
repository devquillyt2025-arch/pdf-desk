import { useEffect, useRef, useState } from 'react'
import { parseRanges } from '../../engine/ranges.ts'
import { zip } from '../../engine/zip.ts'
import { Icon } from '../icons.tsx'
import { baseName, FileChip, PdfInput, ResultCard, ToolShell, usePdfInput, type Output, type ToolProps } from './shared.tsx'

const DPIS = [
  [72, 'Screen · 72 dpi'],
  [150, 'Good · 150 dpi'],
  [200, 'Sharp · 200 dpi'],
  [300, 'Print · 300 dpi'],
] as const

const MAX_PIXELS = 120_000_000 // ~ a 10 000 × 12 000 px page: more than a browser tab should be asked for

export function PdfToImagesTool({ engine }: ToolProps) {
  const input = usePdfInput(engine)
  const { pdf } = input
  const [dpi, setDpi] = useState(150)
  const [range, setRange] = useState('all')
  const [out, setOut] = useState<Output | null>(null)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const cancel = useRef(false)

  useEffect(() => () => void engine.closeDoc().catch(() => {}), [engine])
  useEffect(() => {
    setOut(null)
    setError('')
    setRange('all')
  }, [pdf?.id])

  const convert = async () => {
    if (!pdf || progress) return
    setError('')
    setOut(null)
    const sel = parseRanges(range, pdf.pages)
    if (sel.error) return setError(sel.error)
    const pages = [...new Set(sel.pages)].sort((a, b) => a - b)
    const scale = dpi / 72
    const big = pages.find((i) => pdf.sizes[i].width * scale * pdf.sizes[i].height * scale > MAX_PIXELS)
    if (big !== undefined) return setError(`Page ${big + 1} is too large to draw at ${dpi} dpi. Choose a lower resolution.`)

    cancel.current = false
    setProgress({ done: 0, total: pages.length })
    try {
      const r = await engine.open(pdf.bytes.slice(), pdf.password)
      if (r.status !== 'ok') throw new Error('Could not open the file for drawing.')
      const digits = String(pdf.pages).length
      const files: { name: string; data: Uint8Array }[] = []
      for (let k = 0; k < pages.length; k++) {
        if (cancel.current) return
        setProgress({ done: k, total: pages.length })
        const png = await engine.renderPng(pages[k], scale)
        files.push({ name: `${baseName(pdf.name)}-page-${String(pages[k] + 1).padStart(digits, '0')}.png`, data: png.png })
      }
      if (files.length === 1) setOut({ name: files[0].name, bytes: files[0].data, mime: 'image/png' })
      else setOut({ name: `${baseName(pdf.name)}-pages.zip`, bytes: zip(files), mime: 'application/zip', warnings: [] })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setProgress(null)
      void engine.closeDoc().catch(() => {})
    }
  }

  return (
    <ToolShell title="PDF to images" blurb="Draw pages as PNG pictures. Several pages come as one ZIP file." icon="images">
      {!pdf ? (
        <PdfInput input={input} />
      ) : (
        <>
          <FileChip pdf={pdf} onChange={input.clear} />
          {out ? (
            <ResultCard out={{ ...out, pages: undefined }} onAgain={() => setOut(null)} againLabel="Convert again" />
          ) : (
            <>
              <div className="options">
                <label className="field">
                  <span>Resolution</span>
                  <select value={dpi} onChange={(e) => setDpi(Number(e.target.value))} disabled={!!progress}>
                    {DPIS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field grow">
                  <span>Pages</span>
                  <input value={range} onChange={(e) => setRange(e.target.value)} placeholder="all, or e.g. 1-3, 5, 8-" disabled={!!progress} aria-invalid={!!error && !progress} />
                </label>
              </div>
              {progress && (
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
                  <div className="meter">
                    <span style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
                  </div>
                  <span className="muted small">
                    Drawing page {Math.min(progress.done + 1, progress.total)} of {progress.total}…
                  </span>
                </div>
              )}
              <div className="tool-actions">
                <span className="muted small">{pdf.pages} page{pdf.pages === 1 ? '' : 's'} in this file</span>
                <span className="spacer" />
                {progress ? (
                  <button type="button" className="btn" onClick={() => (cancel.current = true)}>
                    Cancel
                  </button>
                ) : (
                  <button type="button" className="btn primary" onClick={() => void convert()}>
                    <Icon name="images" size={16} /> Convert to PNG
                  </button>
                )}
              </div>
              {error && <p className="error-text">{error}</p>}
            </>
          )}
        </>
      )}
    </ToolShell>
  )
}
