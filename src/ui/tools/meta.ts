import type { IconName } from '../icons.tsx'

export type ToolId = 'organize' | 'merge' | 'images' | 'topng' | 'stamp' | 'protect'

export const TOOLS: { id: ToolId; title: string; blurb: string; icon: IconName }[] = [
  { id: 'organize', title: 'Organize pages', blurb: 'Rotate, delete, re-order, duplicate or extract pages.', icon: 'pages' },
  { id: 'merge', title: 'Merge PDFs', blurb: 'Combine several files into one, in the order you choose.', icon: 'copy' },
  { id: 'images', title: 'Images to PDF', blurb: 'Turn photos or scans into a single PDF.', icon: 'image' },
  { id: 'topng', title: 'PDF to images', blurb: 'Save pages as PNG pictures, in a ZIP.', icon: 'images' },
  { id: 'stamp', title: 'Page numbers & watermark', blurb: 'Number every page and/or stamp text across it.', icon: 'hash' },
  { id: 'protect', title: 'Password', blurb: 'Lock a PDF with a password, or remove one you know.', icon: 'lock' },
]
