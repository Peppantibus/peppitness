import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'

/** `variant="sheet"`: pannello che sale dal basso su mobile, dialog centrato su desktop. */
export function Modal({ children, onClose, label, variant = 'dialog' }: { children: ReactNode; onClose: () => void; label: string; variant?: 'dialog' | 'sheet' }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = ref.current
    dialog?.showModal()
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { dialog?.close(); document.body.style.overflow = overflow; opener?.focus() }
  }, [])
  return <dialog ref={ref} className={`detail-dialog ${variant === 'sheet' ? 'sheet-dialog' : ''}`} aria-label={label} onCancel={event => { event.preventDefault(); onClose() }} onClick={event => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose() } }}><button className="icon-button dialog-close" aria-label="Chiudi dettaglio" onClick={onClose}><Icon name="close" /></button><div className="dialog-content">{children}</div></dialog>
}
