// Geometry for overlays (markup, shapes, pen, signatures, pictures). Pure TypeScript with no MuPDF, so the same
// numbers drive the on-screen SVG preview, the PDF content stream that is saved, and the tests.
import type { Overlay, Pt, Rect, Rgb, TextRun } from './types.ts'

export type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z']

export interface PathPrim {
  kind: 'path'
  segs: Seg[]
  fill: Rgb | null
  stroke: Rgb | null
  width: number
  /** 0..1 */
  alpha: number
  /** blend like a highlighter: the page shows through, darkened by the colour */
  multiply: boolean
  /** round caps and joins (pen, lines) or square (boxes) */
  round: boolean
}
export interface ImagePrim {
  kind: 'image'
  imageId: string
  rect: Rect
  alpha: number
}
export type Prim = PathPrim | ImagePrim

const KAPPA = 0.5522847498

/** Every colour an overlay is drawn with (a picture has none of its own). */
export function overlayColors(o: Overlay): Rgb[] {
  switch (o.type) {
    case 'highlight':
    case 'underline':
    case 'strike':
    case 'line':
    case 'arrow':
    case 'ink':
      return [o.color]
    case 'rect':
    case 'ellipse':
      return [o.stroke, o.fill].filter((c): c is Rgb => !!c)
    case 'image':
      return []
  }
}

export const normRect = (r: Rect): Rect => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
const union = (rs: Rect[]): Rect => rs.reduce<Rect>((u, r) => [Math.min(u[0], r[0]), Math.min(u[1], r[1]), Math.max(u[2], r[2]), Math.max(u[3], r[3])], [Infinity, Infinity, -Infinity, -Infinity])
const grow = (r: Rect, d: number): Rect => [r[0] - d, r[1] - d, r[2] + d, r[3] + d]
const rectPath = (r: Rect): Seg[] => [['M', r[0], r[1]], ['L', r[2], r[1]], ['L', r[2], r[3]], ['L', r[0], r[3]], ['Z']]

function ellipsePath([x0, y0, x1, y1]: Rect): Seg[] {
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const rx = (x1 - x0) / 2
  const ry = (y1 - y0) / 2
  const kx = rx * KAPPA
  const ky = ry * KAPPA
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['Z'],
  ]
}

/** A smooth curve through the points (Catmull-Rom → Bézier), so hand-drawn strokes don't look like polylines. */
function smoothStroke(pts: Pt[]): Seg[] {
  if (pts.length === 0) return []
  if (pts.length === 1) return [['M', pts[0][0], pts[0][1]], ['L', pts[0][0] + 0.01, pts[0][1]]] // a dot (round caps make it round)
  const segs: Seg[] = [['M', pts[0][0], pts[0][1]]]
  if (pts.length === 2) return [...segs, ['L', pts[1][0], pts[1][1]]]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const p3 = pts[i + 2] ?? p2
    segs.push(['C', p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]])
  }
  return segs
}

const headLen = (width: number) => Math.max(7, width * 4.5)

function arrowParts(a: Pt, b: Pt, width: number): { shaft: Seg[]; head: Seg[] } {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const L = Math.min(headLen(width), len * 0.7)
  const ang = (28 * Math.PI) / 180
  const wing = (s: number): Pt => [b[0] - L * (ux * Math.cos(ang) - s * uy * Math.sin(ang)), b[1] - L * (uy * Math.cos(ang) + s * ux * Math.sin(ang))]
  const [l, r] = [wing(1), wing(-1)]
  const base: Pt = [b[0] - ux * L * Math.cos(ang), b[1] - uy * L * Math.cos(ang)] // the shaft stops where the head begins
  return { shaft: [['M', a[0], a[1]], ['L', base[0], base[1]]], head: [['M', b[0], b[1]], ['L', l[0], l[1]], ['L', r[0], r[1]], ['Z']] }
}

export function overlayPrims(o: Overlay): Prim[] {
  const path = (segs: Seg[], p: Partial<PathPrim>): PathPrim => ({ kind: 'path', segs, fill: null, stroke: null, width: 1, alpha: 1, multiply: false, round: false, ...p })
  switch (o.type) {
    case 'highlight':
      return o.rects.map((r) => path(rectPath(normRect(r)), { fill: o.color, alpha: clamp01(o.opacity), multiply: true }))
    case 'underline':
      return o.rects.map((r) => {
        const n = normRect(r)
        const y = n[3] - Math.max(0.5, o.width / 2) - 0.5
        return path([['M', n[0], y], ['L', n[2], y]], { stroke: o.color, width: o.width, round: true })
      })
    case 'strike':
      return o.rects.map((r) => {
        const n = normRect(r)
        const y = n[1] + (n[3] - n[1]) * 0.56
        return path([['M', n[0], y], ['L', n[2], y]], { stroke: o.color, width: o.width, round: true })
      })
    case 'rect':
    case 'ellipse': {
      const n = normRect(o.rect)
      const segs = o.type === 'rect' ? rectPath(n) : ellipsePath(n)
      const out: Prim[] = []
      if (o.fill) out.push(path(segs, { fill: o.fill, alpha: clamp01(o.opacity) }))
      if (o.stroke && o.width > 0) out.push(path(segs, { stroke: o.stroke, width: o.width }))
      return out
    }
    case 'line':
      return [path([['M', o.a[0], o.a[1]], ['L', o.b[0], o.b[1]]], { stroke: o.color, width: o.width, round: true })]
    case 'arrow': {
      const { shaft, head } = arrowParts(o.a, o.b, o.width)
      return [path(shaft, { stroke: o.color, width: o.width, round: true }), path(head, { fill: o.color, stroke: o.color, width: Math.min(o.width, 1), round: true })]
    }
    case 'ink':
      return o.strokes.filter((s) => s.length).map((s) => path(smoothStroke(s), { stroke: o.color, width: o.width, round: true }))
    case 'image':
      return [{ kind: 'image', imageId: o.imageId, rect: normRect(o.rect), alpha: clamp01(o.opacity) }]
  }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Names for the Changes list and the verification report. */
export const OVERLAY_LABEL: Record<Overlay['type'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strike: 'Strike-out',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  ink: 'Drawing',
  image: 'Picture',
}

/** The area an overlay can change on the page (stroke width and arrow heads included). */
export function overlayBounds(o: Overlay): Rect {
  switch (o.type) {
    case 'highlight':
      return o.rects.length ? union(o.rects.map(normRect)) : [0, 0, 0, 0]
    case 'underline':
    case 'strike':
      return o.rects.length ? grow(union(o.rects.map(normRect)), o.width / 2 + 0.5) : [0, 0, 0, 0]
    case 'rect':
    case 'ellipse':
      return grow(normRect(o.rect), o.stroke ? o.width / 2 + 0.5 : 0)
    case 'line':
      return grow(normRect([o.a[0], o.a[1], o.b[0], o.b[1]]), o.width / 2 + 0.5)
    case 'arrow':
      return grow(normRect([o.a[0], o.a[1], o.b[0], o.b[1]]), Math.max(o.width / 2, headLen(o.width) * 0.6) + 0.5)
    case 'ink': {
      const pts = o.strokes.flat()
      return pts.length ? grow(union(pts.map((p) => [p[0], p[1], p[0], p[1]] as Rect)), o.width / 2 + 0.5) : [0, 0, 0, 0]
    }
    case 'image':
      return normRect(o.rect)
  }
}

/** The box that resizing stretches: shapes and pictures have an obvious one, pen strokes use their points. */
export function contentBox(o: Overlay): Rect | null {
  switch (o.type) {
    case 'rect':
    case 'ellipse':
    case 'image':
      return normRect(o.rect)
    case 'ink': {
      const pts = o.strokes.flat()
      return pts.length ? union(pts.map((p) => [p[0], p[1], p[0], p[1]] as Rect)) : null
    }
    default:
      return null
  }
}

export function moveOverlay(o: Overlay, dx: number, dy: number): Overlay {
  const mp = (p: Pt): Pt => [p[0] + dx, p[1] + dy]
  const mr = (r: Rect): Rect => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
  switch (o.type) {
    case 'highlight':
    case 'underline':
    case 'strike':
      return { ...o, rects: o.rects.map(mr) }
    case 'rect':
    case 'ellipse':
    case 'image':
      return { ...o, rect: mr(o.rect) }
    case 'line':
    case 'arrow':
      return { ...o, a: mp(o.a), b: mp(o.b) }
    case 'ink':
      return { ...o, strokes: o.strokes.map((s) => s.map(mp)) }
  }
}

/** Stretch an overlay so that its content box becomes `to`. Overlays without a content box are returned as they are. */
export function resizeOverlay(o: Overlay, to: Rect): Overlay {
  const from = contentBox(o)
  if (!from) return o
  const t = normRect(to)
  if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'image') return { ...o, rect: t }
  if (o.type === 'ink') {
    const w = from[2] - from[0]
    const h = from[3] - from[1]
    const sx = w > 0.001 ? (t[2] - t[0]) / w : 1
    const sy = h > 0.001 ? (t[3] - t[1]) / h : 1
    return { ...o, strokes: o.strokes.map((s) => s.map((p): Pt => [t[0] + (p[0] - from[0]) * sx + (w > 0.001 ? 0 : (t[2] - t[0]) / 2), t[1] + (p[1] - from[1]) * sy + (h > 0.001 ? 0 : (t[3] - t[1]) / 2)])) }
  }
  return o
}

const distToSegment = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Is page point (x, y) on this overlay (give or take `tol` pt)? Used to pick things with the Select tool. */
export function hitOverlay(o: Overlay, x: number, y: number, tol = 3): boolean {
  const p: Pt = [x, y]
  const inside = (r: Rect, d = 0) => x >= r[0] - d && x <= r[2] + d && y >= r[1] - d && y <= r[3] + d
  switch (o.type) {
    case 'highlight':
    case 'underline':
    case 'strike':
      return o.rects.some((r) => inside(normRect(r), tol + (o.type === 'highlight' ? 0 : o.width)))
    case 'rect':
    case 'ellipse':
    case 'image':
      return inside(normRect(o.rect), tol)
    case 'line':
    case 'arrow':
      return distToSegment(p, o.a, o.b) <= tol + o.width / 2
    case 'ink':
      return o.strokes.some((s) => (s.length === 1 ? Math.hypot(x - s[0][0], y - s[0][1]) <= tol + o.width / 2 : s.some((q, i) => i > 0 && distToSegment(p, s[i - 1], q) <= tol + o.width / 2)))
  }
}

// ------------------------------------------------------------------------------------- output formats

const n4 = (v: number) => (Math.round(v * 10000) / 10000).toString()
const rgb01 = (c: Rgb) => c.map((v) => n4(v / 255)).join(' ')

export const segsToSvg = (segs: Seg[]): string => segs.map((s) => (s[0] === 'Z' ? 'Z' : `${s[0]} ${s.slice(1).map((v) => n4(v as number)).join(' ')}`)).join(' ')

export interface ContentContext {
  /** name of the ExtGState resource for this opacity / blend, created by the caller */
  gstate(alpha: number, multiply: boolean): string
  /** name of the XObject resource for a registered picture, or null if it is unknown */
  image(imageId: string): string | null
}

/** PDF operators (page space, y down) that draw `prims`. Wrap them in the page's inverse transform. */
export function primsToContent(prims: Prim[], ctx: ContentContext): string[] {
  const out: string[] = []
  for (const p of prims) {
    if (p.kind === 'image') {
      const name = ctx.image(p.imageId)
      if (!name) continue
      const [x0, y0, x1, y1] = p.rect
      const gs = p.alpha < 1 ? `/${ctx.gstate(p.alpha, false)} gs ` : ''
      out.push(`q ${gs}${n4(x1 - x0)} 0 0 ${n4(-(y1 - y0))} ${n4(x0)} ${n4(y1)} cm /${name} Do Q`)
      continue
    }
    if (!p.segs.length || (!p.fill && !p.stroke)) continue
    const ops: string[] = ['q']
    if (p.alpha < 1 || p.multiply) ops.push(`/${ctx.gstate(p.alpha, p.multiply)} gs`)
    if (p.fill) ops.push(`${rgb01(p.fill)} rg`)
    if (p.stroke) ops.push(`${rgb01(p.stroke)} RG`, `${n4(p.width)} w`, p.round ? '1 J 1 j' : '0 J 0 j')
    for (const s of p.segs) ops.push(s[0] === 'Z' ? 'h' : s[0] === 'M' ? `${n4(s[1])} ${n4(s[2])} m` : s[0] === 'L' ? `${n4(s[1])} ${n4(s[2])} l` : `${s.slice(1).map((v) => n4(v as number)).join(' ')} c`)
    ops.push(p.fill && p.stroke ? 'B' : p.fill ? 'f' : 'S', 'Q')
    out.push(ops.join(' '))
  }
  return out
}

// ----------------------------------------------------------------------------------- text selection

type SelRun = Pick<TextRun, 'text' | 'xs' | 'rect' | 'baseline' | 'size'>

/**
 * Like selecting text with the mouse: drag from point `a` to point `b` and get one box per stretch of text
 * between them (reading order, line by line). Used by highlight / underline / strike-out.
 */
export function selectTextRects(runs: SelRun[], a: Pt, b: Pt): Rect[] {
  if (!runs.length) return []
  // 1. group runs into lines by baseline
  const sorted = [...runs].sort((p, q) => p.baseline - q.baseline)
  const lineOf = new Map<SelRun, number>()
  const lines: { top: number; bottom: number; size: number }[] = []
  let lastBase = -Infinity
  for (const r of sorted) {
    if (!lines.length || r.baseline - lastBase > Math.max(2, r.size * 0.45)) lines.push({ top: Infinity, bottom: -Infinity, size: r.size })
    const L = lines[lines.length - 1]
    L.top = Math.min(L.top, r.rect[1])
    L.bottom = Math.max(L.bottom, r.rect[3])
    L.size = Math.max(L.size, r.size)
    lastBase = r.baseline
    lineOf.set(r, lines.length - 1)
  }
  // 2. the line nearest to each end of the drag (a point in the margin still counts if it is close)
  const nearest = (y: number) => {
    let best = -1
    let bd = Infinity
    lines.forEach((L, i) => {
      const d = y < L.top ? L.top - y : y > L.bottom ? y - L.bottom : 0
      if (d < bd) {
        bd = d
        best = i
      }
    })
    return bd <= lines[best].size * 1.2 ? best : -1
  }
  let la = nearest(a[1])
  let lb = nearest(b[1])
  if (la < 0 || lb < 0) {
    // one end in empty space: use the other line if it is the only one touched, else give up
    if (la < 0 && lb < 0) return []
    if (la < 0) la = lb
    else lb = la
  }
  let S = a
  let E = b
  let ls = la
  let le = lb
  if (la > lb || (la === lb && a[0] > b[0])) {
    S = b
    E = a
    ls = lb
    le = la
  }

  // 3. every character between S and E (by line, then by x), as boxes per run
  const boxes: { line: number; rect: Rect; size: number }[] = []
  for (const r of runs) {
    const li = lineOf.get(r)!
    if (li < ls || li > le) continue
    let first = -1
    let last = -1
    for (let i = 0; i < r.text.length; i++) {
      const cx = (r.xs[i] + r.xs[i + 1]) / 2
      if (li === ls && cx < S[0]) continue
      if (li === le && cx > E[0]) continue
      if (r.text[i] === ' ' && first < 0) continue
      if (first < 0) first = i
      if (r.text[i] !== ' ') last = i
    }
    if (first >= 0 && last >= first) boxes.push({ line: li, rect: [r.xs[first], r.rect[1], r.xs[last + 1], r.rect[3]], size: r.size })
  }
  // 4. one box per line where the pieces nearly touch
  boxes.sort((p, q) => p.line - q.line || p.rect[0] - q.rect[0])
  const merged: { line: number; rect: Rect; size: number }[] = []
  for (const bx of boxes) {
    const prev = merged[merged.length - 1]
    if (prev && prev.line === bx.line && bx.rect[0] - prev.rect[2] <= Math.max(prev.size, bx.size) * 0.7) {
      prev.rect = [prev.rect[0], Math.min(prev.rect[1], bx.rect[1]), Math.max(prev.rect[2], bx.rect[2]), Math.max(prev.rect[3], bx.rect[3])]
    } else merged.push({ ...bx, rect: [...bx.rect] as Rect })
  }
  return merged.map((m) => m.rect)
}
