// Web Worker host: all MuPDF work happens here so the UI thread never blocks on a big page.
import { PdfEngine } from './engine.ts'
import { PdfTools } from './tools.ts'

const loadFont = async (file: string) => {
  const res = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`)
  if (!res.ok) throw new Error(`Could not load font ${file} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

const engine = new PdfEngine(loadFont)
const tools = new PdfTools(engine.book)

const METHODS = new Set(['open', 'analyze', 'getRuns', 'render', 'renderClip', 'renderPng', 'measure', 'export', 'addUserFont', 'addImage', 'detectTable', 'inferTable', 'fitTable', 'dispose'])
// Stateless utilities are addressed as "tool:<name>" so they can never collide with the editing session.
const TOOL_METHODS = new Set(['inspect', 'merge', 'rebuild', 'imagesToPdf', 'protect', 'unlock', 'stamp', 'stampPreview'])

interface Call {
  id: number
  method: string
  args: unknown[]
}

const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((ev: MessageEvent<Call>) => void) | null
}

ctx.onmessage = async (ev) => {
  const { id, method, args } = ev.data
  try {
    let target: object = engine
    let name = method
    if (method.startsWith('tool:')) {
      name = method.slice(5)
      if (!TOOL_METHODS.has(name)) throw new Error(`Unknown tool ${name}`)
      target = tools
    } else if (!METHODS.has(method)) throw new Error(`Unknown method ${method}`)
    const fn = (target as unknown as Record<string, (...a: unknown[]) => unknown>)[name]
    const result = (await fn.apply(target, args)) as Record<string, unknown> | undefined
    const transfer: Transferable[] = []
    if (result && typeof result === 'object') {
      for (const k of ['rgba', 'png', 'bytes']) {
        const v = result[k]
        if (v && ArrayBuffer.isView(v)) transfer.push(v.buffer as ArrayBuffer)
      }
    }
    ctx.postMessage({ id, ok: true, result }, transfer)
  } catch (e) {
    ctx.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
}

// Importing MuPDF awaits its WASM module, and a message that arrives before `onmessage` is set is dropped.
// So the client holds its calls until this worker announces that it is listening.
ctx.postMessage({ ready: true })
