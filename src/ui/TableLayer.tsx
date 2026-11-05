import { useEffect, useRef, useState } from 'react'
import { cellRect, colCount, normRange, rowCount, tableBounds, type CellRange } from '../engine/table.ts'
import { Icon } from './icons.tsx'
import type { TableApi, TableView } from './types.ts'

/**
 * The editing grid drawn over the page for the table being edited: click or drag to select cells, grips above and
 * left select whole columns and rows, the edges can be dragged to resize, double-click (or Enter) types into a cell.
 * Positions are in page points × `k`.
 */
export function TableLayer(p: { view: TableView; k: number; api: TableApi }) {
  const { model, sel, editing } = p.view
  const { k, api } = p
  const [x0, y0, x1, y1] = tableBounds(model)
  const R = rowCount(model)
  const C = colCount(model)
  const grid = useRef<HTMLDivElement>(null)
  const anchor = useRef<[number, number] | null>(null)
  const [ghost, setGhost] = useState<{ axis: 'x' | 'y'; pos: number } | null>(null)
  const lift = useRef<[number, number] | null>(null)
  const [carry, setCarry] = useState<{ dx: number; dy: number } | null>(null)
  // the move handle sits above the table's top edge, at the pointer (it holds still while you reach for it)
  const [handleX, setHandleX] = useState<number | null>(null)
  const px = (v: number) => v * k

  // which cell is under a pointer (clamped into the table while dragging past its edge)
  const cellAt = (e: React.PointerEvent): [number, number] => {
    const b = grid.current!.getBoundingClientRect()
    const x = x0 + (e.clientX - b.left) / k
    const y = y0 + (e.clientY - b.top) / k
    let c = C - 1
    for (let i = 0; i < C; i++) if (x < model.xs[i + 1]) { c = i; break }
    let r = R - 1
    for (let i = 0; i < R; i++) if (y < model.ys[i + 1]) { r = i; break }
    return [r, c]
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const cell = cellAt(e)
    if (e.shiftKey && sel) anchor.current = [sel.r0, sel.c0]
    else anchor.current = cell
    api.onSelect(normRange(anchor.current, cell))
  }
  const onMove = (e: React.PointerEvent) => {
    if (!anchor.current) return
    api.onSelect(normRange(anchor.current, cellAt(e)))
  }
  // The move handle follows the pointer over the table — its cells and its edge strips, which lie on top of them — but
  // not while something is being dragged, and not over the grips and the handle itself (so you can reach it).
  const trackHandle = (e: React.PointerEvent) => {
    if (anchor.current || drag.current || lift.current || !(e.target as HTMLElement).closest('.tbl-grid, .tbl-edge')) return
    const x = x0 + (e.clientX - grid.current!.getBoundingClientRect().left) / k
    setHandleX((prev) => (prev !== null && Math.abs(prev - x) < 4 ? prev : x))
  }
  const onUp = () => {
    anchor.current = null
  }

  const selectColumn = (c: number, extend: boolean) => api.onSelect(extend && sel ? { r0: 0, r1: R - 1, c0: Math.min(sel.c0, c), c1: Math.max(sel.c1, c) } : { r0: 0, r1: R - 1, c0: c, c1: c })
  const selectRow = (r: number, extend: boolean) => api.onSelect(extend && sel ? { r0: Math.min(sel.r0, r), r1: Math.max(sel.r1, r), c0: 0, c1: C - 1 } : { r0: r, r1: r, c0: 0, c1: C - 1 })

  // dragging an edge
  const drag = useRef<{ axis: 'x' | 'y'; i: number } | null>(null)
  const edgeDown = (e: React.PointerEvent, axis: 'x' | 'y', i: number) => {
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { axis, i }
    setGhost({ axis, pos: axis === 'x' ? model.xs[i] : model.ys[i] })
  }
  const edgeMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const b = grid.current!.getBoundingClientRect()
    setGhost({ axis: d.axis, pos: d.axis === 'x' ? x0 + (e.clientX - b.left) / k : y0 + (e.clientY - b.top) / k })
  }
  const edgeUp = () => {
    const d = drag.current
    drag.current = null
    if (d && ghost) api.onBoundary(d.axis, d.i, ghost.pos)
    setGhost(null)
  }

  const range: CellRange | null = sel && sel.r1 < R && sel.c1 < C ? sel : null
  const selRect = range ? ([model.xs[range.c0], model.ys[range.r0], model.xs[range.c1 + 1], model.ys[range.r1 + 1]] as const) : null

  return (
    <div className="tbl-root" onPointerMove={trackHandle}>
      <div
        ref={grid}
        className="tbl-grid"
        style={{ left: px(x0), top: px(y0), width: px(x1 - x0), height: px(y1 - y0) }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (range) api.onEdit([range.r0, range.c0])
        }}
        role="grid"
        aria-label="Table cells"
      >
        {model.ys.map((y, i) => (
          <span key={`h${i}`} className="tbl-line h" style={{ top: px(y - y0), left: 0, width: '100%' }} />
        ))}
        {model.xs.map((x, i) => (
          <span key={`v${i}`} className="tbl-line v" style={{ left: px(x - x0), top: 0, height: '100%' }} />
        ))}
        {selRect && <span className="tbl-sel" style={{ left: px(selRect[0] - x0), top: px(selRect[1] - y0), width: px(selRect[2] - selRect[0]), height: px(selRect[3] - selRect[1]) }} />}
      </div>

      {/* grips: whole columns above, whole rows on the left */}
      {model.xs.slice(0, C).map((x, c) => (
        <button key={`cg${c}`} type="button" onPointerDown={(e) => e.stopPropagation()} className={`tbl-grip c ${range && c >= range.c0 && c <= range.c1 && range.r0 === 0 && range.r1 === R - 1 ? 'on' : ''}`} style={{ left: px(x), top: px(y0) - 15, width: px(model.xs[c + 1] - x) }} aria-label={`Select column ${c + 1}`} onClick={(e) => selectColumn(c, e.shiftKey)}>
          {c + 1}
        </button>
      ))}
      {model.ys.slice(0, R).map((y, r) => (
        <button key={`rg${r}`} type="button" onPointerDown={(e) => e.stopPropagation()} className={`tbl-grip r ${range && r >= range.r0 && r <= range.r1 && range.c0 === 0 && range.c1 === C - 1 ? 'on' : ''}`} style={{ top: px(y), left: px(x0) - 17, height: px(model.ys[r + 1] - y) }} aria-label={`Select row ${r + 1}`} onClick={(e) => selectRow(r, e.shiftKey)}>
          {r + 1}
        </button>
      ))}
      <button type="button" onPointerDown={(e) => e.stopPropagation()} className="tbl-grip corner" style={{ left: px(x0) - 17, top: px(y0) - 15 }} aria-label="Select the whole table" onClick={() => api.onSelect({ r0: 0, r1: R - 1, c0: 0, c1: C - 1 })} />

      {/* the move handle: drag it to put the whole table somewhere else */}
      <button
        type="button"
        className="tbl-move"
        style={{ left: px(Math.min(Math.max(handleX ?? x0, x0), x1)) - 14, top: px(y0) - 41 }}
        aria-label="Move the table"
        title="Drag to move the whole table — hold Shift to keep it level"
        onPointerDown={(e) => {
          e.stopPropagation()
          e.preventDefault()
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          lift.current = [e.clientX, e.clientY]
        }}
        onPointerMove={(e) => {
          if (!lift.current) return
          let dx = (e.clientX - lift.current[0]) / k
          let dy = (e.clientY - lift.current[1]) / k
          if (e.shiftKey) (Math.abs(dx) >= Math.abs(dy) ? (dy = 0) : (dx = 0))
          setCarry({ dx, dy })
        }}
        onPointerUp={() => {
          const c = carry
          lift.current = null
          setCarry(null)
          if (c && Math.hypot(c.dx, c.dy) > 1) api.onMove(c.dx, c.dy)
        }}
      >
        <Icon name="move" size={13} />
      </button>
      {carry && <span className="tbl-carry" style={{ left: px(x0 + carry.dx), top: px(y0 + carry.dy), width: px(x1 - x0), height: px(y1 - y0) }} />}

      {/* edges to drag (rows first, so that where an edge of each kind crosses the column one is on top) */}
      {model.ys.map((y, i) => (
        <span key={`ye${i}`} className="tbl-edge y" style={{ top: px(y) - 4, left: px(x0) - 4, width: px(x1 - x0) + 8 }} title={i === 0 || i === R ? 'Drag to move this side of the table' : 'Drag to resize the row'} onPointerDown={(e) => edgeDown(e, 'y', i)} onPointerMove={edgeMove} onPointerUp={edgeUp} />
      ))}
      {model.xs.map((x, i) => (
        <span key={`xe${i}`} className="tbl-edge x" style={{ left: px(x) - 4, top: px(y0) - 4, height: px(y1 - y0) + 8 }} title={i === 0 || i === C ? 'Drag to move this side of the table' : 'Drag to resize the column'} onPointerDown={(e) => edgeDown(e, 'x', i)} onPointerMove={edgeMove} onPointerUp={edgeUp} />
      ))}
      {ghost && (ghost.axis === 'x' ? <span className="tbl-ghost x" style={{ left: px(ghost.pos), top: px(y0) - 6, height: px(y1 - y0) + 12 }} /> : <span className="tbl-ghost y" style={{ top: px(ghost.pos), left: px(x0) - 6, width: px(x1 - x0) + 12 }} />)}

      {editing && editing[0] < R && editing[1] < C && <CellEditor key={`${editing[0]}:${editing[1]}`} view={p.view} k={k} cell={editing} api={api} />}
    </div>
  )
}

function CellEditor(p: { view: TableView; k: number; cell: [number, number]; api: TableApi }) {
  const [r, c] = p.cell
  const { model } = p.view
  const cell = model.cells[r][c]
  const [x0, y0, x1, y1] = cellRect(model, r, c)
  const [text, setText] = useState(cell.text)
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const finish = (move: 'next' | 'prev' | 'down' | null, keep = true) => {
    if (done.current) return
    done.current = true
    if (keep) p.api.onCellText(r, c, text, move)
    else p.api.onEdit(null)
  }
  return (
    <input
      ref={input}
      className="tbl-edit"
      style={{ left: x0 * p.k, top: y0 * p.k, width: (x1 - x0) * p.k, height: (y1 - y0) * p.k, fontSize: cell.size * p.k, textAlign: cell.align, color: `rgb(${cell.color.join(',')})`, background: cell.fill ? `rgb(${cell.fill.join(',')})` : '#fff', fontWeight: cell.bold ? 700 : 400, fontStyle: cell.italic ? 'italic' : 'normal' }}
      value={text}
      aria-label={`Row ${r + 1}, column ${c + 1}`}
      onChange={(e) => setText(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(null) // Enter ends the edit; Tab moves on to the next cell
        } else if (e.key === 'Tab') {
          e.preventDefault()
          finish(e.shiftKey ? 'prev' : 'next')
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null, false)
        }
      }}
      onBlur={() => finish(null)}
    />
  )
}
