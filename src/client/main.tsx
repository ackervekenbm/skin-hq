import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const THEME_IDS = ['onyx', 'dusk', 'ember', 'blue'] as const

// Apply the saved theme before the first render so a non-blue preference
// doesn't flash the blue fallback skin. The App effect re-applies it and
// persists on change; keep the allowlist in sync with THEMES in App.tsx.
try {
  const saved = localStorage.getItem('skin-hq-theme')
  if (saved && (THEME_IDS as readonly string[]).includes(saved)) {
    document.documentElement.setAttribute('data-theme', saved)
  }
} catch {
  /* storage unavailable — default blue fallback skin */
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)