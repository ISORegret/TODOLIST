import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const rootEl = document.getElementById('root')

function showBootFailure(message, detail) {
  if (!rootEl) return
  rootEl.innerHTML = `
    <div style="font-family:system-ui,sans-serif;max-width:520px;margin:48px auto;padding:24px;
      background:#1a1a1a;border:1px solid #444;border-radius:12px;color:#e8e0d8;line-height:1.5">
      <h1 style="font-size:18px;margin:0 0 12px;color:#f5c2c2">Something went wrong loading the app</h1>
      <p style="margin:0 0 8px;font-size:14px">${message}</p>
      <pre style="margin:12px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-word;color:#888">${detail}</pre>
    </div>`
}

window.addEventListener('error', (event) => {
  console.error(event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('unhandledrejection', event.reason)
})

try {
  if (!rootEl) {
    throw new Error('Missing #root element')
  }
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (err) {
  console.error(err)
  showBootFailure(
    'Try a hard refresh (Ctrl+F5) or another browser. If you deploy with GitHub Actions, check that repository secrets VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set correctly.',
    String(err?.stack || err?.message || err),
  )
}
