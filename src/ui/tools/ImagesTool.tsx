import { useEffect, useRef, useState } from 'react'
import type { ImagesToPdfOptions } from '../../engine/tools.ts'
import { formatBytes } from '../../engine/ranges.ts'
import { Icon } from '../icons.tsx'
import { prepareImage } from '../imageprep.ts'
import { uid } from '../store.ts'
import { FileDrop, PDF, ResultCard, ToolShell, useTask, type Output, type ToolProps } from './shared.tsx'

interface Pic {
  id: string
  name: string
  file: File
  url: string
}

const IMAGE_ACCEPT = 'image/*,.jpg,.jpeg,.png,.webp,.gif,.bmp,.tif,.tiff,.avif'

export function ImagesTool({ engine, onOpenInEditor }: ToolProps) {
  const [pics, setPics] = useState<Pic[]>([])
  const [size, setSize] = useState<ImagesToPdfOptions['size']>('fit')
  const [margin, setMargin] = useState(0)
  const [out, setOut] = useState<Output | null>(null)
  const task = useTask()
  const urls = useRef<string[]>([])

  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u)
    },
    [],
  )

  const add = (files: File[]) => {
    setOut(null)
    const added = files.map((file) => {
      const url = URL.createObjectURL(file)
      urls.current.push(url)
      return { id: uid('i'), name: file.name, file, url }
    })
    setPics((l) => [...l, ...added])
  }
  const remove = (id: string) => {
    setOut(null)
    setPics((l) => l.filter((x) => x.id !== id))
  }
  const move = (i: number, d: -1 | 1) => {
    setOut(null)
    setPics((l) => {
      const j = i + d
      if (j < 0 || j >= l.length) return l
      const n = [...l]
      ;[n[i], n[j]] = [n[j], n[i]]
      return n
    })
  }

  const make = () =>
    task.run(async () => {
      const images = []
      for (const p of pics) images.push(await prepareImage(p.file))
      const r = await engine.imagesToPdf(images, { size, margin })
      setOut({ name: pics.length === 1 ? `${pics[0].name.replace(/\.[^.]+$/, '')}.pdf` : 'images.pdf', bytes: r.bytes, mime: PDF, pages: r.pages })
    })

  return (
    <ToolShell title="Images to PDF" blurb="Add photos or scans, put them in order, and get one PDF with a page for each." icon="image">
      {out ? (
        <ResultCard out={out} onOpenInEditor={onOpenInEditor} onAgain={() => setOut(null)} againLabel="Back to the pictures" />
      ) : (
        <>
          <FileDrop accept={IMAGE_ACCEPT} multiple compact={pics.length > 0} title={pics.length ? 'Add more pictures' : 'Drop pictures here'} hint={pics.length ? undefined : 'JPG, PNG, WebP, GIF, BMP, TIFF'} button="Choose pictures" what="a picture" onFiles={add} />

          {pics.length > 0 && (
            <ol className="rows" aria-label="Pictures, first to last page">
              {pics.map((p, i) => (
                <li key={p.id} className="row">
                  <span className="row-n">{i + 1}</span>
                  <img className="row-thumb" src={p.url} alt="" />
                  <div className="row-main">
                    <span className="row-name" title={p.name}>
                      {p.name}
                    </span>
                    <span className="muted small">{formatBytes(p.file.size)}</span>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="icon-btn" aria-label={`Move ${p.name} up`} title="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <Icon name="arrowUp" size={16} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Move ${p.name} down`} title="Move down" disabled={i === pics.length - 1} onClick={() => move(i, 1)}>
                      <Icon name="arrowDown" size={16} />
                    </button>
                    <button type="button" className="icon-btn" aria-label={`Remove ${p.name}`} title="Remove" onClick={() => remove(p.id)}>
                      <Icon name="x" size={16} />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}

          <div className="options">
            <div className="field">
              <span>Page size</span>
              <div className="seg" role="radiogroup" aria-label="Page size">
                {(
                  [
                    ['fit', 'Same as picture'],
                    ['a4', 'A4'],
                    ['letter', 'Letter'],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} type="button" role="radio" aria-checked={size === id} className={size === id ? 'on' : ''} onClick={() => setSize(id)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>White border</span>
              <select value={margin} onChange={(e) => setMargin(Number(e.target.value))}>
                <option value={0}>None</option>
                <option value={14}>Small</option>
                <option value={28}>Medium</option>
                <option value={48}>Large</option>
              </select>
            </label>
          </div>

          <div className="tool-actions">
            <span className="muted small">{pics.length ? `${pics.length} picture${pics.length === 1 ? '' : 's'} → ${pics.length} page${pics.length === 1 ? '' : 's'}` : 'Nothing added yet.'}</span>
            <span className="spacer" />
            <button type="button" className="btn primary" disabled={!pics.length || task.busy} onClick={() => void make()}>
              <Icon name={task.busy ? 'loader' : 'file'} size={16} className={task.busy ? 'spin' : ''} />
              {task.busy ? 'Creating…' : 'Create PDF'}
            </button>
          </div>
          {task.error && <p className="error-text">{task.error}</p>}
        </>
      )}
    </ToolShell>
  )
}
