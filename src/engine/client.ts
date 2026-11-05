import type { ImagesToPdfOptions, InspectResult, PageOp, PdfSource, PreviewResult, StampOptions, ToolResult } from './tools.ts'
import type { Edit, ExportOptions, ExportResult, FontStyle, OpenResult, PageInfo, PngResult, Rect, RenderResult, TableEdit, TableModel, TextLayer, TextRun } from './types.ts'

/** Typed promise-based proxy to the engine worker. */
export class EngineClient {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>()

  /** resolves once the worker has loaded MuPDF and is listening; calls made earlier wait for it */
  private ready: Promise<void>

  constructor() {
    let ready!: () => void
    let failed!: (e: Error) => void
    this.ready = new Promise<void>((res, rej) => {
      ready = res
      failed = rej
    })
    this.ready.catch(() => {}) // surfaced through the calls that wait on it
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<{ ready?: boolean; id: number; ok: boolean; result?: unknown; error?: string }>) => {
      if (ev.data.ready) return ready()
      const p = this.pending.get(ev.data.id)
      if (!p) return
      this.pending.delete(ev.data.id)
      if (ev.data.ok) p.resolve(ev.data.result as never)
      else p.reject(new Error(ev.data.error))
    }
    this.worker.onerror = (ev) => {
      const err = new Error(ev.message || 'The PDF engine crashed')
      failed(err)
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
    }
  }

  private call<T>(method: string, args: unknown[], transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq
    return this.ready.then(
      () =>
        new Promise<T>((resolve, reject) => {
          this.pending.set(id, { resolve: resolve as (v: never) => void, reject })
          this.worker.postMessage({ id, method, args }, transfer)
        }),
    )
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

  /** Register a picture that overlays can refer to by `id`. The bytes are copied, so the caller keeps them. */
  addImage(id: string, bytes: Uint8Array) {
    return this.call<{ width: number; height: number }>('addImage', [id, bytes])
  }

  /** The table under a page point (ruled grid). `reason` explains a miss. */
  detectTable(page: number, x: number, y: number) {
    return this.call<{ edit: TableEdit | null; reason?: string }>('detectTable', [page, x, y])
  }
  /** A table inferred from the text inside a dragged box (no ruled lines needed). */
  inferTable(page: number, rect: Rect) {
    return this.call<{ edit: TableEdit | null; reason?: string }>('inferTable', [page, rect])
  }
  /** Row heights that fit the wrapped text. `grow` keeps taller rows; `exact` shrinks them to fit. */
  fitTable(model: TableModel, mode: 'grow' | 'exact') {
    return this.call<TableModel>('fitTable', [model, mode])
  }

  /** Close the open document and free its memory. */
  closeDoc() {
    return this.call<void>('dispose', [])
  }

  // Stateless PDF utilities (see tools.ts). They copy their inputs, so callers keep their bytes.
  inspect(src: PdfSource) {
    return this.call<InspectResult>('tool:inspect', [src])
  }
  merge(sources: PdfSource[]) {
    return this.call<ToolResult>('tool:merge', [sources])
  }
  rebuild(src: PdfSource, ops: PageOp[]) {
    return this.call<ToolResult>('tool:rebuild', [src, ops])
  }
  imagesToPdf(images: { name: string; bytes: Uint8Array }[], opts: ImagesToPdfOptions) {
    return this.call<ToolResult>('tool:imagesToPdf', [images, opts])
  }
  protect(src: PdfSource, password: string) {
    return this.call<ToolResult>('tool:protect', [src, password])
  }
  unlock(src: PdfSource) {
    return this.call<ToolResult>('tool:unlock', [src])
  }
  stamp(src: PdfSource, opts: StampOptions) {
    return this.call<ToolResult>('tool:stamp', [src, opts])
  }
  stampPreview(src: PdfSource, opts: StampOptions, pageIndex: number, width: number) {
    return this.call<PreviewResult>('tool:stampPreview', [src, opts, pageIndex, width])
  }

  terminate() {
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error('Engine stopped'))
    this.pending.clear()
  }
}
