import type { Edit, EditPlan, FontStyle, Rect } from './types.ts'

export function sameStyle(a: FontStyle, b: FontStyle): boolean {
  return (
    a.family === b.family &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    Math.abs(a.size - b.size) < 0.05 &&
    a.color[0] === b.color[0] &&
    a.color[1] === b.color[1] &&
    a.color[2] === b.color[2]
  )
}

export function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

/**
 * Work out what an edit does. The key accuracy property lives here: the leading part of a
 * run that the user did not change is *kept as it is* (original glyphs / original pixels);
 * only the changed tail is cleared and redrawn.
 *
 * `raster` is true for scanned pages, where the clear area is padded outwards (to swallow
 * anti-aliasing fringe) instead of inset (to avoid touching neighbouring glyphs on text pages).
 */
export function planEdit(edit: Edit, raster: boolean): EditPlan {
  if (edit.kind === 'add') {
    const has = edit.text.trim() !== ''
    return {
      clear: null,
      draw: has ? { text: edit.text, x: edit.x ?? 0, baseline: edit.baseline ?? 0, style: edit.style } : null,
      keep: 0,
      noop: !has,
    }
  }

  if (edit.kind === 'erase') {
    return { clear: edit.rect ?? null, draw: null, keep: 0, noop: !edit.rect }
  }

  const run = edit.run
  if (!run) return { clear: null, draw: null, keep: 0, noop: true }

  const oldText = run.text
  const newText = edit.text
  const styleChanged = !sameStyle(edit.style, run.style)
  if (newText === oldText && !styleChanged) return { clear: null, draw: null, keep: oldText.length, noop: true }

  let keep = 0
  if (edit.keepPrefix !== false && !styleChanged) {
    if (newText.startsWith(oldText)) keep = oldText.length // pure append
    else if (oldText.startsWith(newText)) keep = newText.length // pure truncation
    else {
      keep = commonPrefixLen(oldText, newText)
      // Re-typeset whole words, never half a word.
      while (keep > 0 && oldText[keep - 1] !== ' ') keep--
    }
  }

  const tail = newText.slice(keep)
  const pad = run.size * 0.08
  const [rx0, ry0, rx1, ry1] = run.rect
  const startX = run.xs[Math.min(keep, run.xs.length - 1)]

  let clear: Rect | null = null
  if (keep < oldText.length) {
    clear = raster
      ? [startX - (keep === 0 ? pad : 0), ry0 - pad, rx1 + pad, ry1 + pad]
      : [startX, ry0 + pad, rx1, ry1 - pad]
    if (keep === 0 && !raster) clear[0] = rx0
  }

  const draw = tail !== '' ? { text: tail, x: startX, baseline: run.baseline, style: edit.style } : null
  return { clear, draw, keep, noop: clear === null && draw === null }
}

export function rectUnion(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

export function pointInRect(x: number, y: number, r: Rect): boolean {
  return x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]
}
