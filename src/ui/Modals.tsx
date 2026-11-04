import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Edit, VerifyReport } from '../engine/types.ts'
import { Icon } from './icons.tsx'

export function Modal(p: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode; tone?: 'ok' | 'warn' | 'neutral'; icon?: 'shield' | 'alert' | 'lock' | 'font' }) {
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
                    <span className="kind">{e ? (e.kind === 'replace' ? 'Edited' : e.kind === 'add' ? 'Added' : 'Erased') : 'Edit'}</span>
                    {v.ok ? (
                      <span className="v-text">{e?.kind === 'erase' ? 'Area cleared — nothing left behind' : <>“{e?.text ?? v.expected}”</>}</span>
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
