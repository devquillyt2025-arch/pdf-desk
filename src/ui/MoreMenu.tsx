import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from './icons.tsx'

export interface MoreItem {
  key: string
  label: string
  icon: IconName
  onSelect: () => void
  /** a toggle that is currently on */
  on?: boolean
}

/**
 * The top-bar controls that do not fit on a phone live here: zoom, show-original, cloud, fonts, theme, open.
 * (On wider screens the same things sit in the bar itself and this button is hidden by CSS.)
 */
export function MoreMenu(p: { items: MoreItem[]; zoom?: { value: number; onChange: (v: number) => void } }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  const step = (d: number) => p.zoom && p.zoom.onChange(Math.min(4, Math.max(0.25, Math.round((p.zoom.value + d) * 100) / 100)))
  const row = (children: ReactNode, k: string) => (
    <li key={k} role="none">
      {children}
    </li>
  )

  return (
    <div className="more" ref={root}>
      <button type="button" className={`icon-btn tb-more ${open ? 'on' : ''}`} aria-label="More" aria-haspopup="menu" aria-expanded={open} title="More" onClick={() => setOpen((v) => !v)}>
        <Icon name="more" />
      </button>
      {open && (
        <ul className="more-menu" role="menu" aria-label="More">
          {p.zoom &&
            row(
              <div className="more-zoom" role="group" aria-label="Zoom">
                <span>Zoom</span>
                <button type="button" className="icon-btn" aria-label="Zoom out" onClick={() => step(-0.1)}>
                  <Icon name="zoomOut" />
                </button>
                <span className="zoom-label" aria-live="polite">
                  {Math.round(p.zoom.value * 100)}%
                </span>
                <button type="button" className="icon-btn" aria-label="Zoom in" onClick={() => step(0.1)}>
                  <Icon name="zoomIn" />
                </button>
              </div>,
              'zoom',
            )}
          {p.items.map((it) =>
            row(
              <button
                type="button"
                role={it.on === undefined ? 'menuitem' : 'menuitemcheckbox'}
                className={`more-item ${it.on ? 'on' : ''}`}
                aria-checked={it.on === undefined ? undefined : it.on}
                onClick={() => {
                  setOpen(false)
                  it.onSelect()
                }}
              >
                <Icon name={it.icon} size={18} />
                <span>{it.label}</span>
              </button>,
              it.key,
            ),
          )}
        </ul>
      )}
    </div>
  )
}
