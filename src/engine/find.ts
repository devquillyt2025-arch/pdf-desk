// Find & replace inside one line of text. Pure TypeScript, shared by the UI and the tests.
import type { Rect, TextRun } from './types.ts'

export interface FindOptions {
  matchCase: boolean
  wholeWord: boolean
}

const WORD = /[\p{L}\p{N}_]/u

/** Start indexes of every non-overlapping match of `query` in `text`. */
export function findAll(text: string, query: string, o: FindOptions): number[] {
  if (!query) return []
  let hay = text
  let needle = query
  if (!o.matchCase) {
    const h = text.toLowerCase()
    const q = query.toLowerCase()
    // a few characters change length when lower-cased; then indexes would no longer line up, so stay case-sensitive
    if (h.length === text.length && q.length === query.length) {
      hay = h
      needle = q
    }
  }
  const out: number[] = []
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    if (o.wholeWord) {
      const before = i > 0 ? text[i - 1] : ''
      const after = i + needle.length < text.length ? text[i + needle.length] : ''
      if ((before && WORD.test(before)) || (after && WORD.test(after))) continue
    }
    out.push(i)
  }
  return out
}

/** `text` with every match (or only the `only`-th one) replaced. */
export function replaceIn(text: string, query: string, replacement: string, o: FindOptions, only?: number): string {
  const hits = findAll(text, query, o)
  if (!hits.length) return text
  let out = ''
  let pos = 0
  hits.forEach((start, i) => {
    out += text.slice(pos, start)
    out += only === undefined || only === i ? replacement : text.slice(start, start + query.length)
    pos = start + query.length
  })
  return out + text.slice(pos)
}

export interface Match {
  run: TextRun
  /** which match inside this run (0, 1, …) */
  nth: number
  start: number
  end: number
  /** where to draw the highlight (the whole run once its text has been changed) */
  rect: Rect
  /** a short stretch of the line around the match, for the results list */
  before: string
  hit: string
  after: string
}

/**
 * Every match in `runs` (in the order given). `textOf` gives each run's current text, which differs from the
 * original once it has been edited; positions inside an edited run are approximate, so its whole box is used.
 */
export function findMatches(runs: TextRun[], textOf: (r: TextRun) => string, query: string, o: FindOptions): Match[] {
  const out: Match[] = []
  for (const run of runs) {
    const text = textOf(run)
    findAll(text, query, o).forEach((start, nth) => {
      const end = start + query.length
      const unchanged = text === run.text && run.xs.length > end
      const rect: Rect = unchanged ? [run.xs[start], run.rect[1], run.xs[end], run.rect[3]] : run.rect
      out.push({ run, nth, start, end, rect, before: text.slice(Math.max(0, start - 18), start), hit: text.slice(start, end), after: text.slice(end, end + 24) })
    })
  }
  return out
}
