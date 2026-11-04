// Web Worker host: all MuPDF work happens here so the UI thread never blocks on a big page.
import { PdfEngine } from './engine.ts'

const loadFont = async (file: string) => {
  const res = await fetch(`${import.meta.env.BASE_URL}fonts/${file}`)
  if (!res.ok) throw new Error(`Could not load font ${file} (${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

const engine = new PdfEngine(loadFont)

const METHODS = new Set(['open', 'analyze', 'getRuns', 'render', 'renderClip', 'renderPng', 'measure', 'export', 'addUserFont', 'dispose'])

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
    if (!METHODS.has(method)) throw new Error(`Unknown method ${method}`)
    const fn = (engine as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
    const result = (await fn.apply(engine, args)) as Record<string, unknown> | undefined
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
