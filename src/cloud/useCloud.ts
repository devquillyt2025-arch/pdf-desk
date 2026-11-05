import { useCallback, useEffect, useState } from 'react'
import { CloudError, cloudApi, onCloudLocked, type CloudDoc, type HistoryRow } from './api.ts'

/**
 *  checking – asking the server
 *  off      – this server has no cloud (or you are offline): the editor simply works as it always did
 *  locked   – set up, waiting for the passcode
 *  ready    – signed in
 */
export type CloudStatus = 'checking' | 'off' | 'locked' | 'ready'

export function useCloud() {
  const [status, setStatus] = useState<CloudStatus>('checking')
  const [reason, setReason] = useState('')
  const [documents, setDocuments] = useState<CloudDoc[]>([])
  const [usedBytes, setUsedBytes] = useState(0)
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    onCloudLocked(() => setStatus((s) => (s === 'ready' ? 'locked' : s)))
    void cloudApi.status().then((s) => {
      if (!alive) return
      if (!s.configured) {
        setStatus('off')
        setReason(s.reason ?? '')
      } else setStatus(s.authed ? 'ready' : 'locked')
    })
    return () => {
      alive = false
      onCloudLocked(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [d, h] = await Promise.all([cloudApi.listDocuments(), cloudApi.history(30)])
      setDocuments(d.documents)
      setUsedBytes(d.usedBytes)
      setHistory(h)
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 401)) console.warn('cloud refresh failed', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (status === 'ready') void refresh()
  }, [status, refresh])

  const unlock = useCallback(async (passcode: string) => {
    await cloudApi.login(passcode)
    setStatus('ready')
  }, [])
  const lock = useCallback(() => {
    cloudApi.logout()
    setStatus('locked')
    setDocuments([])
    setHistory([])
  }, [])

  return { status, reason, documents, usedBytes, history, loading, refresh, unlock, lock }
}

export type Cloud = ReturnType<typeof useCloud>
