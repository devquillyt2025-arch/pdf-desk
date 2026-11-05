import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(<App />)

// Offline + instant start once the app has been opened (production only: in development it would hide your edits).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}
