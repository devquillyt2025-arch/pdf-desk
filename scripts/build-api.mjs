// Writes api/index.js — the plain-JavaScript function Vercel runs — from its typed source, server/cloud.ts.
//
// Why not let Vercel compile the .ts itself? Its Node builder calls the project's own `typescript` package, and
// TypeScript 7 (the native compiler) no longer has the JavaScript API that builder needs, so the build fails.
// The source is written to be "erasable" (no enums, no parameter properties), so removing the types is all it takes.
//
//   node scripts/build-api.mjs           write the file
//   node scripts/build-api.mjs --check   fail if the committed file is out of date (tests run this)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE = resolve(root, 'server/cloud.ts')
export const TARGET = resolve(root, 'api/index.js')

const HEADER = `// GENERATED from server/cloud.ts by scripts/build-api.mjs — edit that file, not this one.
// (Vercel's Node builder cannot compile TypeScript 7, so the function is shipped as plain JavaScript.)
`

export function renderApi() {
  const ts = readFileSync(SOURCE, 'utf8')
  // 'strip' blanks the types out in place, so line numbers in stack traces still match the source
  const js = stripTypeScriptTypes(ts, { mode: 'strip' })
  return HEADER + js
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = renderApi()
  if (process.argv.includes('--check')) {
    let have = ''
    try {
      have = readFileSync(TARGET, 'utf8')
    } catch {
      /* missing */
    }
    if (have !== out) {
      console.error('api/index.js is out of date. Run: npm run build:api')
      process.exit(1)
    }
    console.log('api/index.js is up to date')
  } else {
    mkdirSync(dirname(TARGET), { recursive: true })
    writeFileSync(TARGET, out)
    console.log(`wrote ${TARGET.replace(root, '.')} (${out.length} bytes)`)
  }
}
