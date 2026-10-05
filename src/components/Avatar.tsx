import type { CSSProperties } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { Icon } from './Icon'

// Tonalità stabili per account, tenute nella gamma verde/azzurra del marchio.
const hues = [150, 165, 180, 195, 135, 210]

function hueFor(seed: string) {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hues[hash % hues.length]
}

/**
 * Cerchio con l'iniziale del nome scelto nelle impostazioni, altrimenti della mail
 * (icona generica se non si è collegati). Il colore resta legato all'account. Decorativo.
 */
export function Avatar({ name = '', size = 'md', className = '' }: { name?: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const { state } = useAuth()
  const email = state.status === 'signed-in' ? state.session.user.email ?? '' : ''
  const initial = email ? ([...name.trim()][0] ?? email.trim().charAt(0)).toUpperCase() : ''
  const style = email ? { '--avatar-hue': hueFor(email) } as CSSProperties : undefined
  return <span className={`avatar avatar-${size} ${className}`} style={style} aria-hidden="true">
    {initial || <Icon name="user" size={size === 'lg' ? 32 : 20} />}
  </span>
}
