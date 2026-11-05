// The browser's side of the cloud: plain fetch calls to /api/* (see server/cloud.ts). It never sees the database.

const TOKEN_KEY = 'pagedesk-cloud-token'

export class CloudError extends Error {
  status: number
  body: Record<string, unknown>
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.body = body
  }
}

const store = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY)
    } catch {
      return null
    }
  },
  set: (t: string | null) => {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t)
      else localStorage.removeItem(TOKEN_KEY)
    } catch {
      /* private mode: you will be asked again next time */
    }
  },
}

let whenLocked: (() => void) | null = null
/** Called when the server says our token is no longer good (expired, or the passcode changed). */
export const onCloudLocked = (fn: (() => void) | null) => {
  whenLocked = fn
}

async function request(method: string, path: string, o: { json?: unknown; raw?: Uint8Array; auth?: boolean } = {}): Promise<{ json: any; bytes: Uint8Array }> {
  const headers: Record<string, string> = {}
  const token = store.get()
  if (token && o.auth !== false) headers.authorization = `Bearer ${token}`
  let body: BodyInit | undefined
  if (o.raw) {
    headers['content-type'] = 'application/octet-stream'
    body = o.raw as BodyInit
  } else if (o.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(o.json)
  }
  let res: Response
  try {
    res = await fetch(`/api${path}`, { method, headers, body })
  } catch {
    throw new CloudError(0, 'Could not reach the server. Check your connection.')
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const isJson = (res.headers.get('content-type') ?? '').includes('json')
  const json = isJson ? JSON.parse(new TextDecoder().decode(bytes) || 'null') : null
  if (!res.ok) {
    if (res.status === 401 && json?.locked) {
      store.set(null)
      whenLocked?.()
    }
    throw new CloudError(res.status, (json?.error as string) ?? `The server answered ${res.status}.`, json ?? {})
  }
  return { json, bytes }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
export const sha256 = async (bytes: Uint8Array) => hex(await crypto.subtle.digest('SHA-256', bytes as BufferSource))

export interface CloudDoc {
  id: string
  name: string
  kind: 'original' | 'saved' | 'asset'
  parentId: string | null
  size: number
  sha256: string
  pages: number | null
  createdAt: string
  chunks: number
  chunkSize: number
  draft?: { updatedAt: string; edits: number } | null
}
export interface HistoryRow {
  id: number
  savedAt: string
  fileName: string
  documentId: string | null
  pages: number | null
  size: number | null
  editCount: number
  summary: Record<string, number>
  verified: boolean
  collateral: number
  note: string | null
}
export interface DraftReply {
  state: unknown
  editCount: number
  updatedAt: string
}

export const cloudApi = {
  hasToken: () => !!store.get(),

  /** Is the cloud set up on this server, and are we signed in? Never throws: an unreachable or absent API just means "off". */
  async status(): Promise<{ configured: boolean; reason?: string; authed: boolean }> {
    try {
      const r = await fetch('/api/status', { headers: store.get() ? { authorization: `Bearer ${store.get()}` } : {} })
      if (!(r.headers.get('content-type') ?? '').includes('json')) return { configured: false, reason: 'no server', authed: false } // a static host with no api/
      return await r.json()
    } catch {
      return { configured: false, reason: 'offline', authed: false }
    }
  },
  async login(passcode: string): Promise<void> {
    const { json } = await request('POST', '/auth', { json: { passcode }, auth: false })
    store.set(json.token)
  },
  logout: () => store.set(null),

  async getSettings(): Promise<Record<string, unknown>> {
    return (await request('GET', '/settings')).json.settings
  },
  async putSettings(settings: Record<string, unknown>): Promise<void> {
    await request('PUT', '/settings', { json: { settings } })
  },

  async listDocuments(): Promise<{ documents: CloudDoc[]; usedBytes: number }> {
    return (await request('GET', '/documents')).json
  },

  /**
   * Store a file. It goes up in pieces (the server accepts ~4.5 MB per request); the same bytes are only ever stored
   * once, and a half-finished upload carries on where it stopped.
   */
  async upload(bytes: Uint8Array, meta: { name: string; kind: 'original' | 'saved' | 'asset'; pages?: number; parentId?: string | null }, onProgress?: (done: number, total: number) => void): Promise<{ id: string; existing: boolean }> {
    const hash = await sha256(bytes)
    const { json: start } = await request('POST', '/documents', { json: { name: meta.name, kind: meta.kind, size: bytes.length, sha256: hash, pages: meta.pages ?? null, parentId: meta.parentId ?? null } })
    if (start.existing) {
      onProgress?.(1, 1)
      return { id: start.id, existing: true }
    }
    const have = new Set<number>(start.have)
    for (let i = 0; i < start.chunks; i++) {
      onProgress?.(i, start.chunks)
      if (have.has(i)) continue
      const piece = bytes.subarray(i * start.chunkSize, Math.min(bytes.length, (i + 1) * start.chunkSize))
      try {
        await request('PUT', `/documents/${start.id}/chunks/${i}`, { raw: piece })
      } catch (e) {
        if (e instanceof CloudError && e.status !== 0 && e.status !== 502 && e.status !== 504) throw e
        await request('PUT', `/documents/${start.id}/chunks/${i}`, { raw: piece }) // one retry for a dropped connection
      }
    }
    await request('POST', `/documents/${start.id}/complete`)
    onProgress?.(start.chunks, start.chunks)
    return { id: start.id, existing: false }
  },

  /** Fetch a file piece by piece and check it against its SHA-256 before handing it over. */
  async download(id: string, onProgress?: (done: number, total: number) => void): Promise<{ bytes: Uint8Array; name: string }> {
    const { json: meta } = await request('GET', `/documents/${id}`)
    const out = new Uint8Array(meta.size)
    let at = 0
    for (let i = 0; i < meta.chunks; i++) {
      onProgress?.(i, meta.chunks)
      const { bytes } = await request('GET', `/documents/${id}/chunks/${i}`)
      out.set(bytes, at)
      at += bytes.length
    }
    onProgress?.(meta.chunks, meta.chunks)
    if (at !== meta.size || (await sha256(out)) !== meta.sha256) throw new CloudError(0, 'The file that came back from the cloud does not match what was stored. Try again.')
    return { bytes: out, name: meta.name }
  },
  async deleteDocument(id: string): Promise<void> {
    await request('DELETE', `/documents/${id}`)
  },

  async getDraft(documentId: string): Promise<DraftReply | null> {
    try {
      return (await request('GET', `/drafts/${documentId}`)).json
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return null
      throw e
    }
  },
  async putDraft(documentId: string, state: unknown, editCount: number): Promise<string> {
    return (await request('PUT', `/drafts/${documentId}`, { json: { state, editCount } })).json.savedAt
  },
  async deleteDraft(documentId: string): Promise<void> {
    await request('DELETE', `/drafts/${documentId}`)
  },

  async history(limit = 30): Promise<HistoryRow[]> {
    return (await request('GET', `/history?limit=${limit}`)).json.history
  },
  async logSave(entry: { fileName: string; pages?: number; size?: number; editCount: number; summary: Record<string, number>; verified: boolean; collateral: number; documentId?: string | null; note?: string | null }): Promise<void> {
    await request('POST', '/history', { json: entry })
  },
}
