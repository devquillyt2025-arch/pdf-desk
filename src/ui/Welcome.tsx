import { Icon } from './icons.tsx'

export function Welcome(p: { onOpen: () => void; onSample: (kind: 'text' | 'scan') => void; dragging: boolean; loading: boolean }) {
  return (
    <main className={`welcome ${p.dragging ? 'dragging' : ''}`}>
      <div className="welcome-card">
        <div className="logo-lg" aria-hidden="true">
          <Icon name="file" size={30} />
        </div>
        <h1>Edit any PDF — searchable or scanned</h1>
        <p className="sub">Click text to change it. For scans, recognise the text, proofread it against the picture, then edit. Everything runs on your computer; nothing is uploaded.</p>

        <div className="drop">
          <Icon name="upload" size={28} />
          <p>
            <strong>Drop a PDF here</strong>
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
        </div>

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
