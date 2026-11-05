import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { EngineClient } from '../../engine/client.ts'
import { formatBytes } from '../../engine/ranges.ts'
import type { PageSize } from '../../engine/types.ts'
import { Icon, type IconName } from '../icons.tsx'

export interface ToolProps {
  engine: EngineClient
  onOpenInEditor: (bytes: Uint8Array, name: string) => void
}

export interface Output {
  name: string
  bytes: Uint8Array
  mime: string
  pages?: number
  warnings?: string[]
}

export const baseName = (n: string) => n.replace(/\.[^.]+$/, '') || 'document'
export const PDF = 'application/pdf'

export function downloadBytes(bytes: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Run an async job with a busy flag and a readable error. */
export function useTask() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError('')
    try {
      return await fn()
    } catch (e) {
      setError((e as Error).message || String(e))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, setError, run }
}

export function ToolShell(p: { title: string; blurb: string; icon: IconName; wide?: boolean; children: ReactNode }) {
  return (
    <main className="tool">
      <div className={`tool-card ${p.wide ? 'wide' : ''}`}>
        <header className="tool-head">
          <span className="tool-ico" aria-hidden="true">
            <Icon name={p.icon} size={22} />
          </span>
          <div>
            <h1>{p.title}</h1>
            <p>{p.blurb}</p>
          </div>
        </header>
        {p.children}
      </div>
    </main>
  )
}

const accepted = (f: File, accept: string) =>
  accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((a) => (a.startsWith('.') ? f.name.toLowerCase().endsWith(a) : a.endsWith('/*') ? f.type.startsWith(a.slice(0, -1)) : f.type === a))

export function FileDrop(p: { accept: string; multiple?: boolean; onFiles: (files: File[]) => void; title: string; hint?: string; button?: string; compact?: boolean; busy?: boolean; what?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [err, setErr] = useState('')
  const take = (list: FileList | null) => {
    const all = [...(list ?? [])]
    const good = all.filter((f) => accepted(f, p.accept))
    setErr(all.length && !good.length ? `That doesn’t look like ${p.what ?? 'a supported file'}.` : '')
    if (good.length) p.onFiles(p.multiple ? good : good.slice(0, 1))
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  return (
    <div
      className={`filedrop ${over ? 'over' : ''} ${p.compact ? 'compact' : ''}`}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        take(e.dataTransfer.files)
      }}
    >
      <Icon name="upload" size={p.compact ? 20 : 28} />
      <p>
        <strong>{p.title}</strong>
        {p.hint && <span>{p.hint}</span>}
      </p>
      <button type="button" className={`btn ${p.compact ? '' : 'primary'}`} disabled={p.busy} onClick={() => input.current?.click()} data-autofocus>
        {p.busy ? <Icon name="loader" size={16} className="spin" /> : null}
        {p.busy ? 'Reading…' : (p.button ?? 'Choose file')}
      </button>
      {err && <p className="error-text">{err}</p>}
      <input
        ref={input}
        type="file"
        hidden
        accept={p.accept}
        multiple={p.multiple}
        onChange={(e) => {
          take(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export function PasswordPrompt(p: { name: string; wrong: boolean; onSubmit: (pw: string) => void; onCancel?: () => void; compact?: boolean }) {
  const [pw, setPw] = useState('')
  return (
    <form
      className={`pw-prompt ${p.compact ? 'compact' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        p.onSubmit(pw)
      }}
    >
      <Icon name="lock" size={18} />
      <label className="field">
        <span>
          <strong>{p.name}</strong> is password protected
        </span>
        <input data-autofocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" aria-invalid={p.wrong} placeholder="Password" />
      </label>
      <button type="submit" className="btn primary" disabled={!pw}>
        Unlock
      </button>
      {p.onCancel && (
        <button type="button" className="btn ghost" onClick={p.onCancel}>
          Cancel
        </button>
      )}
      {p.wrong && <p className="error-text">That password didn’t work. Check it and try again.</p>}
    </form>
  )
}

let pdfSeq = 0

export interface LoadedPdf {
  /** changes every time a file is loaded, so tools can reset when the file changes */
  id: number
  name: string
  bytes: Uint8Array
  password?: string
  pages: number
  sizes: PageSize[]
  encrypted: boolean
}

/** Choose one PDF; ask for its password if it needs one. */
export function usePdfInput(engine: EngineClient) {
  const [pdf, setPdf] = useState<LoadedPdf | null>(null)
  const [pending, setPending] = useState<{ name: string; bytes: Uint8Array; wrong: boolean } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const attempt = useCallback(
    async (name: string, bytes: Uint8Array, password?: string) => {
      setBusy(true)
      setError('')
      try {
        const r = await engine.inspect({ bytes, password })
        if (r.status === 'ok') {
          setPdf({ id: ++pdfSeq, name, bytes, password, pages: r.pages, sizes: r.sizes, encrypted: r.encrypted })
          setPending(null)
        } else if (r.status === 'password') setPending({ name, bytes, wrong: !!password })
        else setError(r.message)
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setBusy(false)
      }
    },
    [engine],
  )
  const pick = useCallback(async (files: File[]) => attempt(files[0].name, new Uint8Array(await files[0].arrayBuffer())), [attempt])
  const unlock = useCallback((pw: string) => (pending ? attempt(pending.name, pending.bytes, pw) : undefined), [attempt, pending])
  const clear = useCallback(() => {
    setPdf(null)
    setPending(null)
    setError('')
  }, [])
  return { pdf, pending, error, busy, pick, unlock, clear }
}

export type PdfInputState = ReturnType<typeof usePdfInput>

/** What to show until a PDF has been chosen (and unlocked). */
export function PdfInput(p: { input: PdfInputState; title?: string }) {
  const { input } = p
  if (input.pending) return <PasswordPrompt name={input.pending.name} wrong={input.pending.wrong} onSubmit={(pw) => void input.unlock(pw)} onCancel={input.clear} />
  return (
    <>
      <FileDrop accept="application/pdf,.pdf" title={p.title ?? 'Drop a PDF here'} hint="or" button="Choose a PDF" what="a PDF" busy={input.busy} onFiles={(f) => void input.pick(f)} />
      {input.error && <p className="error-text">{input.error}</p>}
    </>
  )
}

/** The file being worked on, with a way to swap it. */
export function FileChip(p: { pdf: LoadedPdf; onChange: () => void }) {
  return (
    <div className="file-chip">
      <Icon name="file" size={18} />
      <span className="file-chip-name" title={p.pdf.name}>
        {p.pdf.name}
      </span>
      <span className="muted small">
        {p.pdf.pages} page{p.pdf.pages === 1 ? '' : 's'} · {formatBytes(p.pdf.bytes.length)}
        {p.pdf.encrypted ? ' · unlocked' : ''}
      </span>
      <button type="button" className="btn small ghost" onClick={p.onChange}>
        Change file
      </button>
    </div>
  )
}

export function ResultCard(p: { out: Output; onOpenInEditor?: (bytes: Uint8Array, name: string) => void; onAgain: () => void; againLabel?: string }) {
  const { out } = p
  return (
    <section className="result" role="status">
      <span className="result-ico" aria-hidden="true">
        <Icon name="checkCircle" size={24} />
      </span>
      <div className="result-main">
        <h2>Your file is ready</h2>
        <p>
          <strong>{out.name}</strong>
          <span className="muted">
            {' '}
            · {out.pages != null ? `${out.pages} page${out.pages === 1 ? '' : 's'} · ` : ''}
            {formatBytes(out.bytes.length)}
          </span>
        </p>
        {out.warnings?.map((w) => (
          <p key={w} className="warn-text small">
            {w}
          </p>
        ))}
      </div>
      <div className="result-actions">
        <button type="button" className="btn primary" onClick={() => downloadBytes(out.bytes, out.name, out.mime)}>
          <Icon name="download" size={16} /> Download
        </button>
        {out.mime === PDF && p.onOpenInEditor && (
          <button type="button" className="btn" onClick={() => p.onOpenInEditor!(out.bytes, out.name)} title="Open this file in the PDF editor">
            <Icon name="pencil" size={16} /> Edit this file
          </button>
        )}
        <button type="button" className="btn ghost" onClick={p.onAgain}>
          {p.againLabel ?? 'Start over'}
        </button>
      </div>
    </section>
  )
}
