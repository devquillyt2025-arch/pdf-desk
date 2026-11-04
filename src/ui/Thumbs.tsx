import { memo, useEffect, useRef, useState } from 'react'
import type { EngineClient } from '../engine/client.ts'
import type { Edit, PageInfo, PageSize } from '../engine/types.ts'
import { useNearViewport } from './hooks.ts'
import { Icon } from './icons.tsx'
import { isScanPage } from './store.ts'

const W = 112

const Thumb = memo(function Thumb(p: {
  engine: EngineClient
  docId: number
  index: number
  size: PageSize
  info: PageInfo | undefined
  edits: Edit[]
  current: boolean
  root: HTMLElement | null
  onGo: (i: number) => void
}) {
  const [ref, near] = useNearViewport(400, p.root)
  const cv = useRef<HTMLCanvasElement>(null)
  const h = Math.round((p.size.height / p.size.width) * W)
  useEffect(() => {
    if (!near) return
    let alive = true
    const scale = (W / p.size.width) * Math.min(2, window.devicePixelRatio || 1)
    p.engine
      .render(p.index, scale, p.edits)
      .then((r) => {
        const c = cv.current
        if (!alive || !c) return
        c.width = r.width
        c.height = r.height
        c.getContext('2d')!.putImageData(new ImageData(r.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [near, p.edits, p.docId, p.engine, p.index, p.size.width])

  return (
    <li>
      <button ref={ref} type="button" className={`thumb ${p.current ? 'current' : ''}`} onClick={() => p.onGo(p.index)} aria-label={`Go to page ${p.index + 1}`} aria-current={p.current ? 'page' : undefined}>
        <canvas ref={cv} style={{ width: W, height: h }} />
        <span className="thumb-meta">
          <span>{p.index + 1}</span>
          {isScanPage(p.info) ? <Icon name="scan" size={13} aria-label="Scanned or picture-only page" /> : null}
          {p.edits.length > 0 && <span className="dot" title={`${p.edits.length} edit(s)`} />}
        </span>
      </button>
    </li>
  )
})

export function Thumbs(p: {
  engine: EngineClient
  docId: number
  sizes: PageSize[]
  infos: Record<number, PageInfo>
  editsOf: (page: number) => Edit[]
  current: number
  onGo: (i: number) => void
}) {
  const [root, setRoot] = useState<HTMLElement | null>(null)
  return (
    <nav className="thumbs" aria-label="Pages" ref={setRoot}>
      <ul>
        {p.sizes.map((s, i) => (
          <Thumb key={i} engine={p.engine} docId={p.docId} index={i} size={s} info={p.infos[i]} edits={p.editsOf(i)} current={p.current === i} root={root} onGo={p.onGo} />
        ))}
      </ul>
    </nav>
  )
}
