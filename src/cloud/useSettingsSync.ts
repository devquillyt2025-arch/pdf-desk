import { useEffect, useRef, useState } from 'react'
import { cloudApi } from './api.ts'

/** The preferences that follow you between devices (the server accepts exactly these keys). */
export const SYNCED_KEYS = ['pagedesk-signature', 'pagedesk-draw-style', 'pagedesk-theme', 'pagedesk-ocr-lang', 'pagedesk-flag-threshold', 'pagedesk-find-opts'] as const

/**
 * Keeps `values` (the current setting of each key) in step with the cloud once you are signed in.
 * On sign-in the cloud's values win (that is how a second device picks up your theme and signature); after that,
 * only the keys that changed are sent, a moment after the change.
 */
export function useSettingsSync(ready: boolean, values: Record<string, unknown>, apply: (key: string, value: unknown) => void) {
  const applyRef = useRef(apply)
  applyRef.current = apply
  const valuesRef = useRef(values)
  valuesRef.current = values
  const sent = useRef<Record<string, string>>({})
  const [synced, setSynced] = useState(false)

  useEffect(() => {
    if (!ready) {
      setSynced(false)
      return
    }
    let alive = true
    cloudApi
      .getSettings()
      .then((remote) => {
        if (!alive) return
        for (const [k, v] of Object.entries(remote)) {
          if (!(k in valuesRef.current)) continue
          const s = JSON.stringify(v)
          sent.current[k] = s
          if (JSON.stringify(valuesRef.current[k]) !== s) applyRef.current(k, v)
        }
        setSynced(true)
      })
      .catch(() => {
        /* offline or locked again: preferences stay local, nothing is lost */
      })
    return () => {
      alive = false
    }
  }, [ready])

  const json = JSON.stringify(values)
  useEffect(() => {
    if (!synced) return
    const t = setTimeout(async () => {
      const changed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(valuesRef.current)) {
        if (v === null || v === undefined) continue
        if (sent.current[k] !== JSON.stringify(v)) changed[k] = v
      }
      if (!Object.keys(changed).length) return
      try {
        await cloudApi.putSettings(changed)
        for (const [k, v] of Object.entries(changed)) sent.current[k] = JSON.stringify(v)
      } catch {
        /* try again on the next change */
      }
    }, 1200)
    return () => clearTimeout(t)
  }, [synced, json])
}
