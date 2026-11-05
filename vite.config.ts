import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * While developing, serve /api/* from the very same code Vercel runs (server/cloud.ts → api/[...path].js), reading DATABASE_URL and
 * APP_PASSCODE from .env. Those names have no VITE_ prefix, so they stay on the server and never reach the browser.
 */
function cloudApi(): Plugin {
  return {
    name: 'pagedesk-cloud-api',
    configureServer(server) {
      const env = loadEnv(server.config.mode, process.cwd(), '')
      for (const [k, v] of Object.entries(env)) if (!(k in process.env)) process.env[k] = v
      server.middlewares.use('/api', async (req, res, next) => {
        try {
          const mod = (await server.ssrLoadModule('/server/cloud.ts')) as { default: (req: unknown, res: unknown) => Promise<void> }
          req.url = '/api' + (req.url ?? '/') // connect strips the mount path; the handler expects it
          await mod.default(req, res)
        } catch (e) {
          next(e)
        }
      })
    },
  }
}

// MuPDF ships a WASM module loaded with top-level await, so keep it out of dep
// pre-bundling and target modern browsers.
export default defineConfig({
  plugins: [react(), cloudApi()],
  optimizeDeps: { exclude: ['mupdf'] },
  worker: { format: 'es' },
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  server: { port: 5273, strictPort: false },
})
