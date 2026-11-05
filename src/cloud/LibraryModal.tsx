import { useState, type ReactNode } from 'react'
import { formatBytes } from '../engine/ranges.ts'
import { Icon } from '../ui/icons.tsx'
import { Modal } from '../ui/Modals.tsx'
import type { CloudDoc, HistoryRow } from './api.ts'
import type { Cloud } from './useCloud.ts'

/** "just now", "5 min ago", "3 h ago", "12 Nov" */
export function ago(iso: string | Date, now = Date.now()): string {
  const t = typeof iso === 'string' ? new Date(iso) : iso
  const s = Math.max(0, (now - t.getTime()) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return t.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const KIND_WORDS: Record<string, string> = { replace: 'edited', add: 'added', erase: 'erased', overlay: 'marks', table: 'tables', corrections: 'proofread' }
const summaryText = (h: HistoryRow) =>
  Object.entries(h.summary)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${KIND_WORDS[k] ?? k}`)
    .join(' · ') || `${h.editCount} change${h.editCount === 1 ? '' : 's'}`

function Locked(p: { cloud: Cloud }) {
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="cl-lock"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setErr('')
        try {
          await p.cloud.unlock(code)
        } catch (x) {
          setErr((x as Error).message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <p className="lead">
        <Icon name="lock" size={18} /> Enter your passcode to open your cloud library.
      </p>
      <label className="field">
        <span>Passcode</span>
        <input data-autofocus type="password" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="current-password" aria-invalid={!!err} />
      </label>
      {err && <p className="error-text">{err}</p>}
      <button type="submit" className="btn primary" disabled={!code || busy}>
        {busy ? 'Checking…' : 'Unlock'}
      </button>
      <p className="muted small">This device is remembered for 30 days. Your documents, drafts, settings and save history are stored in your own database; only this passcode opens it.</p>
    </form>
  )
}

/** A button that asks "are you sure?" in place before it does something that cannot be undone. */
function Ask(p: { label: string; confirm: string; onDo: () => void; disabled?: boolean; children: ReactNode; className?: string }) {
  const [asked, setAsked] = useState(false)
  return asked ? (
    <span className="cl-confirm">
      <button type="button" className="btn small danger" onClick={() => (setAsked(false), p.onDo())}>
        {p.confirm}
      </button>
      <button type="button" className="btn small ghost" onClick={() => setAsked(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button type="button" className={p.className ?? 'btn small ghost'} disabled={p.disabled} onClick={() => setAsked(true)} aria-label={p.label}>
      {p.children}
    </button>
  )
}

const Danger = (p: { label: string; confirm: string; onDo: () => void; disabled?: boolean }) => (
  <Ask {...p}>
    <Icon name="trash" size={14} />
  </Ask>
)

export function LibraryModal(p: {
  cloud: Cloud
  /** the library file that is open in the editor right now */
  openId: string | null
  busy: string | null
  onOpen: (doc: CloudDoc, withDraft: boolean) => void
  onDownload: (doc: CloudDoc) => void
  onDelete: (doc: CloudDoc) => Promise<void>
  onClose: () => void
}) {
  const { cloud } = p
  const [tab, setTab] = useState<'library' | 'saves'>('library')
  const docs = cloud.documents.filter((d) => d.kind !== 'asset')
  const originals = docs.filter((d) => d.kind === 'original')
  const kids = (id: string) => docs.filter((d) => d.kind === 'saved' && d.parentId === id)
  const orphans = docs.filter((d) => d.kind === 'saved' && !originals.some((o) => o.id === d.parentId))
  const CAP = 400 * 1024 * 1024

  return (
    <Modal
      title="Cloud library"
      icon="cloud"
      wide
      onClose={p.onClose}
      footer={
        cloud.status === 'ready' ? (
          <>
            <button type="button" className="btn ghost" onClick={cloud.lock} title="Forget the passcode on this device">
              <Icon name="logout" size={15} /> Lock this device
            </button>
            <span className="spacer" />
            <button type="button" className="btn primary" onClick={p.onClose}>
              Done
            </button>
          </>
        ) : undefined
      }
    >
      {cloud.status === 'off' && (
        <div className="empty">
          <Icon name="cloud" size={28} />
          <h3>The cloud isn’t set up on this server</h3>
          <p className="muted small">{cloud.reason === 'no server' || cloud.reason === 'offline' ? 'There is no server to talk to (or you are offline). Everything else works as usual.' : `It needs a database and a passcode (${cloud.reason}).`}</p>
        </div>
      )}
      {cloud.status === 'checking' && <p className="muted">Checking…</p>}
      {cloud.status === 'locked' && <Locked cloud={cloud} />}

      {cloud.status === 'ready' && (
        <>
          <div className="seg cl-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>
              <Icon name="file" size={15} /> Files <span className="count">{originals.length + orphans.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === 'saves'} className={tab === 'saves' ? 'on' : ''} onClick={() => setTab('saves')}>
              <Icon name="clock" size={15} /> Recent saves <span className="count">{cloud.history.length}</span>
            </button>
          </div>

          {p.busy && (
            <p className="note">
              <Icon name="loader" size={15} className="spin" /> {p.busy}
            </p>
          )}

          {tab === 'library' && (
            <>
              <div className="cl-usage" title={`${formatBytes(cloud.usedBytes)} of ${formatBytes(CAP)}`}>
                <div className="meter">
                  <span style={{ width: `${Math.min(100, (cloud.usedBytes / CAP) * 100)}%` }} />
                </div>
                <span className="muted small">
                  {formatBytes(cloud.usedBytes)} stored · {formatBytes(Math.max(0, CAP - cloud.usedBytes))} free
                </span>
              </div>
              {!docs.length && !cloud.loading && (
                <div className="empty">
                  <Icon name="cloudUp" size={28} />
                  <h3>Nothing here yet</h3>
                  <p>Open a PDF and press <strong>Save to cloud</strong> in the tool bar. Your edits are then kept as a draft you can carry on from any device.</p>
                </div>
              )}
              <ul className="cl-list">
                {[...originals, ...orphans].map((d) => (
                  <li key={d.id} className={`cl-item ${p.openId === d.id ? 'open' : ''}`}>
                    <div className="cl-row">
                      <Icon name="file" size={18} />
                      <div className="cl-main">
                        <strong title={d.name}>{d.name}</strong>
                        <span className="muted small">
                          {formatBytes(d.size)}
                          {d.pages ? ` · ${d.pages} page${d.pages === 1 ? '' : 's'}` : ''} · {ago(d.createdAt)}
                          {d.kind === 'saved' ? ' · saved version' : ''}
                        </span>
                        {d.draft && (
                          <span className="badge warn" title="Unsaved edits are kept for this file">
                            Draft · {d.draft.edits} change{d.draft.edits === 1 ? '' : 's'} · {ago(d.draft.updatedAt)}
                          </span>
                        )}
                      </div>
                      <div className="cl-actions">
                        {d.draft && (
                          <button type="button" className="btn small primary" disabled={!!p.busy} onClick={() => p.onOpen(d, true)}>
                            Continue draft
                          </button>
                        )}
                        {d.draft ? (
                          <Ask label={`Start over: discard the draft of ${d.name} and open it fresh`} confirm="Discard draft & open" disabled={!!p.busy} onDo={() => p.onOpen(d, false)} className="btn small">
                            Start over
                          </Ask>
                        ) : (
                          <button type="button" className="btn small primary" disabled={!!p.busy} onClick={() => p.onOpen(d, false)}>
                            Open
                          </button>
                        )}
                        <button type="button" className="icon-btn" aria-label={`Download ${d.name}`} title="Download" disabled={!!p.busy} onClick={() => p.onDownload(d)}>
                          <Icon name="download" size={16} />
                        </button>
                        <Danger label={`Delete ${d.name}`} confirm="Delete for good" disabled={!!p.busy} onDo={() => void p.onDelete(d)} />
                      </div>
                    </div>
                    {kids(d.id).map((k) => (
                      <div key={k.id} className="cl-row cl-kid">
                        <Icon name="checkCircle" size={16} />
                        <div className="cl-main">
                          <strong title={k.name}>{k.name}</strong>
                          <span className="muted small">
                            saved version · {formatBytes(k.size)} · {ago(k.createdAt)}
                          </span>
                        </div>
                        <div className="cl-actions">
                          <button type="button" className="btn small" disabled={!!p.busy} onClick={() => p.onOpen(k, false)}>
                            Open
                          </button>
                          <button type="button" className="icon-btn" aria-label={`Download ${k.name}`} title="Download" disabled={!!p.busy} onClick={() => p.onDownload(k)}>
                            <Icon name="download" size={16} />
                          </button>
                          <Danger label={`Delete ${k.name}`} confirm="Delete for good" disabled={!!p.busy} onDo={() => void p.onDelete(k)} />
                        </div>
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}

          {tab === 'saves' && (
            <>
              {!cloud.history.length && (
                <div className="empty">
                  <Icon name="clock" size={28} />
                  <h3>No saves yet</h3>
                  <p>Every time you press <strong>Save &amp; verify</strong>, what was changed and whether the check passed is written here. The PDF itself is not kept unless you choose to.</p>
                </div>
              )}
              <ul className="cl-list">
                {cloud.history.map((h) => (
                  <li key={h.id} className="cl-item">
                    <div className="cl-row">
                      <Icon name={h.verified ? 'shield' : 'alert'} size={18} className={h.verified ? 'ok-ic' : 'warn-ic'} />
                      <div className="cl-main">
                        <strong title={h.fileName}>{h.fileName}</strong>
                        <span className="muted small">
                          {summaryText(h)}
                          {h.pages ? ` · ${h.pages} page${h.pages === 1 ? '' : 's'}` : ''}
                          {h.size ? ` · ${formatBytes(h.size)}` : ''} · {ago(h.savedAt)}
                        </span>
                      </div>
                      <span className={`badge ${h.verified ? 'ok' : 'warn'}`}>{h.verified ? 'Verified' : 'Needed attention'}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Modal>
  )
}
