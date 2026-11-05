import { getToolsEngine } from '../engine.ts'
import { ImagesTool } from './ImagesTool.tsx'
import { MergeTool } from './MergeTool.tsx'
import type { ToolId } from './meta.ts'
import { OrganizeTool } from './OrganizeTool.tsx'
import { PdfToImagesTool } from './PdfToImagesTool.tsx'
import { ProtectTool } from './ProtectTool.tsx'
import { StampTool } from './StampTool.tsx'

/** Renders one PDF tool. Each tool resets when you leave it and come back. */
export function ToolView(p: { id: ToolId; onOpenInEditor: (bytes: Uint8Array, name: string) => void }) {
  const props = { engine: getToolsEngine(), onOpenInEditor: p.onOpenInEditor }
  switch (p.id) {
    case 'organize':
      return <OrganizeTool {...props} />
    case 'merge':
      return <MergeTool {...props} />
    case 'images':
      return <ImagesTool {...props} />
    case 'topng':
      return <PdfToImagesTool {...props} />
    case 'stamp':
      return <StampTool {...props} />
    case 'protect':
      return <ProtectTool {...props} />
  }
}
