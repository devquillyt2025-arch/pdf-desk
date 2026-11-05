export const ROADMAP: string[][]
export function buildTablePdf(options?: {
  rows?: string[][]
  colWidths?: number[]
  rowHeight?: number
  x?: number
  top?: number
  thinBorders?: boolean
  noLines?: boolean
  size?: number
}): { bytes: Uint8Array; xs: number[]; ys: number[] }
