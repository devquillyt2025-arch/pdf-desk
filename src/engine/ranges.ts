// Pure helpers shared by the UI and the tests — no MuPDF here, so the main bundle stays small.

export interface RangeResult {
  /** 0-based page indexes, in the order typed (duplicates kept, so "3,1,2" re-orders) */
  pages: number[]
  error?: string
}

/**
 * Parse a page selection such as "1-3, 5, 8-" (1-based, inclusive).
 *   "8-"  → page 8 to the end      "-3" → pages 1 to 3      "5-2" → 5,4,3,2
 *   "all" · "odd" · "even" are understood too.
 */
export function parseRanges(spec: string, count: number): RangeResult {
  const s = spec.trim().toLowerCase().replace(/\s*[-–—]\s*/g, '-')
  if (!s) return { pages: [], error: 'Type the pages you want, for example 1-3, 5, 8-' }
  const out: number[] = []
  for (const tok of s.split(/[\s,;]+/)) {
    if (!tok) continue
    if (tok === 'all') {
      for (let i = 0; i < count; i++) out.push(i)
      continue
    }
    if (tok === 'odd' || tok === 'even') {
      for (let i = tok === 'odd' ? 0 : 1; i < count; i += 2) out.push(i)
      continue
    }
    const m = /^(\d*)(-?)(\d*)$/.exec(tok)
    if (!m || (m[1] === '' && m[3] === '')) return { pages: [], error: `“${tok}” isn’t a page number or range.` }
    const hasDash = m[2] === '-'
    const a = m[1] === '' ? 1 : Number(m[1])
    const b = !hasDash ? a : m[3] === '' ? count : Number(m[3])
    if (a < 1 || b < 1 || a > count || b > count) {
      return { pages: [], error: `“${tok}” is outside this document (it has ${count} page${count === 1 ? '' : 's'}).` }
    }
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1)
    else for (let i = a; i >= b; i--) out.push(i - 1)
  }
  if (!out.length) return { pages: [], error: 'No pages matched.' }
  return { pages: out }
}

/** "1-3, 5, 7-9" from a set of 0-based indexes. */
export function formatRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((x, y) => x - y)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i] + 1}-${sorted[j] + 1}` : `${sorted[i] + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
