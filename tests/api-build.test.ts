import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { apiPath } from '../server/cloud.ts'
import { renderApi, TARGET } from '../scripts/build-api.mjs'

// Vercel runs api/index.js, which is generated from server/cloud.ts. These tests make sure what ships is what was
// written and tested — and that it is plain JavaScript that starts up without a database.

test('the committed api/index.js is up to date with server/cloud.ts', () => {
  assert.equal(readFileSync(TARGET, 'utf8'), renderApi(), 'run `npm run build:api` and commit the result')
})

test('it is plain JavaScript: no types left, no relative imports', () => {
  const js = readFileSync(TARGET, 'utf8')
  assert.ok(!/^\s*import type\b/m.test(js) && !/^\s*(export )?interface\b/m.test(js), 'type-only syntax was removed')
  assert.ok(!/from '\.{1,2}\//.test(js), 'everything it needs is inside the file (or a package)')
})

test('apiPath finds the route whether the URL arrives as-is (dev) or rewritten to /api by vercel.json', () => {
  const same = (raw: string, path: string, query: string) => {
    const r = apiPath(raw)
    assert.deepEqual([r.path, r.query.toString()], [path, query], raw)
  }
  same('/api/status', '/status', '')
  same('/api/documents/3f2c/chunks/0', '/documents/3f2c/chunks/0', '')
  same('/api/history?limit=5', '/history', 'limit=5')
  same('/api', '/', '')
  same('/api?__p=documents%2F3f2c%2Fchunks%2F0', '/documents/3f2c/chunks/0', '')
  same('/api?__p=documents/3f2c/chunks/0', '/documents/3f2c/chunks/0', '')
  same('/api?__p=history&limit=5', '/history', 'limit=5')
  same('/api?__p=', '/', '')
  same('/api/status?__p=documents', '/status', '') // a real path wins over the helper
})

test('vercel.json sends every /api/* request to the one function, and nothing else', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(v.functions), ['api/index.js'])
  assert.deepEqual(v.rewrites, [{ source: '/api/:path*', destination: '/api?__p=:path*' }])
})

test('the generated function answers like the source: unconfigured → off; configured but signed out → locked', async () => {
  const mod = await import(pathToFileURL(TARGET).href)
  const saved = { url: process.env.DATABASE_URL, pass: process.env.APP_PASSCODE }
  const server = createServer((req, res) => void mod.default(req, res))
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    delete process.env.DATABASE_URL
    delete process.env.APP_PASSCODE
    const off = await (await fetch(base + '/api/status')).json()
    assert.equal(off.configured, false)

    // a made-up database address is fine: neither of these routes may reach the database
    process.env.DATABASE_URL = 'postgresql://nobody:nothing@127.0.0.1:9/none'
    process.env.APP_PASSCODE = 'a-long-test-passcode'
    const on = await (await fetch(base + '/api/status')).json()
    assert.deepEqual(on, { configured: true, authed: false })
    const res = await fetch(base + '/api/documents')
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal((await res.json()).locked, true)

    const cfg = mod.readConfig(process.env).cfg
    const token = mod.makeToken(cfg)
    assert.equal((await (await fetch(base + '/api/status', { headers: { authorization: `Bearer ${token}` } })).json()).authed, true)
  } finally {
    await new Promise((ok) => server.close(ok))
    if (saved.url === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved.url
    if (saved.pass === undefined) delete process.env.APP_PASSCODE
    else process.env.APP_PASSCODE = saved.pass
  }
})
