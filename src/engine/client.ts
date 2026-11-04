import type { Edit, ExportOptions, ExportResult, FontStyle, OpenResult, PageInfo, PngResult, Rect, RenderResult, TextLayer, TextRun } from './types.ts'

/** Typed promise-based proxy to the engine worker. */
export class EngineClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
      const p = this.pending.get(ev.data.id)
      if (!p) return
      this.pending.delete(ev.data.id)
      if (ev.data.ok) p.resolve(ev.data.result as never)
      else p.reject(new Error(ev.data.error))
    }
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The PDF engine crashed')
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }

  private call<T>(method: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject })
      this.worker.postMessage({ id, method, args }, transfer)
    })
  }

  open(bytes: Uint8Array, password?: string) {
    return this.call<OpenResult>('open', [bytes, password], [bytes.buffer as ArrayBuffer])
  }
  analyze(page: number) {
    return this.call<PageInfo>('analyze', [page])
  }
  getRuns(page: number) {
    return this.call<TextRun[]>('getRuns', [page])
  }
  render(page: number, scale: number, edits: Edit[]) {
    return this.call<RenderResult>('render', [page, scale, edits])
  }
  renderClip(page: number, rect: Rect, scale: number) {
    return this.call<RenderResult>('renderClip', [page, rect, scale])
  }
  renderPng(page: number, scale: number) {
    return this.call<PngResult>('renderPng', [page, scale])
  }
  measure(items: { text: string; style: FontStyle }[]) {
    return this.call<number[]>('measure', [items])
  }
  export(edits: Edit[], layers: TextLayer[], opts: ExportOptions) {
    return this.call<ExportResult>('export', [edits, layers, opts])
  }
  addUserFont(name: string, bytes: Uint8Array) {
    return this.call<void>('addUserFont', [name, bytes], [bytes.buffer as ArrayBuffer])
  }

  terminate() {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('Engine stopped'))
    this.pending.clear()
  }
}
