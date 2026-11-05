// Pure helpers that turn pointer gestures and ribbon choices into overlays. No React, so they can be tested in Node.
import { normRect } from '../engine/overlay.ts'
import type { Overlay, Pt, Rect, Rgb } from '../engine/types.ts'
import type { DrawStyle, Tool } from './types.ts'

export const STROKE_COLORS: { name: string; rgb: Rgb }[] = [
  { name: 'Black', rgb: [17, 24, 39] },
  { name: 'Red', rgb: [220, 38, 38] },
  { name: 'Blue', rgb: [37, 99, 235] },
  { name: 'Green', rgb: [22, 163, 74] },
  { name: 'Orange', rgb: [234, 88, 12] },
  { name: 'White', rgb: [255, 255, 255] },
]
export const HIGHLIGHT_COLORS: { name: string; rgb: Rgb }[] = [
  { name: 'Yellow', rgb: [255, 235, 59] },
  { name: 'Green', rgb: [110, 231, 150] },
  { name: 'Pink', rgb: [249, 168, 212] },
  { name: 'Cyan', rgb: [103, 232, 249] },
  { name: 'Orange', rgb: [253, 186, 116] },
]
export const WIDTHS = [1, 2, 3, 5, 8]
export const FILLS: { label: string; value: number }[] = [
  { label: 'No fill', value: 0 },
  { label: 'Tinted', value: 0.25 },
  { label: 'Solid', value: 1 },
]

export const DEFAULT_DRAW: DrawStyle = { color: STROKE_COLORS[1].rgb, width: 2, fill: 0, highlight: HIGHLIGHT_COLORS[0].rgb }

export const isTextMarkTool = (t: Tool) => t === 'highlight' || t === 'underline' || t === 'strike'
export const isShapeTool = (t: Tool) => t === 'rect' || t === 'ellipse' || t === 'line' || t === 'arrow'
export const isDragTool = (t: Tool) => isShapeTool(t) || t === 'pen'

const sameRgb = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
export const sameColor = sameRgb

/** A rectangle, ellipse, line or arrow dragged from `a` to `b`. Shift keeps boxes square and lines at 45° steps. */
export function shapeFor(tool: Tool, a: Pt, b: Pt, style: DrawStyle, shift = false): Overlay | null {
  let [bx, by] = b
  if (shift) {
    const dx = bx - a[0]
    const dy = by - a[1]
    if (tool === 'rect' || tool === 'ellipse') {
      const s = Math.max(Math.abs(dx), Math.abs(dy))
      bx = a[0] + Math.sign(dx || 1) * s
      by = a[1] + Math.sign(dy || 1) * s
    } else if (tool === 'line' || tool === 'arrow') {
      const len = Math.hypot(dx, dy)
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
      bx = a[0] + Math.cos(ang) * len
      by = a[1] + Math.sin(ang) * len
    }
  }
  if (tool === 'rect' || tool === 'ellipse') {
    const rect = normRect([a[0], a[1], bx, by])
    if (rect[2] - rect[0] < 3 || rect[3] - rect[1] < 3) return null
    return { type: tool, rect, stroke: style.color, fill: style.fill > 0 ? style.color : null, width: style.width, opacity: style.fill > 0 ? style.fill : 1 }
  }
  if (tool === 'line' || tool === 'arrow') {
    if (Math.hypot(bx - a[0], by - a[1]) < 4) return null
    return { type: tool, a, b: [bx, by], color: style.color, width: style.width }
  }
  return null
}

export type Corner = 'nw' | 'ne' | 'sw' | 'se'

/** New box when `corner` of `box` is dragged to `pt`. The opposite corner stays put; pictures and pen drawings keep their shape. */
export function resizeBox(box: Rect, corner: Corner, pt: Pt, keepAspect: boolean, min = 6): Rect {
  const anchor: Pt = [corner.includes('w') ? box[2] : box[0], corner.includes('n') ? box[3] : box[1]]
  let dx = pt[0] - anchor[0]
  let dy = pt[1] - anchor[1]
  const sx = dx < 0 ? -1 : 1
  const sy = dy < 0 ? -1 : 1
  if (keepAspect) {
    const ar = Math.max(0.01, (box[2] - box[0]) / Math.max(0.01, box[3] - box[1]))
    const w = Math.max(min, Math.abs(dx), Math.abs(dy) * ar)
    dx = sx * w
    dy = sy * (w / ar)
  } else {
    dx = sx * Math.max(min, Math.abs(dx))
    dy = sy * Math.max(min, Math.abs(dy))
  }
  return normRect([anchor[0], anchor[1], anchor[0] + dx, anchor[1] + dy])
}

/** Drop points that are closer than `min` pt to the previous one (keeps the last point). */
export function simplify(points: Pt[], min = 0.8): Pt[] {
  if (points.length <= 2) return points
  const out: Pt[] = [points[0]]
  for (let i = 1; i < points.length - 1; i++) if (Math.hypot(points[i][0] - out[out.length - 1][0], points[i][1] - out[out.length - 1][1]) >= min) out.push(points[i])
  out.push(points[points.length - 1])
  return out
}

export function penOverlay(points: Pt[], style: DrawStyle): Overlay | null {
  if (!points.length) return null
  return { type: 'ink', strokes: [simplify(points)], color: style.color, width: style.width }
}

export function markOverlay(tool: Tool, rects: Rect[], style: DrawStyle): Overlay | null {
  if (!rects.length) return null
  if (tool === 'highlight') return { type: 'highlight', rects, color: style.highlight, opacity: 1 }
  if (tool === 'underline') return { type: 'underline', rects, color: style.color, width: Math.min(style.width, 3) }
  if (tool === 'strike') return { type: 'strike', rects, color: style.color, width: Math.min(style.width, 3) }
  return null
}

/** The part of the ribbon's style that applies to an existing overlay (shown while it is selected). */
export function styleOf(o: Overlay): Partial<DrawStyle> & { kind: 'highlight' | 'stroke' | 'none' } {
  switch (o.type) {
    case 'highlight':
      return { kind: 'highlight', highlight: o.color }
    case 'underline':
    case 'strike':
    case 'line':
    case 'arrow':
    case 'ink':
      return { kind: 'stroke', color: o.color, width: o.width }
    case 'rect':
    case 'ellipse':
      return { kind: 'stroke', color: o.stroke ?? o.fill ?? [0, 0, 0], width: o.width, fill: o.fill ? o.opacity : 0 }
    case 'image':
      return { kind: 'none' }
  }
}

/** Apply a change from the ribbon to a selected overlay. */
export function restyle(o: Overlay, patch: Partial<DrawStyle>): Overlay {
  switch (o.type) {
    case 'highlight':
      return patch.highlight ? { ...o, color: patch.highlight } : o
    case 'underline':
    case 'strike':
    case 'line':
    case 'arrow':
    case 'ink':
      return { ...o, color: patch.color ?? o.color, width: patch.width ?? o.width }
    case 'rect':
    case 'ellipse': {
      const color = patch.color ?? o.stroke ?? o.fill ?? [0, 0, 0]
      const fillAmount = patch.fill ?? (o.fill ? o.opacity : 0)
      return { ...o, stroke: color, fill: fillAmount > 0 ? color : null, opacity: fillAmount > 0 ? fillAmount : 1, width: patch.width ?? o.width }
    }
    case 'image':
      return o
  }
}

// ---------------------------------------------------------------------------------- placing things

/** A signature as drawn on the pad: strokes in pad pixels and the pad's size. */
export interface Signature {
  w: number
  h: number
  strokes: Pt[][]
}

const clampInto = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Put a signature centred on (cx, cy), `width` pt wide, as ink in `color`. Kept inside the page. */
export function signatureOverlay(sig: Signature, cx: number, cy: number, width: number, color: Rgb, page: { width: number; height: number }): Overlay {
  const k = width / sig.w
  const h = sig.h * k
  const x0 = clampInto(cx - width / 2, 0, Math.max(0, page.width - width))
  const y0 = clampInto(cy - h / 2, 0, Math.max(0, page.height - h))
  return { type: 'ink', strokes: sig.strokes.map((s) => s.map((p): Pt => [x0 + p[0] * k, y0 + p[1] * k])), color, width: Math.max(1.2, 2.4 * k) }
}

/** Trim empty margins off a drawn signature so that its box fits the ink. */
export function cropSignature(sig: Signature, pad = 4): Signature {
  const pts = sig.strokes.flat()
  if (!pts.length) return sig
  const x0 = Math.min(...pts.map((p) => p[0])) - pad
  const y0 = Math.min(...pts.map((p) => p[1])) - pad
  const x1 = Math.max(...pts.map((p) => p[0])) + pad
  const y1 = Math.max(...pts.map((p) => p[1])) + pad
  return { w: x1 - x0, h: y1 - y0, strokes: sig.strokes.map((s) => s.map((p): Pt => [p[0] - x0, p[1] - y0])) }
}

/** A picture centred on (cx, cy), about `width` pt wide (shrunk if the page is small), kept inside the page. */
export function imageOverlay(imageId: string, aspect: number, cx: number, cy: number, width: number, page: { width: number; height: number }): Overlay {
  const w = Math.min(width, page.width * 0.9, page.height * 0.9 * aspect)
  const h = w / aspect
  const x0 = clampInto(cx - w / 2, 0, Math.max(0, page.width - w))
  const y0 = clampInto(cy - h / 2, 0, Math.max(0, page.height - h))
  return { type: 'image', rect: [x0, y0, x0 + w, y0 + h], imageId, opacity: 1 }
}
