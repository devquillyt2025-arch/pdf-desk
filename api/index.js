// GENERATED from server/cloud.ts by scripts/build-api.mjs — edit that file, not this one.
// (Vercel's Node builder cannot compile TypeScript 7, so the function is shipped as plain JavaScript.)
/**
 * PageDesk cloud — the only code that ever sees the database password.
 *
 * One function answers every /api/* request. On Vercel it is a serverless function; during `npm run dev` the Vite
 * plugin in vite.config.ts calls the very same `handler`. It is written as a single file with no relative imports so
 * that Vercel can bundle it without any module-resolution surprises.
 *
 *   GET    /api/status                          is the cloud set up? am I signed in?
 *   POST   /api/auth                            passcode → token (30 days)
 *   GET    /api/settings · PUT /api/settings    settings that follow you between devices
 *   GET    /api/documents                       the library (originals, saved versions, pictures) + draft badges
 *   POST   /api/documents                       start an upload (same bytes already stored → reused)
 *   PUT    /api/documents/:id/chunks/:n         one piece (≤ 3 MB) of the file
 *   POST   /api/documents/:id/complete          check every piece is there, mark the file ready
 *   GET    /api/documents/:id                   details · GET …/chunks/:n  one piece · DELETE  remove
 *   GET|PUT|DELETE /api/drafts/:documentId      unsaved edits of a document
 *   GET|POST /api/history                       log of verified saves
 *
 * Why pieces: a Vercel function accepts and returns at most ~4.5 MB per request.
 * Why a passcode: the site is public, so nothing but the sign-in may open the database.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
                                                                
import { neon } from '@neondatabase/serverless'

export const CHUNK = 3 * 1024 * 1024
export const MAX_FILE = 60 * 1024 * 1024
const MAX_JSON = 4 * 1024 * 1024
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000
/** the only settings the cloud will keep (it is not a general key-value store) */
export const SETTING_KEYS = ['pagedesk-signature', 'pagedesk-draw-style', 'pagedesk-theme', 'pagedesk-ocr-lang', 'pagedesk-flag-threshold', 'pagedesk-find-opts']         

// ------------------------------------------------------------------------------------------- config

                         
             
                  
                
                    
 

export function readConfig(env                    = process.env)                                       {
  const url = env.DATABASE_URL?.trim()
  const passcode = env.APP_PASSCODE?.trim()
  if (!url) return { reason: 'DATABASE_URL is not set' }
  if (!passcode) return { reason: 'APP_PASSCODE is not set' }
  if (passcode.length < 8) return { reason: 'APP_PASSCODE must be at least 8 characters' }
  const schema = (env.DB_SCHEMA ?? 'pagedesk').trim()
  if (!/^[a-z_][a-z0-9_]{0,40}$/.test(schema)) return { reason: 'DB_SCHEMA may only hold lower-case letters, digits and _' }
  return { cfg: { url, passcode, schema, maxLibrary: (Number(env.MAX_LIBRARY_MB) || 400) * 1024 * 1024 } }
}

// ------------------------------------------------------------------------------------------- tokens

const b64u = (b                 ) => Buffer.from(b).toString('base64url')
const signingKey = (cfg        ) => createHash('sha256').update(`pagedesk:v1:${cfg.passcode}`).digest()

/** A signed, expiring token. Changing the passcode invalidates every token. */
export function makeToken(cfg        , now = Date.now())         {
  const payload = b64u(JSON.stringify({ exp: now + TOKEN_TTL_MS }))
  return `v1.${payload}.${b64u(createHmac('sha256', signingKey(cfg)).update(payload).digest())}`
}

export function checkToken(cfg        , token                           , now = Date.now())          {
  const parts = (token ?? '').split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return false
  const want = createHmac('sha256', signingKey(cfg)).update(parts[1]).digest()
  const got = Buffer.from(parts[2], 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false
  try {
    const { exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))                    
    return typeof exp === 'number' && exp > now
  } catch {
    return false
  }
}

function sameSecret(a        , b        )          {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}

// ------------------------------------------------------------------------------------------- database

function ddl(schema        )           {
  const S = `"${schema}"`
  return [
    `create schema if not exists ${S}`,
    `create table if not exists ${S}.documents (
       id uuid primary key default gen_random_uuid(),
       name text not null,
       kind text not null check (kind in ('original','saved','asset')),
       parent_id uuid references ${S}.documents(id) on delete set null,
       size bigint not null check (size > 0),
       sha256 text not null,
       pages integer,
       status text not null default 'uploading' check (status in ('uploading','ready')),
       created_at timestamptz not null default now()
     )`,
    `create unique index if not exists documents_dedupe on ${S}.documents (kind, sha256)`,
    `create table if not exists ${S}.document_chunks (
       document_id uuid not null references ${S}.documents(id) on delete cascade,
       n integer not null,
       data bytea not null,
       primary key (document_id, n)
     )`,
    `create table if not exists ${S}.drafts (
       document_id uuid primary key references ${S}.documents(id) on delete cascade,
       state jsonb not null,
       edit_count integer not null default 0,
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${S}.save_log (
       id bigserial primary key,
       saved_at timestamptz not null default now(),
       file_name text not null,
       document_id uuid references ${S}.documents(id) on delete set null,
       pages integer,
       size bigint,
       edit_count integer not null default 0,
       summary jsonb not null default '{}'::jsonb,
       verified boolean not null,
       collateral integer not null default 0,
       note text
     )`,
    `create table if not exists ${S}.settings (
       key text primary key,
       value jsonb not null,
       updated_at timestamptz not null default now()
     )`,
    `create table if not exists ${S}.auth_attempts (
       id bigserial primary key,
       ip text not null,
       at timestamptz not null default now()
     )`,
    `create index if not exists auth_attempts_ip on ${S}.auth_attempts (ip, at)`,
  ]
}

                                  
              
                                                         
                                                                           
                             
 

const ensured = new Map                       ()

function connect(cfg        )     {
  const sql = neon(cfg.url)
  return {
    q: (text, params = []) => sql.query(text, params)                  ,
    tx: async (statements) => void (await sql.transaction(statements.map((s) => sql.query(s.text, s.params ?? [])))),
    t: (name) => `"${cfg.schema}"."${name}"`,
  }
}

/** Create the tables if they are not there yet (once per server instance). */
export async function ensureSchema(cfg        )                {
  const key = `${cfg.url}|${cfg.schema}`
  let p = ensured.get(key)
  if (!p) {
    p = connect(cfg).tx(ddl(cfg.schema).map((text) => ({ text })))
    ensured.set(key, p)
    p.catch(() => ensured.delete(key))
  }
  return p
}

// ------------------------------------------------------------------------------------------- http

class HttpError extends Error {
  status        
  extra                         
  constructor(status        , message        , extra                          = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

function send(res                , status        , body         , headers                         = {}) {
  const isBytes = Buffer.isBuffer(body)
  const payload = isBytes ? body : Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'content-type': isBytes ? 'application/octet-stream' : 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

/**
 * The whole request body, or a 413 once it passes `limit`. Past the limit the rest is thrown away as it arrives rather
 * than the connection being torn down (which is what leaving a `for await` early does): the sender still gets to read
 * the "too large" answer instead of a reset.
 */
function readBody(req                 , limit        )                  {
  return new Promise((resolve, reject) => {
    let parts           = []
    let total = 0
    let over = false
    req.on('data', (c                 ) => {
      if (over) return
      const b = Buffer.isBuffer(c) ? c : Buffer.from(c)
      total += b.length
      if (total > limit) {
        over = true
        parts = []
        reject(new HttpError(413, 'That is too large to send in one go.'))
        return
      }
      parts.push(b)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

async function readJson                             (req                 , limit = MAX_JSON)             {
  const raw = await readBody(req, limit)
  try {
    const v = JSON.parse(raw.toString('utf8') || '{}')
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object')
    return v     
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const need = (cond         , msg        )       => {
  if (!cond) throw new HttpError(400, msg)
}
const int = (v         )                => (typeof v === 'number' && Number.isInteger(v) ? v : null)
const str = (v         , max        )                => (typeof v === 'string' && v.length <= max ? v : null)
const clientIp = (req                 )         => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown').split(',')[0].trim().slice(0, 64)
const chunksFor = (size        ) => Math.ceil(size / CHUNK)

// ------------------------------------------------------------------------------------------- routes

               
             
        
                      
                     
                        
 
                                                             
                 
                
            
                                                
             
 

const docMeta = (r     ) => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  parentId: r.parent_id ?? null,
  size: Number(r.size),
  sha256: r.sha256,
  pages: r.pages ?? null,
  createdAt: r.created_at,
  chunkSize: CHUNK,
  chunks: chunksFor(Number(r.size)),
})

const routes          = [
  // ------------------------------------------------------------------------------------ sign in
  {
    method: 'POST',
    re: /^\/auth$/,
    open: true,
    fn: async ({ cfg, db, req, res }) => {
      const { passcode } = await readJson                        (req, 4096)
      const ip = clientIp(req)
      // The try is counted *before* it is judged. Counting only afterwards would let a burst of parallel guesses all
      // read "fewer than 8 so far" and be checked; this way at most 8 get through however they arrive.
      await db.q(`insert into ${db.t('auth_attempts')} (ip) values ($1)`, [ip])
      const recent = await db.q(`select count(*)::int as n from ${db.t('auth_attempts')} where ip = $1 and at > now() - interval '15 minutes'`, [ip])
      if (Number(recent[0]?.n) > 8) throw new HttpError(429, 'Too many wrong passcodes. Try again in a few minutes.', { retryAfter: 900 })
      if (typeof passcode !== 'string' || !sameSecret(passcode.trim(), cfg.passcode)) {
        await new Promise((r) => setTimeout(r, 350)) // slows guessing down further
        throw new HttpError(401, 'That passcode is not right.')
      }
      await db.q(`delete from ${db.t('auth_attempts')} where ip = $1 or at < now() - interval '1 day'`, [ip])
      send(res, 200, { token: makeToken(cfg), expiresInDays: TOKEN_TTL_MS / 86400000 })
    },
  },

  // ------------------------------------------------------------------------------------ settings
  {
    method: 'GET',
    re: /^\/settings$/,
    fn: async ({ db, res }) => {
      const rows = await db.q(`select key, value, updated_at from ${db.t('settings')}`)
      send(res, 200, { settings: Object.fromEntries(rows.map((r) => [r.key, r.value])), updatedAt: Object.fromEntries(rows.map((r) => [r.key, r.updated_at])) })
    },
  },
  {
    method: 'PUT',
    re: /^\/settings$/,
    fn: async ({ db, req, res }) => {
      const { settings } = await readJson                                        (req, 1024 * 1024)
      need(settings && typeof settings === 'object', 'Send { "settings": { … } }.')
      const entries = Object.entries(settings )
      for (const [k, v] of entries) {
        need((SETTING_KEYS                     ).includes(k), `“${k}” is not a setting the cloud keeps.`)
        need(JSON.stringify(v ?? null).length <= 200_000, `The setting “${k}” is too large.`)
      }
      await db.tx(entries.map(([k, v]) => ({ text: `insert into ${db.t('settings')} (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`, params: [k, JSON.stringify(v ?? null)] })))
      send(res, 200, { saved: entries.length })
    },
  },

  // ---------------------------------------------------------------------------------- documents
  {
    method: 'GET',
    re: /^\/documents$/,
    fn: async ({ db, res }) => {
      // interrupted uploads older than a day are rubbish
      await db.q(`delete from ${db.t('documents')} where status = 'uploading' and created_at < now() - interval '1 day'`)
      const rows = await db.q(
        `select d.id, d.name, d.kind, d.parent_id, d.size, d.sha256, d.pages, d.created_at, dr.updated_at as draft_updated_at, dr.edit_count as draft_edits
           from ${db.t('documents')} d left join ${db.t('drafts')} dr on dr.document_id = d.id
          where d.status = 'ready' order by d.created_at desc limit 300`,
      )
      const used = await db.q(`select coalesce(sum(size), 0)::bigint as s from ${db.t('documents')}`)
      send(res, 200, {
        documents: rows.map((r) => ({ ...docMeta(r), draft: r.draft_updated_at ? { updatedAt: r.draft_updated_at, edits: Number(r.draft_edits) } : null })),
        usedBytes: Number(used[0]?.s ?? 0),
      })
    },
  },
  {
    method: 'POST',
    re: /^\/documents$/,
    fn: async ({ cfg, db, req, res }) => {
      const b = await readJson(req, 16 * 1024)
      const name = str(b.name, 255)
      const kind = b.kind
      const size = int(b.size)
      const sha = typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/.test(b.sha256) ? b.sha256 : null
      const pages = b.pages == null ? null : int(b.pages)
      const parent = b.parentId == null ? null : typeof b.parentId === 'string' && UUID.test(b.parentId) ? b.parentId : 'bad'
      need(name && name.trim(), 'The file needs a name.')
      need(kind === 'original' || kind === 'saved' || kind === 'asset', 'kind must be original, saved or asset.')
      need(size !== null && size > 0, 'size must be a positive whole number.')
      need(size  <= MAX_FILE, `Files over ${MAX_FILE / 1024 / 1024} MB are not accepted.`)
      need(sha, 'sha256 must be 64 hex characters.')
      need(b.pages == null || pages !== null, 'pages must be a whole number.')
      need(pages === null || (pages >= 0 && pages < 100000), 'pages is out of range.')
      need(parent !== 'bad', 'parentId must be an id.')
      // a parent that is not there is refused whether or not the same bytes were stored before
      if (parent) need((await db.q(`select 1 from ${db.t('documents')} where id = $1`, [parent])).length, 'The parent file is not in the library.')

      const found = await db.q(`select id, status, size from ${db.t('documents')} where kind = $1 and sha256 = $2`, [kind, sha])
      let id        
      if (found.length) {
        need(Number(found[0].size) === size, 'A file with that hash but a different size is already stored.')
        id = String(found[0].id)
        if (found[0].status === 'ready') return send(res, 200, { id, existing: true, chunkSize: CHUNK, chunks: chunksFor(Number(found[0].size)), have: [] })
      } else {
        const used = await db.q(`select coalesce(sum(size), 0)::bigint as s from ${db.t('documents')}`)
        if (Number(used[0].s) + size  > cfg.maxLibrary) throw new HttpError(413, `The library is full (${Math.round(cfg.maxLibrary / 1024 / 1024)} MB). Delete something first.`)
        const ins = await db.q(
          `insert into ${db.t('documents')} (name, kind, parent_id, size, sha256, pages) values ($1, $2, $3, $4, $5, $6) on conflict (kind, sha256) do nothing returning id`,
          [name .trim(), kind, parent, size, sha, pages],
        )
        id = String(ins[0]?.id ?? (await db.q(`select id from ${db.t('documents')} where kind = $1 and sha256 = $2`, [kind, sha]))[0].id)
      }
      const have = await db.q(`select n from ${db.t('document_chunks')} where document_id = $1 order by n`, [id])
      send(res, 201, { id, existing: false, chunkSize: CHUNK, chunks: chunksFor(size ), have: have.map((r) => Number(r.n)) })
    },
  },
  {
    method: 'PUT',
    re: /^\/documents\/([0-9a-f-]{36})\/chunks\/(\d{1,5})$/,
    fn: async ({ db, req, res }, m) => {
      if (!UUID.test(m[1])) throw new HttpError(400, 'Not a file id.')
      const n = Number(m[2])
      const doc = await db.q(`select size, status from ${db.t('documents')} where id = $1`, [m[1]])
      if (!doc.length) throw new HttpError(404, 'No such file.')
      const size = Number(doc[0].size)
      if (n >= chunksFor(size)) throw new HttpError(400, 'That piece number is past the end of the file.')
      const want = n < chunksFor(size) - 1 ? CHUNK : size - n * CHUNK
      const body = await readBody(req, CHUNK + 1)
      if (doc[0].status === 'ready') return send(res, 200, { ok: true, skipped: true })
      if (body.length !== want) throw new HttpError(400, `Piece ${n} should be ${want} bytes, not ${body.length}.`)
      await db.q(`insert into ${db.t('document_chunks')} (document_id, n, data) values ($1, $2, $3) on conflict (document_id, n) do update set data = excluded.data`, [m[1], n, body])
      send(res, 200, { ok: true })
    },
  },
  {
    method: 'POST',
    re: /^\/documents\/([0-9a-f-]{36})\/complete$/,
    fn: async ({ db, res }, m) => {
      const doc = await db.q(`select * from ${db.t('documents')} where id = $1`, [m[1]])
      if (!doc.length) throw new HttpError(404, 'No such file.')
      const size = Number(doc[0].size)
      const got = await db.q(`select n, length(data) as len from ${db.t('document_chunks')} where document_id = $1 order by n`, [m[1]])
      const have = got.map((r) => Number(r.n))
      const total = got.reduce((s, r) => s + Number(r.len), 0)
      const missing = Array.from({ length: chunksFor(size) }, (_, i) => i).filter((i) => !have.includes(i))
      if (missing.length || total !== size) throw new HttpError(409, 'Some pieces of the file have not arrived.', { missing })
      if (doc[0].status !== 'ready') {
        // The database hashes the pieces itself (nothing is sent back). Bytes that are not what was declared must never
        // become a file: the same hash is how a later upload is recognised as "already stored".
        const same = await db.q(`select encode(sha256(string_agg(data, ''::bytea order by n)), 'hex') = $2 as same from ${db.t('document_chunks')} where document_id = $1`, [m[1], doc[0].sha256])
        if (!same[0]?.same) {
          await db.q(`delete from ${db.t('document_chunks')} where document_id = $1`, [m[1]]) // so that a retry starts clean
          throw new HttpError(400, 'The bytes that arrived do not match the file’s SHA-256, so it was not stored. Upload it again.')
        }
      }
      await db.q(`update ${db.t('documents')} set status = 'ready' where id = $1`, [m[1]])
      send(res, 200, docMeta({ ...doc[0], status: 'ready' }))
    },
  },
  {
    method: 'GET',
    re: /^\/documents\/([0-9a-f-]{36})$/,
    fn: async ({ db, res }, m) => {
      const doc = await db.q(`select * from ${db.t('documents')} where id = $1 and status = 'ready'`, [m[1]])
      if (!doc.length) throw new HttpError(404, 'No such file.')
      send(res, 200, docMeta(doc[0]))
    },
  },
  {
    method: 'GET',
    re: /^\/documents\/([0-9a-f-]{36})\/chunks\/(\d{1,5})$/,
    fn: async ({ db, res }, m) => {
      const r = await db.q(`select c.data from ${db.t('document_chunks')} c join ${db.t('documents')} d on d.id = c.document_id where c.document_id = $1 and c.n = $2 and d.status = 'ready'`, [m[1], Number(m[2])])
      if (!r.length) throw new HttpError(404, 'No such piece.')
      send(res, 200, Buffer.from(r[0].data          ))
    },
  },
  {
    method: 'DELETE',
    re: /^\/documents\/([0-9a-f-]{36})$/,
    fn: async ({ db, res }, m) => {
      const r = await db.q(`delete from ${db.t('documents')} where id = $1 returning id`, [m[1]])
      if (!r.length) throw new HttpError(404, 'No such file.')
      send(res, 200, { deleted: true })
    },
  },

  // -------------------------------------------------------------------------------------- drafts
  {
    method: 'GET',
    re: /^\/drafts\/([0-9a-f-]{36})$/,
    fn: async ({ db, res }, m) => {
      const r = await db.q(`select state, edit_count, updated_at from ${db.t('drafts')} where document_id = $1`, [m[1]])
      if (!r.length) throw new HttpError(404, 'There is no draft for this file.')
      send(res, 200, { state: r[0].state, editCount: Number(r[0].edit_count), updatedAt: r[0].updated_at })
    },
  },
  {
    method: 'PUT',
    re: /^\/drafts\/([0-9a-f-]{36})$/,
    fn: async ({ db, req, res }, m) => {
      const b = await readJson                                          (req)
      need(b.state && typeof b.state === 'object' && !Array.isArray(b.state), 'Send { "state": { … } }.')
      const count = int(b.editCount) ?? 0
      if (!(await db.q(`select 1 from ${db.t('documents')} where id = $1 and status = 'ready'`, [m[1]])).length) throw new HttpError(404, 'No such file.')
      const r = await db.q(
        `insert into ${db.t('drafts')} (document_id, state, edit_count) values ($1, $2::jsonb, $3) on conflict (document_id) do update set state = excluded.state, edit_count = excluded.edit_count, updated_at = now() returning updated_at`,
        [m[1], JSON.stringify(b.state), count],
      )
      send(res, 200, { savedAt: r[0].updated_at })
    },
  },
  {
    method: 'DELETE',
    re: /^\/drafts\/([0-9a-f-]{36})$/,
    fn: async ({ db, res }, m) => {
      await db.q(`delete from ${db.t('drafts')} where document_id = $1`, [m[1]])
      send(res, 200, { deleted: true })
    },
  },

  // ------------------------------------------------------------------------------------- history
  {
    method: 'GET',
    re: /^\/history$/,
    fn: async ({ db, res, query }) => {
      const limit = Math.min(200, Math.max(1, Number(query.get('limit')) || 30))
      const rows = await db.q(`select id, saved_at, file_name, document_id, pages, size, edit_count, summary, verified, collateral, note from ${db.t('save_log')} order by saved_at desc limit $1`, [limit])
      send(res, 200, {
        history: rows.map((r) => ({ id: Number(r.id), savedAt: r.saved_at, fileName: r.file_name, documentId: r.document_id ?? null, pages: r.pages ?? null, size: r.size == null ? null : Number(r.size), editCount: Number(r.edit_count), summary: r.summary, verified: r.verified, collateral: Number(r.collateral), note: r.note ?? null })),
      })
    },
  },
  {
    method: 'POST',
    re: /^\/history$/,
    fn: async ({ db, req, res }) => {
      const b = await readJson(req, 32 * 1024)
      const fileName = str(b.fileName, 255)
      need(fileName && fileName.trim(), 'fileName is required.')
      need(typeof b.verified === 'boolean', 'verified must be true or false.')
      const doc = b.documentId == null ? null : typeof b.documentId === 'string' && UUID.test(b.documentId) ? b.documentId : 'bad'
      need(doc !== 'bad', 'documentId must be an id.')
      const summary = b.summary && typeof b.summary === 'object' && !Array.isArray(b.summary) ? b.summary : {}
      need(JSON.stringify(summary).length <= 4000, 'summary is too large.')
      const note = b.note == null ? null : str(b.note, 500)
      const docOk = doc ? (await db.q(`select 1 from ${db.t('documents')} where id = $1`, [doc])).length > 0 : false
      const r = await db.q(
        `insert into ${db.t('save_log')} (file_name, document_id, pages, size, edit_count, summary, verified, collateral, note) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9) returning id, saved_at`,
        [fileName .trim(), docOk ? doc : null, int(b.pages), int(b.size), int(b.editCount) ?? 0, JSON.stringify(summary), b.verified, int(b.collateral) ?? 0, note],
      )
      send(res, 201, { id: Number(r[0].id), savedAt: r[0].saved_at })
    },
  },
]

// ------------------------------------------------------------------------------------------- entry

/**
 * The path below /api that was asked for, and the query string without our own helper.
 * On Vercel, vercel.json rewrites every /api/* request to this one function (`/api`) and hands the original path over as
 * `?__p=…`; in `npm run dev` the URL arrives untouched. Either way the same route table answers.
 */
export function apiPath(rawUrl        )                                           {
  const url = new URL(rawUrl || '/', 'http://local')
  let path = url.pathname.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '')
  const forwarded = url.searchParams.get('__p')
  url.searchParams.delete('__p')
  if (path === '' && forwarded) path = '/' + forwarded.replace(/^\/+/, '')
  return { path: path.replace(/\/+$/, '') || '/', query: url.searchParams }
}

export default async function handler(req                 , res                )                {
  try {
    const { path, query } = apiPath(req.url ?? '/')
    const method = (req.method ?? 'GET').toUpperCase()
    const conf = readConfig()
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || null

    if (method === 'GET' && path === '/status') {
      if (!('cfg' in conf)) return send(res, 200, { configured: false, reason: conf.reason, authed: false })
      return send(res, 200, { configured: true, authed: checkToken(conf.cfg, bearer) })
    }
    if (!('cfg' in conf)) throw new HttpError(503, 'The cloud is not set up on this server.', { configured: false })
    const cfg = conf.cfg

    const route = routes.find((r) => r.method === method && r.re.test(path))
    if (!route) {
      if (routes.some((r) => r.re.test(path))) throw new HttpError(405, 'That method is not allowed here.')
      throw new HttpError(404, 'Not found.')
    }
    if (!route.open && !checkToken(cfg, bearer)) throw new HttpError(401, 'Sign in with your passcode first.', { locked: true })
    const m = path.match(route.re) 
    // the first thing any route captures is a file id: one that is not a real UUID (36 dashes fit the pattern) never reaches the database
    if (m[1] !== undefined && !UUID.test(m[1])) throw new HttpError(404, 'No such file.')
    await ensureSchema(cfg)
    await route.fn({ cfg, db: connect(cfg), req, res, query }, m)
  } catch (e) {
    if (e instanceof HttpError) {
      const headers                         = e.extra.retryAfter ? { 'retry-after': String(e.extra.retryAfter) } : {}
      return send(res, e.status, { error: e.message, ...e.extra }, headers)
    }
    console.error('[pagedesk api]', e instanceof Error ? e.message : e)
    send(res, 500, { error: 'Something went wrong on the server.' })
  }
}

/** A random id for tests and tools. */
export const randomId = () => randomBytes(6).toString('hex')
