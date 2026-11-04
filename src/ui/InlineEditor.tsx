import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Family, FontStyle, Rect } from '../engine/types.ts'
import { Icon } from './icons.tsx'

export const CSS_FAMILY: Record<Family, string> = {
  sans: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  serif: '"Times New Roman", Times, "Liberation Serif", serif',
  mono: '"Courier New", Courier, "Liberation Mono", monospace',
}

export const rgbCss = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`
const toHex = (c: [number, number, number]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

export interface EditorResult {
  text: string
  style: FontStyle
  alsoImage: boolean
  keepPrefix: boolean
}

interface Props {
  /** css px per point */
  k: number
  /** where the text starts (pt) */
  x: number
  baseline: number
  /** width of the text being replaced (pt), 0 for new text */
  width: number
  rect: Rect | null
  initialText: string
  initialStyle: FontStyle
  /** colour of the paper around the text (css) */
  bg: string
  scan: boolean
  alsoImage: boolean
  keepPrefix: boolean
  isNew: boolean
  canDelete: boolean
  hasNeighbours: boolean
  onCommit: (r: EditorResult, move?: 'next' | 'prev') => void
  onCancel: () => void
  onDelete: () => void
}

let measureCtx: CanvasRenderingContext2D | null = null
function measureText(text: string, style: FontStyle, px: number): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')!
  measureCtx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${px}px ${CSS_FAMILY[style.family]}`
  return measureCtx.measureText(text).width
}

export function InlineEditor(p: Props) {
  const [text, setText] = useState(p.initialText)
  const [style, setStyle] = useState<FontStyle>(p.initialStyle)
  const [alsoImage, setAlsoImage] = useState(p.alsoImage)
  const [keepPrefix, setKeepPrefix] = useState(p.keepPrefix)
  const wrap = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  const bar = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // The style bar is position:fixed so it can never be clipped by the side panel or the page edge.
  const place = useCallback(() => {
    const inp = input.current
    const el = bar.current
    if (!inp || !el) return
    const r = inp.getBoundingClientRect()
    const v = inp.closest('.viewer')?.getBoundingClientRect()
    const minX = (v?.left ?? 0) + 8
    const maxX = (v?.right ?? window.innerWidth) - el.offsetWidth - 8
    const left = Math.round(Math.max(minX, Math.min(r.left, maxX)))
    let top = r.top - el.offsetHeight - 9
    if (top < (v?.top ?? 0) + 8) top = r.bottom + 9
    top = Math.round(top)
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }))
  }, [])
  useLayoutEffect(() => {
    place()
  })
  useEffect(() => {
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [place])

  const px = style.size * p.k
  const padX = 6
  const textW = useMemo(() => measureText(text || ' ', style, px), [text, style, px])
  const width = Math.max(p.width * p.k + padX * 2 + 4, textW + padX * 2 + 14, 60)
  const height = Math.round(px * 1.35 + 6)
  const left = p.x * p.k - padX
  const top = p.baseline * p.k - px * 0.98 - 3

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useEffect(() => {
    wrap.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [])

  const result = (): EditorResult => ({ text, style, alsoImage, keepPrefix })
  const commit = (move?: 'next' | 'prev') => {
    if (finished.current) return
    finished.current = true
    p.onCommit(result(), move)
  }
  const cancel = () => {
    if (finished.current) return
    finished.current = true
    p.onCancel()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    } else if (e.key === 'Tab' && p.hasNeighbours) {
      e.preventDefault()
      commit(e.shiftKey ? 'prev' : 'next')
    }
    e.stopPropagation()
  }

  const set = (patch: Partial<FontStyle>) => setStyle((s) => ({ ...s, ...patch }))
  const keepFocus = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('select,input,label')) return
    e.preventDefault()
  }

  return (
    <div
      ref={wrap}
      className="editor"
      style={{ left, top, width }}
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) commit()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        ref={input}
        className="editor-input"
        aria-label={p.isNew ? 'New text' : 'Edit text'}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        style={{
          height,
          fontFamily: CSS_FAMILY[style.family],
          fontSize: px,
          fontWeight: style.bold ? 700 : 400,
          fontStyle: style.italic ? 'italic' : 'normal',
          color: rgbCss(style.color),
          background: p.bg,
          paddingInline: padX,
        }}
      />
      <div ref={bar} className="editor-bar" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }} role="toolbar" aria-label="Text style" onMouseDown={keepFocus}>
        <select aria-label="Font family" value={style.family} onChange={(e) => set({ family: e.target.value as Family })}>
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
        </select>
        <button type="button" className={`chip ${style.bold ? 'on' : ''}`} aria-pressed={style.bold} aria-label="Bold" onClick={() => set({ bold: !style.bold })}>
          <b>B</b>
        </button>
        <button type="button" className={`chip ${style.italic ? 'on' : ''}`} aria-pressed={style.italic} aria-label="Italic" onClick={() => set({ italic: !style.italic })}>
          <i>I</i>
        </button>
        <label className="size-field">
          <input
            type="number"
            aria-label="Font size in points"
            min={4}
            max={200}
            step={0.5}
            value={style.size}
            onChange={(e) => set({ size: Math.min(200, Math.max(4, parseFloat(e.target.value) || style.size)) })}
          />
          <span>pt</span>
        </label>
        <input type="color" aria-label="Text colour" className="color-field" value={toHex(style.color)} onChange={(e) => set({ color: fromHex(e.target.value) })} />
        <span className="bar-sep" />
        {p.scan ? (
          <label className="check" title="On: the page picture is changed. Off: only the hidden searchable text is corrected and the picture is left alone (use this to fix a misread).">
            <input type="checkbox" checked={alsoImage} onChange={(e) => setAlsoImage(e.target.checked)} />
            Change the picture
          </label>
        ) : (
          !p.isNew && (
            <label className="check" title="On: words you did not touch keep their original glyphs. Off: the whole line is re-typeset as one piece.">
              <input type="checkbox" checked={keepPrefix} onChange={(e) => setKeepPrefix(e.target.checked)} />
              Keep untouched words
            </label>
          )
        )}
        <span className="bar-sep" />
        {p.canDelete && (
          <button type="button" className="chip danger" aria-label="Remove this edit" title="Remove this edit" onClick={() => (finished.current = true, p.onDelete())}>
            <Icon name="trash" size={15} />
          </button>
        )}
        <button type="button" className="chip" aria-label="Cancel (Esc)" title="Cancel (Esc)" onClick={cancel}>
          <Icon name="x" size={15} />
        </button>
        <button type="button" className="chip primary" aria-label="Apply (Enter)" title="Apply (Enter)" onClick={() => commit()}>
          <Icon name="check" size={15} />
        </button>
      </div>
    </div>
  )
}
