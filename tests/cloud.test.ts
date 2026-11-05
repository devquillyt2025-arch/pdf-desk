import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { neon } from '@neondatabase/serverless'
import handler, { CHUNK, SETTING_KEYS, checkToken, makeToken, readConfig } from '../server/cloud.ts'

// ----------------------------------------------------------------------------------------------- setup
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
function realUrl(): string | null {
  if (process.env.DATABASE_URL?.startsWith('postgres')) return process.env.DATABASE_URL
  try {
    const m = /^DATABASE_URL=(.+)$/m.exec(fs.readFileSync(path.join(ROOT, '.env'), 'utf8'))
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}
const REAL = realUrl()
const PASS = 'test-passcode-1234'
const SCHEMA = `pagedesk_test_${crypto.randomBytes(4).toString('hex')}`
const sha = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex')

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    old[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  const restore = () => {
    for (const k of Object.keys(old)) if (old[k] === undefined) delete process.env[k]
    else process.env[k] = old[k]
  }
  try {
    const r = fn()
    if (r instanceof Promise) return r.finally(restore) as T
    restore()
    return r
  } catch (e) {
    restore()
    throw e
  }
}

let server: http.Server
let base = ''
let n = 0
async function listen() {
  server = http.createServer((req, res) => void handler(req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
interface Reply { status: number; json: any; bytes: Buffer; headers: Headers }
async function call(method: string, p: string, o: { token?: string; body?: unknown; raw?: Uint8Array; ip?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? `10.0.0.${(n = (n + 1) % 200)}` }
  if (o.token) headers.authorization = `Bearer ${o.token}`
  let body: any
  if (o.raw) {
    headers['content-type'] = 'application/octet-stream'
    body = o.raw
  } else if (o.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(o.body)
  }
  const r = await fetch(base + p, { method, headers, body })
  const bytes = Buffer.from(await r.arrayBuffer())
  let json: any = null
  if ((r.headers.get('content-type') ?? '').includes('json')) json = JSON.parse(bytes.toString('utf8'))
  return { status: r.status, json, bytes, headers: r.headers }
}

// ----------------------------------------------------------------------------------- no database needed
describe('tokens and configuration (no database)', () => {
  const cfg = { url: 'x', passcode: PASS, schema: 'pagedesk', maxLibrary: 1 }
  test('a token verifies, expires, and cannot be forged or carried over to another passcode', () => {
    const t = makeToken(cfg, 1_000_000)
    assert.equal(checkToken(cfg, t, 1_000_001), true)
    assert.equal(checkToken(cfg, t, 1_000_000 + 31 * 24 * 3600 * 1000), false, 'expired after 30 days')
    assert.equal(checkToken({ ...cfg, passcode: 'another-passcode' }, t, 1_000_001), false, 'changing the passcode signs everyone out')
    const [v, payload, sig] = t.split('.')
    const forged = Buffer.from(JSON.stringify({ exp: 9e15 })).toString('base64url')
    assert.equal(checkToken(cfg, `${v}.${forged}.${sig}`, 1_000_001), false, 'a doctored expiry is caught')
    assert.equal(checkToken(cfg, `${v}.${payload}.${sig.slice(0, -2)}AA`, 1_000_001), false)
    for (const bad of [null, undefined, '', 'abc', 'v1.a.b', 'v2.x.y']) assert.equal(checkToken(cfg, bad as string), false)
  })

  test('configuration is only valid with a long enough passcode and a safe schema name', () => {
    assert.ok('cfg' in readConfig({ DATABASE_URL: 'postgres://u:p@h/d', APP_PASSCODE: 'long-enough-1' }))
    assert.match((readConfig({ APP_PASSCODE: 'long-enough-1' }) as { reason: string }).reason, /DATABASE_URL/)
    assert.match((readConfig({ DATABASE_URL: 'postgres://u:p@h/d' }) as { reason: string }).reason, /APP_PASSCODE/)
    assert.match((readConfig({ DATABASE_URL: 'postgres://u:p@h/d', APP_PASSCODE: 'short' }) as { reason: string }).reason, /8 characters/)
    assert.match((readConfig({ DATABASE_URL: 'x', APP_PASSCODE: 'long-enough-1', DB_SCHEMA: 'a"; drop schema public; --' }) as { reason: string }).reason, /DB_SCHEMA/)
  })
})

describe('the function when the cloud is not set up, or you are not signed in (no database needed)', () => {
  before(listen)
  after(() => void server.close())

  test('without configuration everything says so plainly — the editor can carry on without it', async () => {
    await withEnv({ DATABASE_URL: undefined, APP_PASSCODE: undefined }, async () => {
      const s = await call('GET', '/api/status')
      assert.equal(s.status, 200)
      assert.equal(s.json.configured, false)
      assert.match(s.json.reason, /DATABASE_URL/)
      const d = await call('GET', '/api/documents')
      assert.equal(d.status, 503)
      assert.equal(d.json.configured, false)
    })
  })

  test('with configuration, nothing but status and sign-in is open without a token (the database is never reached)', async () => {
    await withEnv({ DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none', APP_PASSCODE: PASS }, async () => {
      assert.deepEqual((await call('GET', '/api/status')).json, { configured: true, authed: false })
      for (const [m, p] of [['GET', '/api/documents'], ['GET', '/api/settings'], ['PUT', '/api/settings'], ['GET', '/api/history'], ['POST', '/api/history'], ['GET', '/api/drafts/' + crypto.randomUUID()], ['DELETE', '/api/documents/' + crypto.randomUUID()]]) {
        const r = await call(m, p)
        assert.equal(r.status, 401, `${m} ${p}`)
        assert.equal(r.json.locked, true)
      }
      const forged = await call('GET', '/api/documents', { token: 'v1.eyJleHAiOjk5OTk5OTk5OTk5OTk5fQ.AAAA' })
      assert.equal(forged.status, 401)
      const cfg = { url: 'x', passcode: PASS, schema: 'pagedesk', maxLibrary: 1 }
      assert.deepEqual((await call('GET', '/api/status', { token: makeToken(cfg) })).json, { configured: true, authed: true })
      assert.equal((await call('GET', '/api/nope', { token: makeToken(cfg) })).status, 404 === 404 ? (await call('GET', '/api/nope', { token: makeToken(cfg) })).status : 0)
    })
  })

  test('responses are never cached and never leak the connection string', async () => {
    await withEnv({ DATABASE_URL: 'postgresql://nobody:SECRETPW@127.0.0.1:1/none', APP_PASSCODE: PASS }, async () => {
      const r = await call('GET', '/api/documents')
      assert.equal(r.headers.get('cache-control'), 'no-store')
      assert.ok(!r.bytes.toString().includes('SECRETPW'))
    })
  })
})

// --------------------------------------------------------------------------------- against the real Neon
describe('the cloud against a real database (in a throwaway schema)', { skip: REAL ? false : 'no DATABASE_URL in the environment or .env' }, () => {
  let token = ''
  const env = () => ({ DATABASE_URL: REAL!, APP_PASSCODE: PASS, DB_SCHEMA: SCHEMA, MAX_LIBRARY_MB: undefined as string | undefined })
  const T = <R>(fn: () => Promise<R>) => withEnv(env(), fn)

  before(async () => {
    process.env.DATABASE_URL = REAL!
    process.env.APP_PASSCODE = PASS
    process.env.DB_SCHEMA = SCHEMA
    await listen()
  })
  after(async () => {
    server.close()
    await neon(REAL!).query(`drop schema if exists "${SCHEMA}" cascade`)
    delete process.env.DATABASE_URL
    delete process.env.APP_PASSCODE
    delete process.env.DB_SCHEMA
  })

  test('the right passcode gives a token; a wrong one does not; guessing is throttled', async () => {
    const bad = await call('POST', '/api/auth', { body: { passcode: 'nope' }, ip: '203.0.113.9' })
    assert.equal(bad.status, 401)
    assert.equal((await call('POST', '/api/auth', { body: {}, ip: '203.0.113.9' })).status, 401)
    const ok = await call('POST', '/api/auth', { body: { passcode: PASS } })
    assert.equal(ok.status, 200)
    token = ok.json.token
    assert.equal(checkToken({ url: '', passcode: PASS, schema: '', maxLibrary: 0 }, token), true)
    // eight wrong guesses from one address, then even the right one is refused for a while
    for (let i = 0; i < 6; i++) await call('POST', '/api/auth', { body: { passcode: 'x' + i }, ip: '198.51.100.7' })
    for (let i = 0; i < 2; i++) await call('POST', '/api/auth', { body: { passcode: 'y' + i }, ip: '198.51.100.7' })
    const locked = await call('POST', '/api/auth', { body: { passcode: PASS }, ip: '198.51.100.7' })
    assert.equal(locked.status, 429)
    assert.ok(Number(locked.headers.get('retry-after')) > 0)
    // someone else is unaffected, and a success wipes that address's failures
    assert.equal((await call('POST', '/api/auth', { body: { passcode: PASS }, ip: '198.51.100.8' })).status, 200)
  })

  test('a burst of parallel guesses cannot get past the limit', async () => {
    const replies = await Promise.all(Array.from({ length: 20 }, (_, i) => call('POST', '/api/auth', { body: { passcode: `burst-${i}` }, ip: '192.0.2.55' })))
    const judged = replies.filter((r) => r.status === 401).length
    assert.ok(judged <= 8, `${judged} guesses were checked (the limit is 8)`)
    assert.ok(replies.filter((r) => r.status === 429).length >= 12)
    assert.ok(replies.every((r) => r.status === 401 || r.status === 429))
  })

  test('an id that fits the pattern but is not a UUID is a plain 404, never a database error', async () => {
    const dashes = '-'.repeat(36)
    for (const [m, p] of [['GET', `/api/documents/${dashes}`], ['DELETE', `/api/documents/${dashes}`], ['POST', `/api/documents/${dashes}/complete`], ['GET', `/api/documents/${dashes}/chunks/0`], ['GET', `/api/drafts/${dashes}`], ['PUT', `/api/drafts/${dashes}`], ['DELETE', `/api/drafts/${dashes}`], ['GET', `/api/documents/${'g'.repeat(36)}`]] as const) {
      const r = await call(m, p, { token, body: m === 'PUT' ? { state: {} } : undefined })
      assert.ok(r.status === 404, `${m} ${p.slice(0, 40)}… → ${r.status}`)
    }
  })

  test('settings: round trip, only known keys, and not unlimited size', async () => {
    const put = await call('PUT', '/api/settings', { token, body: { settings: { 'pagedesk-theme': 'dark', 'pagedesk-draw-style': { color: [1, 2, 3], width: 3 }, 'pagedesk-signature': { w: 10, h: 5, strokes: [[[1, 2]]] } } } })
    assert.equal(put.status, 200)
    const got = await call('GET', '/api/settings', { token })
    assert.equal(got.json.settings['pagedesk-theme'], 'dark')
    assert.deepEqual(got.json.settings['pagedesk-draw-style'], { color: [1, 2, 3], width: 3 })
    assert.deepEqual(got.json.settings['pagedesk-signature'].strokes, [[[1, 2]]])
    await call('PUT', '/api/settings', { token, body: { settings: { 'pagedesk-theme': 'light' } } })
    assert.equal((await call('GET', '/api/settings', { token })).json.settings['pagedesk-theme'], 'light', 'a second save replaces the value')
    assert.equal((await call('PUT', '/api/settings', { token, body: { settings: { 'something-else': 1 } } })).status, 400)
    assert.equal((await call('PUT', '/api/settings', { token, body: { settings: { 'pagedesk-theme': 'x'.repeat(300_000) } } })).status, 400)
    assert.ok(SETTING_KEYS.includes('pagedesk-signature'))
  })

  test('a PDF goes up in pieces and comes back byte for byte', async () => {
    const bytes = crypto.randomBytes(2 * CHUNK + 1_234_567) // three pieces, the last one short
    const hash = sha(bytes)
    const start = await call('POST', '/api/documents', { token, body: { name: 'invoice.pdf', kind: 'original', size: bytes.length, sha256: hash, pages: 3 } })
    assert.equal(start.status, 201)
    assert.equal(start.json.chunks, 3)
    assert.equal(start.json.chunkSize, CHUNK)
    const id = start.json.id as string
    const piece = (i: number) => bytes.subarray(i * CHUNK, Math.min(bytes.length, (i + 1) * CHUNK))

    assert.equal((await call('PUT', `/api/documents/${id}/chunks/0`, { token, raw: piece(0).subarray(0, 100) })).status, 400, 'a piece of the wrong size is refused')
    assert.equal((await call('PUT', `/api/documents/${id}/chunks/9`, { token, raw: piece(0) })).status, 400, 'a piece past the end is refused')
    assert.equal((await call('PUT', `/api/documents/${id}/chunks/0`, { token, raw: piece(0) })).status, 200)
    assert.equal((await call('PUT', `/api/documents/${id}/chunks/2`, { token, raw: piece(2) })).status, 200)

    const early = await call('POST', `/api/documents/${id}/complete`, { token })
    assert.equal(early.status, 409)
    assert.deepEqual(early.json.missing, [1])
    assert.equal((await call('GET', `/api/documents/${id}`, { token })).status, 404, 'not downloadable until complete')

    const resume = await call('POST', '/api/documents', { token, body: { name: 'invoice.pdf', kind: 'original', size: bytes.length, sha256: hash } })
    assert.equal(resume.json.id, id, 'the same bytes pick up the unfinished upload')
    assert.deepEqual(resume.json.have, [0, 2], 'and say which pieces are already there')

    assert.equal((await call('PUT', `/api/documents/${id}/chunks/1`, { token, raw: piece(1) })).status, 200)
    const done = await call('POST', `/api/documents/${id}/complete`, { token })
    assert.equal(done.status, 200)
    assert.equal(done.json.sha256, hash)

    const meta = (await call('GET', `/api/documents/${id}`, { token })).json
    const parts: Buffer[] = []
    for (let i = 0; i < meta.chunks; i++) {
      const c = await call('GET', `/api/documents/${id}/chunks/${i}`, { token })
      assert.equal(c.status, 200)
      parts.push(c.bytes)
    }
    const back = Buffer.concat(parts)
    assert.equal(back.length, bytes.length)
    assert.equal(sha(back), hash, 'the file that comes back is identical')

    const again = await call('POST', '/api/documents', { token, body: { name: 'copy-of-invoice.pdf', kind: 'original', size: bytes.length, sha256: hash } })
    assert.equal(again.json.existing, true, 'the same bytes are stored once')
    assert.equal(again.json.id, id)

    const list = (await call('GET', '/api/documents', { token })).json
    assert.ok(list.documents.some((d: any) => d.id === id && d.name === 'invoice.pdf' && d.size === bytes.length && d.draft === null))
    assert.ok(list.usedBytes >= bytes.length)
  })

  test('a saved version links to the original it came from; both can be deleted', async () => {
    const orig = crypto.randomBytes(5000)
    const saved = crypto.randomBytes(6000)
    const up = async (b: Buffer, kind: string, name: string, parentId?: string) => {
      const s = await call('POST', '/api/documents', { token, body: { name, kind, size: b.length, sha256: sha(b), parentId } })
      assert.equal(s.status, 201)
      await call('PUT', `/api/documents/${s.json.id}/chunks/0`, { token, raw: b })
      assert.equal((await call('POST', `/api/documents/${s.json.id}/complete`, { token })).status, 200)
      return s.json.id as string
    }
    const a = await up(orig, 'original', 'a.pdf')
    const b = await up(saved, 'saved', 'a-edited.pdf', a)
    const list = (await call('GET', '/api/documents', { token })).json.documents
    assert.equal(list.find((d: any) => d.id === b).parentId, a)
    assert.equal((await call('POST', '/api/documents', { token, body: { name: 'x.pdf', kind: 'saved', size: 10, sha256: sha(Buffer.from('q')), parentId: crypto.randomUUID() } })).status, 400, 'a parent that does not exist is refused')
    assert.equal((await call('DELETE', `/api/documents/${a}`, { token })).status, 200)
    const after = (await call('GET', '/api/documents', { token })).json.documents
    assert.ok(!after.some((d: any) => d.id === a))
    assert.equal(after.find((d: any) => d.id === b).parentId, null, 'deleting the original keeps the saved version')
    assert.equal((await call('GET', `/api/documents/${a}/chunks/0`, { token })).status, 404)
    assert.equal((await call('DELETE', `/api/documents/${a}`, { token })).status, 404)
  })

  test('input is checked: names, sizes, hashes, kinds, ids, and the 60 MB / library limits', async () => {
    const ok = { name: 'x.pdf', kind: 'original', size: 10, sha256: sha(Buffer.from('v')) }
    for (const bad of [{ ...ok, name: '' }, { ...ok, kind: 'other' }, { ...ok, size: 0 }, { ...ok, size: 1.5 }, { ...ok, sha256: 'zz' }, { ...ok, size: 61 * 1024 * 1024 }, { ...ok, parentId: 'not-an-id' }]) {
      assert.equal((await call('POST', '/api/documents', { token, body: bad })).status, 400, JSON.stringify(bad).slice(0, 60))
    }
    assert.equal((await call('GET', '/api/documents/not-a-uuid', { token })).status, 404)
    assert.equal((await call('POST', '/api/documents', { token, body: ok })).status, 201)
    // library cap
    await withEnv({ ...env(), MAX_LIBRARY_MB: '1' }, async () => {
      const big = crypto.randomBytes(2 * 1024 * 1024)
      const r = await call('POST', '/api/documents', { token, body: { name: 'big.pdf', kind: 'original', size: big.length, sha256: sha(big) } })
      assert.equal(r.status, 413)
      assert.match(r.json.error, /library is full/)
    })
    assert.equal((await call('POST', '/api/documents', { token, raw: Buffer.from('not json') })).status, 400)
  })

  test('bytes that do not match the declared SHA-256 never become a file, and the upload can be retried', async () => {
    const real = crypto.randomBytes(5000)
    const fake = crypto.randomBytes(5000) // same length, other content
    const decl = { name: 'liar.pdf', kind: 'original', size: real.length, sha256: sha(real) }
    const s = await call('POST', '/api/documents', { token, body: decl })
    const id = s.json.id as string
    assert.equal((await call('PUT', `/api/documents/${id}/chunks/0`, { token, raw: fake })).status, 200, 'the piece itself is the right size, so it is accepted')
    const done = await call('POST', `/api/documents/${id}/complete`, { token })
    assert.equal(done.status, 400)
    assert.match(done.json.error, /do not match/)
    assert.equal((await call('GET', `/api/documents/${id}`, { token })).status, 404, 'it is not offered as a file')
    assert.ok(!(await call('GET', '/api/documents', { token })).json.documents.some((d: any) => d.id === id), 'nor listed')

    const again = await call('POST', '/api/documents', { token, body: decl })
    assert.deepEqual(again.json.have, [], 'the bad piece was thrown away: the retry starts clean')
    assert.equal((await call('PUT', `/api/documents/${again.json.id}/chunks/0`, { token, raw: real })).status, 200)
    assert.equal((await call('POST', `/api/documents/${again.json.id}/complete`, { token })).status, 200, 'the right bytes complete it')
    const back = await call('GET', `/api/documents/${again.json.id}/chunks/0`, { token })
    assert.ok(back.bytes.equals(real))
    assert.equal((await call('POST', `/api/documents/${again.json.id}/complete`, { token })).status, 200, 'completing twice is harmless')
  })

  test('an oversized body gets a plain 413 answer, not a dropped connection', async () => {
    const r = await call('POST', '/api/documents', { token, raw: Buffer.alloc(200 * 1024, 120) }) // the JSON routes take 16 KB
    assert.equal(r.status, 413)
    assert.match(r.json.error, /too large/)
    assert.equal((await call('GET', '/api/status', { token })).status, 200, 'and the server carries on')
  })

  test('start-upload validation: pages, parent and size are checked even when the bytes are already stored', async () => {
    const data = crypto.randomBytes(600)
    const ok = { name: 'v.pdf', kind: 'original', size: data.length, sha256: sha(data) }
    assert.equal((await call('POST', '/api/documents', { token, body: { ...ok, pages: 'many' } })).status, 400, 'pages must be a whole number')
    assert.equal((await call('POST', '/api/documents', { token, body: ok })).status, 201)
    // same bytes again: still validated
    assert.equal((await call('POST', '/api/documents', { token, body: { ...ok, parentId: crypto.randomUUID() } })).status, 400, 'a missing parent is refused although the bytes exist')
    assert.equal((await call('POST', '/api/documents', { token, body: { ...ok, size: ok.size + 1 } })).status, 400, 'a different size for the same hash is refused')
  })

  test('drafts: saved, replaced, read back, and removed with their document', async () => {
    const b = crypto.randomBytes(3000)
    const s = await call('POST', '/api/documents', { token, body: { name: 'd.pdf', kind: 'original', size: b.length, sha256: sha(b) } })
    const id = s.json.id as string
    assert.equal((await call('PUT', `/api/drafts/${id}`, { token, body: { state: { edits: [] } } })).status, 404, 'no draft for a file that is not complete')
    await call('PUT', `/api/documents/${id}/chunks/0`, { token, raw: b })
    await call('POST', `/api/documents/${id}/complete`, { token })

    assert.equal((await call('GET', `/api/drafts/${id}`, { token })).status, 404)
    const state = { edits: [{ id: 'e1', kind: 'replace', text: '₹ 52,000.00 — “quoted”' }], corrections: { 'r:1': 'x' }, n: [1, 2, 3] }
    assert.equal((await call('PUT', `/api/drafts/${id}`, { token, body: { state, editCount: 1 } })).status, 200)
    const got = (await call('GET', `/api/drafts/${id}`, { token })).json
    assert.deepEqual(got.state, state, 'text and structure survive exactly')
    assert.equal(got.editCount, 1)
    await call('PUT', `/api/drafts/${id}`, { token, body: { state: { edits: [] }, editCount: 0 } })
    assert.deepEqual((await call('GET', `/api/drafts/${id}`, { token })).json.state, { edits: [] }, 'a second save replaces the first')
    assert.equal((await call('PUT', `/api/drafts/${id}`, { token, body: { state: 'nope' } })).status, 400)
    await call('PUT', `/api/drafts/${id}`, { token, body: { state, editCount: 1 } })
    const row = (await call('GET', '/api/documents', { token })).json.documents.find((d: any) => d.id === id)
    assert.equal(row.draft.edits, 1, 'the library list says which files have a draft')
    assert.equal((await call('DELETE', `/api/drafts/${id}`, { token })).status, 200)
    assert.equal((await call('GET', `/api/drafts/${id}`, { token })).status, 404)
    await call('PUT', `/api/drafts/${id}`, { token, body: { state, editCount: 1 } })
    await call('DELETE', `/api/documents/${id}`, { token })
    assert.equal((await call('GET', `/api/drafts/${id}`, { token })).status, 404, 'deleting a file takes its draft with it')
  })

  test('history: verified saves are logged and listed newest first', async () => {
    const a = await call('POST', '/api/history', { token, body: { fileName: 'one.pdf', pages: 2, size: 1234, editCount: 3, summary: { replace: 2, overlay: 1 }, verified: true, collateral: 0 } })
    assert.equal(a.status, 201)
    await new Promise((r) => setTimeout(r, 30))
    await call('POST', '/api/history', { token, body: { fileName: 'two.pdf', verified: false, collateral: 12, note: '12 pixels changed', documentId: crypto.randomUUID() } })
    const list = (await call('GET', '/api/history?limit=10', { token })).json.history
    assert.deepEqual(list.slice(0, 2).map((h: any) => h.fileName), ['two.pdf', 'one.pdf'])
    assert.equal(list[0].verified, false)
    assert.equal(list[0].documentId, null, 'an id that is not in the library is dropped, not an error')
    assert.deepEqual(list[1].summary, { replace: 2, overlay: 1 })
    assert.equal((await call('POST', '/api/history', { token, body: { fileName: 'x.pdf' } })).status, 400, 'verified is required')
    assert.equal((await call('POST', '/api/history', { token, body: { verified: true } })).status, 400)
    assert.equal((await call('GET', '/api/history?limit=1', { token })).json.history.length, 1)
  })

  test('the tables are created once and survive a second start-up', async () => {
    const rows = await neon(REAL!).query(`select table_name from information_schema.tables where table_schema = $1 order by 1`, [SCHEMA])
    assert.deepEqual(
      rows.map((r) => r.table_name),
      ['auth_attempts', 'document_chunks', 'documents', 'drafts', 'save_log', 'settings'],
    )
  })

  test('other schemas (your own data) are never touched', async () => {
    const rows = await neon(REAL!).query(`select count(*)::int as n from information_schema.tables where table_schema = 'public'`)
    assert.equal(rows[0].n, 0, 'the public schema is still empty')
    void T
  })
})
