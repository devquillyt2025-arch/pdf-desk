import type { RefObject } from 'react'
import type { FindOptions, Match } from '../engine/find.ts'
import { Icon } from './icons.tsx'

export function FindPanel(p: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  onQuery: (v: string) => void
  replacement: string
  onReplacement: (v: string) => void
  opts: FindOptions
  onOpts: (o: FindOptions) => void
  matches: Match[]
  current: number
  onCurrent: (i: number) => void
  loading: { done: number; total: number } | null
  unreadablePages: number
  onReplaceOne: () => void
  onReplaceAll: () => void
}) {
  const n = p.matches.length
  const has = n > 0
  const step = (d: 1 | -1) => has && p.onCurrent((p.current + d + n) % n)
  const shown = p.matches.slice(0, 300)
  return (
    <div className="find">
      <form className="find-form" onSubmit={(e) => e.preventDefault()}>
        <label className="field">
          <span>Find</span>
          <div className="find-input">
            <input
              ref={p.inputRef}
              type="search"
              value={p.query}
              onChange={(e) => p.onQuery(e.target.value)}
              placeholder="Text to find"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  step(e.shiftKey ? -1 : 1)
                }
              }}
            />
            <span className="find-count" aria-live="polite">
              {p.query ? (has ? `${p.current + 1} of ${n}` : 'No matches') : ''}
            </span>
            <button type="button" className="icon-btn sm" aria-label="Previous match" title="Previous (Shift+Enter)" disabled={!has} onClick={() => step(-1)}>
              <Icon name="chevronUp" size={16} />
            </button>
            <button type="button" className="icon-btn sm" aria-label="Next match" title="Next (Enter)" disabled={!has} onClick={() => step(1)}>
              <Icon name="chevronDown" size={16} />
            </button>
          </div>
        </label>

        <label className="field">
          <span>Replace with</span>
          <input value={p.replacement} onChange={(e) => p.onReplacement(e.target.value)} placeholder="New text" autoComplete="off" spellCheck={false} />
        </label>

        <div className="find-opts">
          <label className="check">
            <input type="checkbox" checked={p.opts.matchCase} onChange={(e) => p.onOpts({ ...p.opts, matchCase: e.target.checked })} /> Match case
          </label>
          <label className="check">
            <input type="checkbox" checked={p.opts.wholeWord} onChange={(e) => p.onOpts({ ...p.opts, wholeWord: e.target.checked })} /> Whole word
          </label>
        </div>

        <div className="find-actions">
          <button type="button" className="btn small" disabled={!has} onClick={p.onReplaceOne}>
            <Icon name="replace" size={14} /> Replace
          </button>
          <button type="button" className="btn small primary" disabled={!has} onClick={p.onReplaceAll}>
            Replace all{has ? ` (${n})` : ''}
          </button>
        </div>
      </form>

      {p.loading && (
        <p className="note">
          <Icon name="loader" size={15} className="spin" /> Reading the text of page {Math.min(p.loading.done + 1, p.loading.total)} of {p.loading.total}…
        </p>
      )}
      {p.unreadablePages > 0 && !p.loading && (
        <p className="note">
          <Icon name="scan" size={15} /> {p.unreadablePages} page{p.unreadablePages === 1 ? ' is a scan' : 's are scans'} with no recognised text, so {p.unreadablePages === 1 ? 'it' : 'they'} can’t be searched yet. Recognise {p.unreadablePages === 1 ? 'it' : 'them'} in the Proofread tab.
        </p>
      )}

      {has && (
        <ul className="find-list" aria-label="Matches">
          {shown.map((m, i) => (
            <li key={`${m.run.id}:${m.nth}`}>
              <button type="button" className={`find-item ${i === p.current ? 'cur' : ''}`} onClick={() => p.onCurrent(i)}>
                <span className="muted small">Page {m.run.page + 1}</span>
                <span className="find-ctx">
                  {m.before.length >= 18 ? '…' : ''}
                  {m.before}
                  <mark>{m.hit}</mark>
                  {m.after}
                </span>
              </button>
            </li>
          ))}
          {n > shown.length && <li className="muted small find-more">…and {n - shown.length} more</li>}
        </ul>
      )}
      {!has && p.query && !p.loading && <p className="muted small">Matches are found within a line of same-styled text. A phrase split across two styles (say, bold then regular) is found as two separate words.</p>}
      <p className="muted small find-foot">Replaced text goes through the same check as any other edit when you save.</p>
    </div>
  )
}
