import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// MuPDF ships a WASM module loaded with top-level await, so keep it out of dep
// pre-bundling and target modern browsers.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['mupdf'] },
  worker: { format: 'es' },
  build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
  server: { port: 5273, strictPort: false },
})
