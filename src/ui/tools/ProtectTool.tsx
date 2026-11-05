import { useEffect, useState } from 'react'
import { Icon } from '../icons.tsx'
import { baseName, FileChip, PDF, PdfInput, ResultCard, ToolShell, usePdfInput, useTask, type Output, type ToolProps } from './shared.tsx'

export function ProtectTool({ engine, onOpenInEditor }: ToolProps) {
  const input = usePdfInput(engine)
  const { pdf } = input
  const [mode, setMode] = useState<'add' | 'remove'>('add')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [out, setOut] = useState<Output | null>(null)
  const task = useTask()

  useEffect(() => {
    setOut(null)
    setPw('')
    setPw2('')
    task.setError('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdf?.id, mode])

  const problem = mode === 'add' ? (pw.includes(',') ? 'The password can’t contain a comma.' : pw && pw2 && pw !== pw2 ? 'The two passwords don’t match.' : '') : ''
  const canAdd = !!pw && pw === pw2 && !problem

  const run = () =>
    task.run(async () => {
      if (!pdf) return
      const src = { bytes: pdf.bytes, password: pdf.password }
      if (mode === 'add') {
        const r = await engine.protect(src, pw)
        setOut({ name: `${baseName(pdf.name)}-protected.pdf`, bytes: r.bytes, mime: PDF, pages: r.pages })
      } else {
        const r = await engine.unlock(src)
        setOut({ name: `${baseName(pdf.name)}-unlocked.pdf`, bytes: r.bytes, mime: PDF, pages: r.pages })
      }
    })

  return (
    <ToolShell title="Password" blurb="Lock a PDF so it asks for a password to open — or save a copy that no longer asks." icon="lock">
      <div className="seg wide-seg" role="radiogroup" aria-label="What to do">
        <button type="button" role="radio" aria-checked={mode === 'add'} className={mode === 'add' ? 'on' : ''} onClick={() => setMode('add')}>
          <Icon name="lock" size={15} /> Add a password
        </button>
        <button type="button" role="radio" aria-checked={mode === 'remove'} className={mode === 'remove' ? 'on' : ''} onClick={() => setMode('remove')}>
          <Icon name="unlock" size={15} /> Remove a password
        </button>
      </div>

      {!pdf ? (
        <PdfInput input={input} title={mode === 'add' ? 'Drop the PDF to lock' : 'Drop the locked PDF'} />
      ) : (
        <>
          <FileChip pdf={pdf} onChange={input.clear} />
          {out ? (
            <ResultCard out={out} onOpenInEditor={onOpenInEditor} onAgain={() => setOut(null)} againLabel="Back" />
          ) : mode === 'add' ? (
            <>
              <div className="options">
                <label className="field grow">
                  <span>New password</span>
                  <input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" data-autofocus />
                </label>
                <label className="field grow">
                  <span>Type it again</span>
                  <input type={show ? 'text' : 'password'} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" aria-invalid={!!problem} />
                </label>
                <label className="check">
                  <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show
                </label>
              </div>
              {problem && <p className="error-text">{problem}</p>}
              <p className="note">
                <Icon name="shield" size={16} />
                <span>
                  The file is encrypted with AES-256 on your computer. <strong>There is no way to recover a forgotten password</strong> — keep it somewhere safe.
                </span>
              </p>
              <div className="tool-actions">
                <span className="spacer" />
                <button type="button" className="btn primary" disabled={!canAdd || task.busy} onClick={() => void run()}>
                  <Icon name={task.busy ? 'loader' : 'lock'} size={16} className={task.busy ? 'spin' : ''} />
                  {task.busy ? 'Locking…' : 'Lock PDF'}
                </button>
              </div>
            </>
          ) : (
            <>
              {pdf.encrypted ? (
                <p className="note">
                  <Icon name="info" size={16} />
                  <span>You entered the password to open this file. The copy you save will open without asking for one.</span>
                </p>
              ) : (
                <p className="note">
                  <Icon name="info" size={16} />
                  <span>This file doesn’t ask for a password to open, so a copy would be the same. To remove a password, choose a locked PDF.</span>
                </p>
              )}
              <div className="tool-actions">
                <span className="spacer" />
                <button type="button" className="btn primary" disabled={!pdf.encrypted || task.busy} onClick={() => void run()}>
                  <Icon name={task.busy ? 'loader' : 'unlock'} size={16} className={task.busy ? 'spin' : ''} />
                  {task.busy ? 'Saving…' : 'Save unlocked copy'}
                </button>
              </div>
            </>
          )}
          {task.error && <p className="error-text">{task.error}</p>}
        </>
      )}
    </ToolShell>
  )
}
