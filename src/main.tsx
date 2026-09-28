import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AuthGate, AuthProvider, useAuth } from './auth/AuthProvider'
import { applyTheme, readThemePreference } from './theme'
import './styles.css'

// Tema scelto su questo dispositivo, prima del primo render (senza scelta segue il sistema).
applyTheme(readThemePreference())

function AccountApp() {
  const { state } = useAuth()
  // Smonta ogni stato in memoria a logout/cambio account; il rinnovo mantiene lo stesso ID.
  return <AuthGate><App key={state.session?.user.id ?? 'unconfigured'} /></AuthGate>
}

createRoot(document.getElementById('root')!).render(<StrictMode><AuthProvider><AccountApp /></AuthProvider></StrictMode>)
