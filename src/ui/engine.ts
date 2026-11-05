import { EngineClient } from '../engine/client.ts'

/** One engine worker for the whole app (kept alive across hot reloads of the UI). */
export const engine = new EngineClient()

// The PDF tools (merge, organise, …) get a worker of their own, started on first use, so working on a
// second file never disturbs the document that is open in the editor.
let toolsEngine: EngineClient | null = null
const userFonts: { name: string; bytes: Uint8Array }[] = []

export function getToolsEngine(): EngineClient {
  if (!toolsEngine) {
    toolsEngine = new EngineClient()
    for (const f of userFonts) void toolsEngine.addUserFont(f.name, f.bytes.slice())
  }
  return toolsEngine
}

/** Fonts the user adds (for other scripts) are shared by the editor and by the stamp tool. */
export async function addUserFont(name: string, bytes: Uint8Array) {
  await engine.addUserFont(name, bytes.slice()) // throws if this is not a usable font
  userFonts.push({ name, bytes: bytes.slice() })
  if (toolsEngine) await toolsEngine.addUserFont(name, bytes.slice())
}
