import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { Edit } from '../engine/types.ts'

/** The scrolling element of the viewer, so pages can pre-render just before they scroll into view. */
export const ScrollRootContext = createContext<HTMLElement | null>(null)

export function useNearViewport(margin = 900, rootOverride?: HTMLElement | null): [(el: Element | null) => void, boolean] {
  const ctxRoot = useContext(ScrollRootContext)
  const root = rootOverride ?? ctxRoot
  const [near, setNear] = useState(false)
  const obs = useRef<IntersectionObserver | null>(null)
  const ref = useCallback(
    (el: Element | null) => {
      obs.current?.disconnect()
      obs.current = null
      if (!el) return
      const io = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root, rootMargin: `${margin}px 0px` })
      io.observe(el)
      obs.current = io
    },
    [root, margin],
  )
  useEffect(() => () => obs.current?.disconnect(), [])
  return [ref, near]
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const EMPTY: Edit[] = []

/** Groups edits by page, keeping the same array identity for pages whose edits did not change. */
export function usePageEdits(edits: Edit[]): (page: number) => Edit[] {
  const cache = useRef(new Map<number, Edit[]>())
  const next = new Map<number, Edit[]>()
  for (const e of edits) next.set(e.page, [...(next.get(e.page) ?? []), e])
  for (const [page, list] of next) {
    const old = cache.current.get(page)
    if (old && old.length === list.length && old.every((e, i) => e === list[i])) next.set(page, old)
  }
  cache.current = next
  return (page) => next.get(page) ?? EMPTY
}

/**
 * The edits that change the page *picture* (text edits). Overlays are drawn by the SVG layer instead, so moving or
 * restyling one must not make the page render again — hence the same array back while only overlays changed.
 */
export function useTextEdits(edits: Edit[]): Edit[] {
  const prev = useRef<Edit[]>([])
  const next = edits.filter((e) => e.kind !== 'overlay')
  if (next.length === prev.current.length && next.every((e, i) => e === prev.current[i])) return prev.current
  prev.current = next
  return next
}

export function useStoredState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (nv: T) => {
      setV(nv)
      try {
        localStorage.setItem(key, JSON.stringify(nv))
      } catch {
        /* storage can be unavailable; the preference just won't persist */
      }
    },
    [key],
  )
  return [v, set]
}

export function useEvent<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn)
  ref.current = fn
  return useCallback((...a: A) => ref.current(...a), [])
}
