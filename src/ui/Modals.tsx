import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Edit, VerifyReport } from '../engine/types.ts'
import { OVERLAY_LABEL } from '../engine/overlay.ts'
import { cropSignature, simplify, type Signature } from './draw.ts'
import { Icon, type IconName } from './icons.tsx'
import type { Pt } from '../engine/types.ts'

export function Modal(p: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; tone?: 'ok' | 'warn' | 'neutral'; icon?: IconName }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('[data-autofocus], input, button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') p.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      prev?.focus?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div ref={ref} className={`modal ${p.wide ? 'wide' : ''} tone-${p.tone ?? 'neutral'}`} role="dialog" aria-modal="true" aria-label={p.title}>
        <header>
          {p.icon && (
            <span className="modal-icon">
              <Icon name={p.icon} size={20} />
            </span>
          )}
          <h2>{p.title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={p.onClose}>
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="modal-body">{p.children}</div>
        {p.footer && <footer>{p.footer}</footer>}
      </div>
    </div>
  )
}

export function PasswordModal(p: { error: boolean; onSubmit: (pw: string) => void; onClose: () => void }) {
  const [pw, setPw] = useState('')
  return (
    <Modal
      title="This PDF is password protected"
      icon="lock"
      onClose={p.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button type="submit" form="pw-form" className="btn primary">
            Open
          </button>
        </>
      }
    >
      <form
        id="pw-form"
        onSubmit={(e) => {
          e.preventDefault()
          p.onSubmit(pw)
        }}
      >
        <label className="field">
          <span>Password</span>
          <input data-autofocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" aria-invalid={p.error} />
        </label>
        {p.error && <p className="error-text">That password didn’t work. Check it and try again.</p>}
        <p className="muted small">The saved copy is not password protected. The password never leaves your computer.</p>
      </form>
    </Modal>
  )
}

/** Draw a signature with the mouse, finger or pen. */
export function SignatureModal(p: { onUse: (s: Signature) => void; onClose: () => void }) {
  const cv = useRef<HTMLCanvasElement>(null)
  const strokes = useRef<Pt[][]>([])
  const live = useRef<Pt[] | null>(null)
  const [count, setCount] = useState(0)
  const W = 520
  const H = 200

  const paint = () => {
    const c = cv.current
    if (!c) return
    const g = c.getContext('2d')!
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    c.width = W * dpr
    c.height = H * dpr
    g.scale(dpr, dpr)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.lineWidth = 2.6
    g.strokeStyle = '#111827'
    for (const s of [...strokes.current, ...(live.current ? [live.current] : [])]) {
      if (!s.length) continue
      g.beginPath()
      g.moveTo(s[0][0], s[0][1])
      if (s.length === 1) g.lineTo(s[0][0] + 0.01, s[0][1])
      for (let i = 1; i < s.length - 1; i++) g.quadraticCurveTo(s[i][0], s[i][1], (s[i][0] + s[i + 1][0]) / 2, (s[i][1] + s[i + 1][1]) / 2)
      if (s.length > 1) g.lineTo(s[s.length - 1][0], s[s.length - 1][1])
      g.stroke()
    }
  }
  useEffect(paint, [])

  const pos = (e: React.PointerEvent): Pt => {
    const r = cv.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]
  }
  const done = () => {
    const s = strokes.current.filter((x) => x.length)
    if (!s.length) return
    p.onUse(cropSignature({ w: W, h: H, strokes: s.map((x) => simplify(x, 1)) }))
  }
  return (
    <Modal
      title="Draw your signature"
      icon="sign"
      onClose={p.onClose}
      footer={
        <>
          <button
            type="button"
            className="btn ghost"
            disabled={!count}
            onClick={() => {
              strokes.current = []
              live.current = null
              setCount(0)
              paint()
            }}
          >
            Clear
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={p.onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={!count} onClick={done}>
            Use this signature
          </button>
        </>
      }
    >
      <p className="muted small">Sign inside the box with your mouse, finger or a pen. It is saved on this device so you can reuse it, and placed as a drawing you can move and resize.</p>
      <div className="sig-pad">
        <canvas
          ref={cv}
          style={{ width: '100%', aspectRatio: `${W} / ${H}` }}
          onPointerDown={(e) => {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
            live.current = [pos(e)]
            paint()
          }}
          onPointerMove={(e) => {
            if (!live.current) return
            live.current.push(pos(e))
            paint()
          }}
          onPointerUp={() => {
            if (live.current) strokes.current.push(live.current)
            live.current = null
            setCount(strokes.current.length)
            paint()
          }}
          aria-label="Signature pad"
        />
        {!count && <span className="sig-hint">Sign here</span>}
        <span className="sig-line" aria-hidden="true" />
      </div>
    </Modal>
  )
}

/** Ask before something that can't be undone, e.g. closing a document that has unsaved edits. */
export function ConfirmModal(p: { title: string; children: ReactNode; confirmLabel: string; cancelLabel?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title={p.title}
      icon="alert"
      tone="warn"
      onClose={p.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={p.onClose} data-autofocus>
            {p.cancelLabel ?? 'Keep editing'}
          </button>
          <button type="button" className="btn primary" onClick={p.onConfirm}>
            {p.confirmLabel}
          </button>
        </>
      }
    >
      {p.children}
    </Modal>
  )
}

export interface ProofStats {
  total: number
  verified: number
}

export function ReportModal(p: {
  report: VerifyReport
  edits: Edit[]
  proof: ProofStats
  fileName: string
  size: number
  /** shown when the cloud library is set up: keep this saved PDF there too */
  keep?: { state: 'idle' | 'busy' | 'done'; signedIn: boolean; onKeep: () => void } | null
  onDownload: () => void
  onClose: () => void
}) {
  const { report } = p
  const label = new Map(p.edits.map((e) => [e.id, e]))
  const fmt = (n: number) => (n > 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`)
  const failed = report.editCount - report.passed
  const unverified = p.proof.total - p.proof.verified
  return (
    <Modal
      title={report.ok ? 'Export verified' : 'Export needs your attention'}
      tone={report.ok ? 'ok' : 'warn'}
      icon={report.ok ? 'shield' : 'alert'}
      wide
      onClose={p.onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={p.onClose}>
            Back to editing
          </button>
          {p.keep && (
            <button type="button" className="btn" disabled={p.keep.state !== 'idle'} onClick={p.keep.onKeep} title="Store this saved PDF in your cloud library">
              <Icon name={p.keep.state === 'done' ? 'cloudCheck' : p.keep.state === 'busy' ? 'loader' : 'cloudUp'} size={16} className={p.keep.state === 'busy' ? 'spin' : ''} />
              {p.keep.state === 'done' ? 'Kept in library' : p.keep.state === 'busy' ? 'Uploading…' : p.keep.signedIn ? 'Keep in library' : 'Unlock to keep in library'}
            </button>
          )}
          <button type="button" className={`btn ${report.ok ? 'primary' : ''}`} onClick={p.onDownload} data-autofocus>
            <Icon name="download" size={16} /> {report.ok ? 'Download PDF' : 'Download anyway'} <small>{fmt(p.size)}</small>
          </button>
        </>
      }
    >
      <p className="lead">
        {report.ok ? (
          report.editCount === 0 ? (
            'The file was saved and its searchable text layer was checked against what you reviewed.'
          ) : (
            <>
              We re-opened the saved file and checked it. All <strong>{report.editCount}</strong> change{report.editCount === 1 ? '' : 's'} read exactly what you typed, and nothing else on those pages changed.
            </>
          )
        ) : (
          <>
            {failed > 0 ? `${failed} of ${report.editCount} changes could not be confirmed in the saved file.` : 'Something outside your edits changed.'} Review the items below before you rely on this file.
          </>
        )}
      </p>

      {report.pages.map((pg) => (
        <section key={pg.page} className="verdict-page">
          <h3>
            Page {pg.page + 1}
            <span className={`pill ${pg.ok ? 'ok' : 'bad'}`}>
              <Icon name={pg.ok ? 'check' : 'alert'} size={13} />
              {pg.ok ? 'Verified' : 'Check'}
            </span>
          </h3>
          <ul className="verdicts">
            {pg.edits.map((v) => {
              const e = label.get(v.id)
              return (
                <li key={v.id} className={v.ok ? 'ok' : 'bad'}>
                  <Icon name={v.ok ? 'checkCircle' : 'alert'} size={16} />
                  <div>
                    <span className="kind">{e ? (e.kind === 'replace' ? (e.move && e.text === e.run!.text ? 'Moved' : 'Edited') : e.kind === 'add' ? 'Added' : e.kind === 'overlay' ? OVERLAY_LABEL[e.overlay!.type] : e.kind === 'table' ? 'Table' : 'Erased') : 'Edit'}</span>
                    {v.ok ? (
                      <span className="v-text">{e?.kind === 'erase' ? 'Area cleared — nothing left behind' : e?.kind === 'overlay' ? 'Added on top — the page underneath is unchanged' : e?.kind === 'table' ? (e.table!.deleted ? 'Table removed — nothing of it is left on the page' : <>Redrawn — every cell reads as you set it, nothing else on the page moved</>) : <>“{e?.text ?? v.expected}”</>}</span>
                    ) : (
                      <span className="v-text">
                        expected “{v.expected}”, found “{v.actual}”
                      </span>
                    )}
                    {v.warning && <span className="v-warn"><Icon name="alert" size={13} /> {v.warning}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
          {pg.notes.map((n, i) => (
            <p key={i} className="note">
              <Icon name="info" size={15} /> {n}
            </p>
          ))}
        </section>
      ))}

      {p.proof.total > 0 && (
        <div className={`proof-summary ${unverified ? 'warn' : 'ok'}`}>
          <Icon name={unverified ? 'alert' : 'shield'} size={18} />
          <p>
            {unverified === 0 ? (
              <>You checked all <strong>{p.proof.total}</strong> recognised lines against the scan.</>
            ) : (
              <>
                <strong>{unverified}</strong> of {p.proof.total} recognised lines haven’t been checked by you. Text recognition can misread characters — the searchable text of those lines is only as accurate as the OCR.
              </>
            )}
          </p>
        </div>
      )}
    </Modal>
  )
}

export function FontsModal(p: { fonts: string[]; onAdd: (f: File) => void; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <Modal
      title="Fonts for other scripts"
      icon="font"
      onClose={p.onClose}
      footer={
        <button type="button" className="btn primary" onClick={p.onClose}>
          Done
        </button>
      }
    >
      <p>
        Built-in fonts cover Latin, Greek, Cyrillic, <strong>₹</strong> and most symbols. To type in scripts such as Tamil, Malayalam, Hindi or Arabic, add a TrueType/OpenType font that has those letters (for example a Noto Sans font for that script).
      </p>
      <button type="button" className="btn" onClick={() => input.current?.click()}>
        <Icon name="upload" size={16} /> Add a font file…
      </button>
      <input
        ref={input}
        type="file"
        accept=".ttf,.otf,font/ttf,font/otf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) p.onAdd(f)
          e.target.value = ''
        }}
      />
      {p.fonts.length > 0 && (
        <ul className="font-list">
          {p.fonts.map((f) => (
            <li key={f}>
              <Icon name="check" size={15} /> {f}
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Fonts stay on your computer and are used only for glyphs the built-in fonts lack.</p>
    </Modal>
  )
}
