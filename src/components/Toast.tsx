import { useEffect, useEffectEvent, useRef } from 'react'

export interface ToastMessage { id: number; message: string; undo?: () => void }

/**
 * Conferma breve di un'azione rapida, con «Annulla». Si chiude da sola dopo alcuni
 * secondi, ma non mentre il puntatore o il focus sono sull'avviso.
 */
export function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useEffectEvent(() => onClose())
  useEffect(() => {
    let timer = 0
    const start = () => { window.clearTimeout(timer); timer = window.setTimeout(() => close(), 6000) }
    const stop = () => window.clearTimeout(timer)
    const element = ref.current
    start()
    element?.addEventListener('pointerenter', stop); element?.addEventListener('pointerleave', start)
    element?.addEventListener('focusin', stop); element?.addEventListener('focusout', start)
    return () => { stop(); element?.removeEventListener('pointerenter', stop); element?.removeEventListener('pointerleave', start); element?.removeEventListener('focusin', stop); element?.removeEventListener('focusout', start) }
  }, [toast.id])
  // L'annuncio per le tecnologie assistive passa dalla regione live della pagina.
  return <div ref={ref} className="toast quick-toast">
    <span>{toast.message}</span>
    {toast.undo && <div className="toast-actions"><button type="button" className="toast-action is-primary" onClick={() => { toast.undo?.(); onClose() }}>Annulla</button></div>}
  </div>
}
