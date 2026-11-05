import type { CloudDoc } from '../cloud/api.ts'
import { ago } from '../cloud/LibraryModal.tsx'
import { Icon } from './icons.tsx'
import { TOOLS, type ToolId } from './tools/meta.ts'

export interface ResumeInfo {
  fileName: string
  changes: number
}

/** The cloud library on the start page: shown once the cloud is set up on this server. */
export interface WelcomeLibrary {
  signedIn: boolean
  /** newest first; files with a draft are listed before the rest */
  recent: CloudDoc[]
  busy: boolean
  onOpen: (doc: CloudDoc, withDraft: boolean) => void
  onLibrary: () => void
}

export function Welcome(p: {
  library?: WelcomeLibrary | null
  onOpen: () => void
  onSample: (kind: 'text' | 'scan' | 'table') => void
  onTool: (id: ToolId) => void
  dragging: boolean
  loading: boolean
  resume: ResumeInfo | null
  onResume: () => void
  onCloseDoc: () => void
}) {
  return (
    <main className={`welcome ${p.dragging ? 'dragging' : ''}`}>
      <div className="welcome-card">
        <div className="logo-lg" aria-hidden="true">
          <Icon name="file" size={30} />
        </div>
        <h1>Edit any PDF — searchable or scanned</h1>
        <p className="sub">Click text to change it. For scans, recognise the text, proofread it against the picture, then edit. Everything runs on your computer; {p.library ? 'nothing is uploaded unless you choose “Save to cloud”.' : 'nothing is uploaded.'}</p>

        {p.resume && (
          <div className="resume" role="region" aria-label="Document still open">
            <Icon name="file" size={20} />
            <div className="resume-text">
              <strong title={p.resume.fileName}>{p.resume.fileName}</strong>
              <span className="muted small">
                is still open{p.resume.changes ? ` · ${p.resume.changes} unsaved change${p.resume.changes === 1 ? '' : 's'}` : ''}
              </span>
            </div>
            <button type="button" className="btn primary" onClick={p.onResume}>
              <Icon name="pencil" size={16} /> Continue editing
            </button>
            <button type="button" className="btn ghost" onClick={p.onCloseDoc}>
              Close file
            </button>
          </div>
        )}

        {p.library && (
          <section className="cl-recent" aria-label="Your cloud library">
            <header>
              <h2>
                <Icon name="cloud" size={16} /> {p.library.signedIn ? 'Pick up where you left off' : 'Your cloud library'}
              </h2>
              <button type="button" className="btn small ghost" onClick={p.library.onLibrary}>
                {p.library.signedIn ? 'Open library' : 'Unlock'}
              </button>
            </header>
            {p.library.signedIn && !p.library.recent.length && <p className="muted small">Nothing saved yet. Open a PDF and use “Save to cloud” to keep it — and your unfinished edits — here.</p>}
            {!p.library.signedIn && <p className="muted small">Enter your passcode to see your saved files and drafts.</p>}
            <ul>
              {p.library.recent.map((d) => (
                <li key={d.id}>
                  <Icon name="file" size={16} />
                  <div className="cl-main">
                    <strong title={d.name}>{d.name}</strong>
                    <span className="muted small">{d.draft ? `Draft · ${d.draft.edits} change${d.draft.edits === 1 ? '' : 's'} · ${ago(d.draft.updatedAt)}` : `Saved ${ago(d.createdAt)}`}</span>
                  </div>
                  <button type="button" className="btn small primary" disabled={p.loading || p.library!.busy} onClick={() => p.library!.onOpen(d, !!d.draft)}>
                    {d.draft ? 'Continue draft' : 'Open'}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="drop">
          <Icon name="upload" size={28} />
          <p>
            <strong>{p.resume ? 'Edit a different PDF' : 'Drop a PDF here'}</strong>
            <span>or</span>
          </p>
          <button type="button" className="btn primary large" onClick={p.onOpen} disabled={p.loading} data-autofocus>
            {p.loading ? 'Opening…' : 'Choose a PDF'}
          </button>
        </div>

        <div className="samples">
          <span className="muted small">Try it first:</span>
          <button type="button" className="btn ghost" onClick={() => p.onSample('text')} disabled={p.loading}>
            Searchable invoice
          </button>
          <button type="button" className="btn ghost" onClick={() => p.onSample('scan')} disabled={p.loading}>
            Scanned invoice
          </button>
          <button type="button" className="btn ghost" onClick={() => p.onSample('table')} disabled={p.loading}>
            Report with a table
          </button>
        </div>

        <section className="tools-section" aria-labelledby="more-tools">
          <h2 id="more-tools">More PDF tools</h2>
          <ul className="tool-grid">
            {TOOLS.map((t) => (
              <li key={t.id}>
                <button type="button" className="tcard" onClick={() => p.onTool(t.id)}>
                  <span className="tcard-ico" aria-hidden="true">
                    <Icon name={t.icon} size={20} />
                  </span>
                  <span className="tcard-text">
                    <strong>{t.title}</strong>
                    <span>{t.blurb}</span>
                  </span>
                  <Icon name="arrowRight" size={16} className="tcard-go" />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <ul className="promises">
          <li>
            <Icon name="shield" size={20} />
            <div>
              <h3>Proven, not promised</h3>
              <p>After saving, the new file is re-opened and every change is compared with what you typed. Anything else that moved is reported.</p>
            </div>
          </li>
          <li>
            <Icon name="eye" size={20} />
            <div>
              <h3>Scans you can trust</h3>
              <p>No OCR is perfect. Low-confidence words are flagged, and you check each line beside the original scan before you export.</p>
            </div>
          </li>
          <li>
            <Icon name="pencil" size={20} />
            <div>
              <h3>Only what you change, changes</h3>
              <p>Words you don’t touch keep their original glyphs. Old text is truly removed — not just covered with a white box.</p>
            </div>
          </li>
        </ul>
      </div>
    </main>
  )
}
