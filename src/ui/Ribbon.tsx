import type { Overlay, Rgb } from '../engine/types.ts'
import { FILLS, HIGHLIGHT_COLORS, STROKE_COLORS, WIDTHS, isShapeTool, sameColor, styleOf } from './draw.ts'
import { Icon, type IconName } from './icons.tsx'
import type { DrawStyle, Tool } from './types.ts'

const GROUPS: { label: string; tools: { id: Tool; label: string; icon: IconName; key?: string; text?: boolean }[] }[] = [
  {
    label: 'Select and edit text',
    tools: [
      { id: 'select', label: 'Select', icon: 'pointer', key: 'V', text: true },
      { id: 'edit', label: 'Edit text', icon: 'pencil', key: 'E', text: true },
      { id: 'add', label: 'Add text', icon: 'type', key: 'T', text: true },
      { id: 'erase', label: 'Erase', icon: 'eraser', key: 'X', text: true },
    ],
  },
  {
    label: 'Mark up text',
    tools: [
      { id: 'highlight', label: 'Highlight', icon: 'highlighter', key: 'H' },
      { id: 'underline', label: 'Underline', icon: 'underline', key: 'U' },
      { id: 'strike', label: 'Strike-out', icon: 'strike', key: 'K' },
    ],
  },
  {
    label: 'Draw',
    tools: [
      { id: 'rect', label: 'Rectangle', icon: 'box', key: 'R' },
      { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'O' },
      { id: 'line', label: 'Line', icon: 'line', key: 'L' },
      { id: 'arrow', label: 'Arrow', icon: 'arrowRight', key: 'A' },
      { id: 'pen', label: 'Pen', icon: 'pen', key: 'P' },
    ],
  },
  {
    label: 'Insert',
    tools: [
      { id: 'image', label: 'Picture', icon: 'image', key: 'I' },
      { id: 'sign', label: 'Signature', icon: 'sign', key: 'G' },
      { id: 'table', label: 'Table', icon: 'table', key: 'B' },
    ],
  },
]

export const SIGN_COLORS: { name: string; rgb: Rgb }[] = [
  { name: 'Black ink', rgb: [17, 24, 39] },
  { name: 'Blue ink', rgb: [29, 53, 160] },
]

function Swatches(p: { label: string; colors: { name: string; rgb: Rgb }[]; value: Rgb | undefined; onPick: (c: Rgb) => void }) {
  return (
    <div className="swatches" role="radiogroup" aria-label={p.label}>
      {p.colors.map((c) => {
        const on = !!p.value && sameColor(p.value, c.rgb)
        return (
          <button key={c.name} type="button" role="radio" aria-checked={on} aria-label={c.name} title={c.name} className={`swatch ${on ? 'on' : ''} ${c.name === 'White' ? 'light' : ''}`} style={{ background: `rgb(${c.rgb.join(',')})` }} onClick={() => p.onPick(c.rgb)} />
        )
      })}
    </div>
  )
}

export function Ribbon(p: {
  tool: Tool
  onTool: (t: Tool) => void
  style: DrawStyle
  onStyle: (patch: Partial<DrawStyle>) => void
  /** the overlay selected with the Select tool, whose style the controls then change */
  selected: Overlay | null
  /** how many things the Select tool has picked, and a way to pick everything on the page */
  pickCount: number
  onSelectAll: () => void
  onRestyle: (patch: Partial<DrawStyle>) => void
  signInk: Rgb
  onSignInk: (c: Rgb) => void
  hasSignature: boolean
  onNewSignature: () => void
  onPickImage: () => void
  pending: string | null
  eraseRedact: boolean
  onEraseRedact: (v: boolean) => void
  findOpen: boolean
  onFind: () => void
}) {
  const sel = p.tool === 'select' && p.selected ? styleOf(p.selected) : null
  const kind: 'highlight' | 'stroke' | 'sign' | 'image' | 'none' = sel
    ? sel.kind === 'none'
      ? 'none'
      : sel.kind
    : p.tool === 'highlight'
      ? 'highlight'
      : p.tool === 'sign'
        ? 'sign'
        : p.tool === 'image'
          ? 'image'
          : isShapeTool(p.tool) || p.tool === 'pen' || p.tool === 'underline' || p.tool === 'strike'
            ? 'stroke'
            : 'none'
  const cur: DrawStyle = { ...p.style, ...(sel ?? {}) } as DrawStyle
  const set = sel ? p.onRestyle : p.onStyle
  const shapeWithFill = sel ? p.selected?.type === 'rect' || p.selected?.type === 'ellipse' : p.tool === 'rect' || p.tool === 'ellipse'

  return (
    <div className="ribbon" role="toolbar" aria-label="Tools">
      {GROUPS.map((g, gi) => (
        <div key={g.label} className="rb-group" role="radiogroup" aria-label={g.label}>
          {gi > 0 && <span className="rb-sep" aria-hidden="true" />}
          {g.tools.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={p.tool === t.id}
              className={`rb-btn ${p.tool === t.id ? 'on' : ''}`}
              title={`${t.label}${t.key ? ` (${t.key})` : ''}`}
              aria-label={t.label}
              onClick={() => (t.id === 'image' ? p.onPickImage() : t.id === 'sign' ? (p.hasSignature ? p.onTool('sign') : p.onNewSignature()) : p.onTool(t.id))}
            >
              <Icon name={t.icon} size={17} />
              {t.text && <span className="rb-lbl">{t.label}</span>}
            </button>
          ))}
        </div>
      ))}

      <span className="rb-sep" aria-hidden="true" />
      <div className="rb-style" aria-live="polite">
        {kind === 'highlight' && <Swatches label="Highlight colour" colors={HIGHLIGHT_COLORS} value={sel ? (sel.highlight as Rgb) : p.style.highlight} onPick={(c) => set({ highlight: c })} />}
        {kind === 'stroke' && (
          <>
            <Swatches label="Colour" colors={STROKE_COLORS} value={cur.color} onPick={(c) => set({ color: c })} />
            <div className="seg small-seg" role="radiogroup" aria-label="Line width">
              {WIDTHS.map((w) => (
                <button key={w} type="button" role="radio" aria-checked={Math.abs(cur.width - w) < 0.01} className={Math.abs(cur.width - w) < 0.01 ? 'on' : ''} title={`${w} pt`} onClick={() => set({ width: w })}>
                  <span className="wdot" style={{ height: Math.max(1, w), width: 16 }} />
                </button>
              ))}
            </div>
            {shapeWithFill && (
              <select aria-label="Fill" value={FILLS.some((f) => Math.abs(f.value - cur.fill) < 0.01) ? cur.fill : 0} onChange={(e) => set({ fill: Number(e.target.value) })}>
                {FILLS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
        {kind === 'sign' && (
          <>
            <Swatches label="Ink colour" colors={SIGN_COLORS} value={p.signInk} onPick={p.onSignInk} />
            <button type="button" className="btn small" onClick={p.onNewSignature}>
              <Icon name="pen" size={14} /> {p.hasSignature ? 'Draw a new one' : 'Draw signature'}
            </button>
          </>
        )}
        {kind === 'image' && (
          <button type="button" className="btn small" onClick={p.onPickImage}>
            <Icon name="image" size={14} /> {p.pending ? 'Choose another…' : 'Choose a picture…'}
          </button>
        )}
        {p.tool === 'select' && (
          <>
            <button type="button" className="btn small" onClick={p.onSelectAll} title="Select everything on this page (Ctrl+A)">
              <Icon name="pointer" size={14} /> Select all
            </button>
            <span className="muted small" aria-live="polite">
              {p.pickCount > 1
                ? `${p.pickCount} selected — drag to move them all · arrows nudge`
                : p.pickCount === 1 && !sel
                  ? '1 selected — drag to move it · arrows nudge'
                  : kind === 'none' && sel
                    ? 'Drag to move · corners resize · Del removes'
                    : p.pickCount === 0
                      ? 'Click, Shift-click, or drag a box · Ctrl+A picks all'
                      : ''}
            </span>
          </>
        )}
        {p.tool === 'table' && <span className="muted small">Click inside a table to edit it — or drag a box around one that has no lines.</span>}
        {p.tool === 'erase' && (
          <label className="check" title="Paint a black box and destroy the pixels underneath">
            <input type="checkbox" checked={p.eraseRedact} onChange={(e) => p.onEraseRedact(e.target.checked)} />
            Black box (redact)
          </label>
        )}
      </div>

      <span className="spacer" />
      <button type="button" className={`rb-btn ${p.findOpen ? 'on' : ''}`} aria-pressed={p.findOpen} title="Find and replace (Ctrl+F)" onClick={p.onFind}>
        <Icon name="search" size={17} />
        <span className="rb-lbl">Find</span>
      </button>
    </div>
  )
}
