import type { Rect } from '../engine/types.ts'

export type Tool = 'edit' | 'add' | 'erase'

export type EditingTarget =
  | { page: number; kind: 'run'; runId: string; bg: string }
  | { page: number; kind: 'add'; editId?: string; x: number; baseline: number; bg: string }

export interface PageCallbacks {
  onVisible: (page: number) => void
  onPickRun: (page: number, runId: string) => void
  onPickEdit: (editId: string) => void
  onAddAt: (page: number, x: number, baseline: number) => void
  onErase: (page: number, rect: Rect) => void
  onRecognize: (page: number) => void
}
