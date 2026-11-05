import type { CellRange } from '../engine/table.ts'
import { colCount, rowCount } from '../engine/table.ts'
import type { Rgb, TableAlign, TableBorders, TableCell, TableModel } from '../engine/types.ts'
import { Icon } from './icons.tsx'

export interface TableOps {
  insertRow: (where: 'above' | 'below') => void
  insertColumn: (where: 'left' | 'right') => void
  deleteRows: () => void
  deleteColumns: () => void
  evenColumns: () => void
  fitRows: () => void
  setBorders: (patch: Partial<TableBorders>) => void
  borderPreset: (name: 'all' | 'outside' | 'inside' | 'rows' | 'columns' | 'none') => void
  setFill: (c: Rgb | null) => void
  setText: (patch: Partial<Pick<TableCell, 'color' | 'bold' | 'italic' | 'align' | 'size'>>) => void
  stripe: (c: Rgb | null) => void
  setWrap: (on: boolean) => void
  deleteTable: () => void
  restore: () => void
}

const FILLS: (Rgb | null)[] = [null, [243, 243, 243], [219, 234, 254], [254, 243, 199], [220, 252, 231], [254, 226, 226], [31, 78, 121], [17, 24, 39]]
const TEXTS: Rgb[] = [[17, 24, 39], [255, 255, 255], [90, 90, 90], [29, 78, 216], [220, 38, 38], [22, 163, 74]]
const LINES: Rgb[] = [[17, 24, 39], [90, 90, 90], [153, 153, 153], [220, 38, 38], [37, 99, 235], [22, 163, 74]]
const WIDTHS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3]
const SIZES = [7, 8, 9, 10, 11, 12, 14, 16, 18]

const hex = (c: Rgb) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
const fromHex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const same = (a: Rgb | null, b: Rgb | null) => (a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1] && a[2] === b[2])

function Colors(p: { label: string; colors: (Rgb | null)[]; value: Rgb | null | undefined; disabled?: boolean; onPick: (c: Rgb | null) => void; custom?: boolean }) {
  return (
    <div className="tp-colors" role="radiogroup" aria-label={p.label}>
      {p.colors.map((c, i) => {
        const on = p.value !== undefined && same(p.value, c)
        return (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={p.disabled}
            aria-label={c ? hex(c) : 'No colour'}
            title={c ? hex(c) : 'No colour'}
            className={`swatch ${on ? 'on' : ''} ${c ? '' : 'none'} ${c && c[0] > 235 && c[1] > 235 && c[2] > 235 ? 'light' : ''}`}
            style={c ? { background: `rgb(${c.join(',')})` } : undefined}
            onClick={() => p.onPick(c)}
          />
        )
      })}
      {p.custom !== false && (
        <label className={`swatch custom ${p.disabled ? 'off' : ''}`} title="Any colour…">
          <input type="color" aria-label={`${p.label}: pick any colour`} disabled={p.disabled} value={p.value ? hex(p.value) : '#ffffff'} onChange={(e) => p.onPick(fromHex(e.target.value))} />
        </label>
      )}
    </div>
  )
}

export function TablePanel(p: { model: TableModel; sel: CellRange | null; deleted: boolean; ops: TableOps }) {
  const { model, sel, ops } = p
  if (p.deleted) {
    return (
      <div className="tp">
        <div className="empty">
          <Icon name="trash" size={28} />
          <h3>Table removed</h3>
          <p>Its lines, backgrounds and text are gone from the page when you save.</p>
          <button type="button" className="btn" onClick={ops.restore}>
            <Icon name="undo" size={15} /> Bring it back
          </button>
        </div>
      </div>
    )
  }
  const R = rowCount(model)
  const C = colCount(model)
  const cur = sel ? model.cells[Math.min(sel.r0, R - 1)][Math.min(sel.c0, C - 1)] : null
  const none = !sel
  const b = model.borders
  const presetOn = (o: boolean, h: boolean, v: boolean) => b.outer === o && b.innerH === h && b.innerV === v
  const where = sel ? (sel.r0 === sel.r1 && sel.c0 === sel.c1 ? `Row ${sel.r0 + 1}, column ${sel.c0 + 1}` : `Rows ${sel.r0 + 1}–${sel.r1 + 1} · columns ${sel.c0 + 1}–${sel.c1 + 1}`) : 'Nothing selected'
  const presets: { id: Parameters<TableOps['borderPreset']>[0]; label: string; on: boolean }[] = [
    { id: 'all', label: 'All', on: presetOn(true, true, true) },
    { id: 'outside', label: 'Outside', on: presetOn(true, false, false) },
    { id: 'inside', label: 'Inside', on: presetOn(false, true, true) },
    { id: 'rows', label: 'Rows', on: presetOn(false, true, false) },
    { id: 'columns', label: 'Columns', on: presetOn(false, false, true) },
    { id: 'none', label: 'None', on: presetOn(false, false, false) },
  ]

  return (
    <div className="tp">
      <p className="tp-head">
        <strong>
          {R} rows × {C} columns
        </strong>
        <span className="muted small">{where}</span>
      </p>
      {none && <p className="note"><Icon name="info" size={15} /> Click a cell on the page (drag for several, Shift-click to extend). Click a number above or beside the table to pick a whole column or row. Double-click a cell to type in it.</p>}

      <section className="tp-sec">
        <h3>Rows & columns</h3>
        <div className="tp-grid">
          <button type="button" className="btn small" disabled={none} onClick={() => ops.insertRow('above')}>
            <Icon name="rowAbove" size={15} /> Row above
          </button>
          <button type="button" className="btn small" disabled={none} onClick={() => ops.insertRow('below')}>
            <Icon name="rowBelow" size={15} /> Row below
          </button>
          <button type="button" className="btn small" disabled={none} onClick={() => ops.insertColumn('left')}>
            <Icon name="colLeft" size={15} /> Column left
          </button>
          <button type="button" className="btn small" disabled={none} onClick={() => ops.insertColumn('right')}>
            <Icon name="colRight" size={15} /> Column right
          </button>
          <button type="button" className="btn small danger" disabled={none} onClick={ops.deleteRows}>
            <Icon name="trash" size={14} /> Delete row{sel && sel.r1 > sel.r0 ? 's' : ''}
          </button>
          <button type="button" className="btn small danger" disabled={none} onClick={ops.deleteColumns}>
            <Icon name="trash" size={14} /> Delete column{sel && sel.c1 > sel.c0 ? 's' : ''}
          </button>
        </div>
        <div className="tp-grid">
          <button type="button" className="btn small" onClick={ops.evenColumns} title="Give every column the same width">
            Even columns
          </button>
          <button type="button" className="btn small" onClick={ops.fitRows} title="Make every row exactly as tall as its text needs">
            Fit rows to text
          </button>
        </div>
        <label className="check" title="Long text goes onto more lines inside its cell and the row grows to hold it. Off keeps one line per cell, as many PDFs have it.">
          <input type="checkbox" checked={model.wrap !== false} onChange={(e) => ops.setWrap(e.target.checked)} /> Wrap long text inside cells
        </label>
        <p className="muted small">Drag the edges of the table on the page to resize columns and rows, or to make the whole table bigger.</p>
      </section>

      <section className="tp-sec">
        <h3>Borders</h3>
        <div className="seg small-seg tp-presets" role="radiogroup" aria-label="Which lines to draw">
          {presets.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={x.on} className={x.on ? 'on' : ''} onClick={() => ops.borderPreset(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="tp-row">
          <span className="tp-lbl">Colour</span>
          <Colors label="Border colour" colors={LINES} value={b.color} onPick={(c) => c && ops.setBorders({ color: c })} />
        </div>
        <div className="tp-row">
          <span className="tp-lbl">Thickness</span>
          <select aria-label="Border thickness" value={WIDTHS.includes(b.width) ? b.width : ''} onChange={(e) => ops.setBorders({ width: Number(e.target.value) })}>
            {!WIDTHS.includes(b.width) && <option value="">{b.width.toFixed(2)} pt</option>}
            {WIDTHS.map((w) => (
              <option key={w} value={w}>
                {w} pt
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="tp-sec">
        <h3>Cell background</h3>
        <Colors label="Cell background" colors={FILLS} value={cur ? cur.fill : undefined} disabled={none} onPick={ops.setFill} />
        <div className="tp-row">
          <span className="tp-lbl">Alternate rows</span>
          <div className="tp-colors">
            <button type="button" className="btn small" onClick={() => ops.stripe([243, 243, 243])}>
              Grey
            </button>
            <button type="button" className="btn small" onClick={() => ops.stripe([219, 234, 254])}>
              Blue
            </button>
            <button type="button" className="btn small ghost" onClick={() => ops.stripe(null)}>
              Clear
            </button>
          </div>
        </div>
        <p className="muted small">Stripes start on the second row, so a header row keeps its colour.</p>
      </section>

      <section className="tp-sec">
        <h3>Text</h3>
        <Colors label="Text colour" colors={TEXTS} value={cur?.color} disabled={none} onPick={(c) => c && ops.setText({ color: c })} />
        <div className="tp-row">
          <button type="button" className={`icon-btn ${cur?.bold ? 'on' : ''}`} disabled={none} aria-pressed={!!cur?.bold} aria-label="Bold" title="Bold" onClick={() => ops.setText({ bold: !cur?.bold })}>
            <Icon name="bold" size={16} />
          </button>
          <button type="button" className={`icon-btn ${cur?.italic ? 'on' : ''}`} disabled={none} aria-pressed={!!cur?.italic} aria-label="Italic" title="Italic" onClick={() => ops.setText({ italic: !cur?.italic })}>
            <Icon name="italic" size={16} />
          </button>
          <span className="rb-sep" aria-hidden="true" />
          {(['left', 'center', 'right'] as TableAlign[]).map((a) => (
            <button key={a} type="button" className={`icon-btn ${cur?.align === a ? 'on' : ''}`} disabled={none} aria-pressed={cur?.align === a} aria-label={`Align ${a}`} title={`Align ${a}`} onClick={() => ops.setText({ align: a })}>
              <Icon name={a === 'left' ? 'alignLeft' : a === 'center' ? 'alignCenter' : 'alignRight'} size={16} />
            </button>
          ))}
          <select aria-label="Text size" disabled={none} value={cur && SIZES.includes(Math.round(cur.size)) ? Math.round(cur.size) : ''} onChange={(e) => ops.setText({ size: Number(e.target.value) })}>
            {(!cur || !SIZES.includes(Math.round(cur.size))) && <option value="">{cur ? cur.size : '—'}</option>}
            {SIZES.map((s) => (
              <option key={s} value={s}>
                {s} pt
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="tp-sec">
        <button type="button" className="btn danger" onClick={ops.deleteTable}>
          <Icon name="trash" size={15} /> Delete the whole table
        </button>
        <p className="muted small">When you save, the table is redrawn from what you see here, so its text is set in a matching built-in font. Everything else on the page is left exactly as it was.</p>
      </section>
    </div>
  )
}
