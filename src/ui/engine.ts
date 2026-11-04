import { EngineClient } from '../engine/client.ts'

/** One engine worker for the whole app (kept alive across hot reloads of the UI). */
export const engine = new EngineClient()
