import { useState } from 'react'
import { formatBytes } from '../../engine/ranges.ts'
import { Icon } from '../icons.tsx'
import { uid } from '../store.ts'
import { baseName, FileDrop, PasswordPrompt, PDF, ResultCard, ToolShell, useTask, type Output, type ToolProps } from './shared.tsx'

interface Item {
  id: string
  name: string
  bytes: Uint8Array
  password?: string
  status: 'ok' | 'password' | 'error'
  pages: number
  message?: string
  wrong?: boolean
}

export function MergeTool({ engine, onOpenInEditor }: ToolProps) {
  const [items, setItems] = useState<Item[]>([])
  const [out, setOut] = useState<Output | null>(null)
  const [reading, setReading] = useState(false)
  const task = useTask()

  const probe = async (id: string, name: string, bytes: Uint8Array, password?: string): Promise<Item> => {
    try {
      const r = await engine.inspect({ bytes, password })
      if (r.status === 'ok') return { id, name, bytes, password, status: 'ok', pages: r.pages }
      if (r.status === 'password') return { id, name, bytes, status: 'password', pages: 0, wrong: !!password }
      return { id, name, bytes, status: 'error', pages: 0, message: r.message }
    } catch (e) {
      return { id, name, bytes, status: 'error', pages: 0, message: (e as Error).message }
    }
  }

  const add = async (files: File[]) => {
    setReading(true)
    setOut(null)
    try {
      const added: Item[] = []
      for (const f of files) added.push(await probe(uid('m'), f.name, new Uint8Array(await f.arrayBuffer())))
      setItems((l) => [...l, ...added])
    } finally {
      setReading(false)
    }
  }
  const unlock = async (it: Item, pw: string) => {
    const next = await probe(it.id, it.name, it.bytes, pw)
    setItems((l) => l.map((x) => (x.id === it.id ? next : x)))
  }
  const move = (i: number, d: -1 | 1) => {
    setOut(null)
    setItems((l) => {
      const j = i + d
      if (j < 0 || j >= l.length) return l
      const n = [...l]
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })
  }
  const remove = (id: string) => {
    setOut(null)
    setItems((l) => l.filter((x) => x.id !== id))
  }

  const ready = items.length >= 2 && items.every((i) => i.status === 'ok')
  const total = items.reduce((s, i) => s + i.pages, 0)

  const merge = () =>
    task.run(async () => {
      const r = await engine.merge(items.map((i) => ({ bytes: i.bytes, password: i.password })))
      setOut({ name: `${baseName(items[0].name)}-merged.pdf`, bytes: r.bytes, mime: PDF, pages: r.pages })
    })

  return (
    <ToolShell title="Merge PDFs" blurb="Add two or more PDFs, put them in order, and join them into one file." icon="copy">
      {out ? (
        <ResultCard out={out} onOpenInEditor={onOpenInEditor} onAgain={() => setOut(null)} againLabel="Back to the list" />
      ) : (
        <>
          <FileDrop accept="application/pdf,.pdf" multiple compact={items.length > 0} title={items.length ? 'Add more PDFs' : 'Drop PDFs here'} hint={items.length ? undefined : 'or'} button="Choose PDFs" what="a PDF" busy={reading} onFiles={(f) => void add(f)} />

          {items.length > 0 && (
            <ol className="rows" aria-label="Files to merge, first to last">
              {items.map((it, i) => (
                <li key={it.id} className={`row ${it.status !== 'ok' ? 'row-warn' : ''}`}>
                  <span className="row-n">{i + 1}</span>
                  <Icon name={it.status === 'password' ? 'lock' : it.status === 'error' ? 'alert' : 'file'} size={18} />
                  <div className="row-main">
                    <span className="row-name" title={it.name}>
                      {it.name}
                    </span>
                    {it.status === 'ok' && (
                      <span className="muted small">
                        {it.pages} page{it.pages === 1 ? '' : 's'} · {formatBytes(it.bytes.length)}
                      </span>
                    )}
                    {it.status === 'error' && <span className="error-text small">{it.message}</span>}
                    {it.status === 'password' && <PasswordPrompt compact name={it.name} wrong={!!it.wrong} onSubmit={(pw) => void unlock(it, pw)} />}
                  </div>
                  <div className="row-actions">
                    <button type="button" className="icon-btn" aria-label={`Move ${it.name} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="arrowUp" size={16} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Move ${it.name} down`} title="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="arrowDown" size={16} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Remove ${it.name}`} title="Remove" onClick={() => remove(it.id)}>
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <div className="tool-actions">
            <span className="muted small">
              {items.length === 0 ? 'Nothing added yet.' : items.length === 1 ? 'Add at least one more file.' : `${items.length} files · ${total} pages in total`}
            </span>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={!ready || task.busy} onClick={() => void merge()}>
              <Icon name={task.busy ? 'loader' : 'copy'} size={16} className={task.busy ? 'spin' : ''} />
              {task.busy ? 'Merging…' : 'Merge'}
            </button>
          </div>
          {task.error && <p className="error-text">{task.error}</p>}
        </>
      )}
    </ToolShell>
  )
}
