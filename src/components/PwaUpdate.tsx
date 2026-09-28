import { useEffect, useState } from 'react'

/**
 * Avviso di aggiornamento compatto. `hidden`: non compare durante la seduta, dove
 * nulla deve coprire serie e timer; resta in attesa e torna visibile dopo.
 */
export function PwaUpdate({ busy, hasDemoData, hidden = false }: { busy: boolean; hasDemoData: boolean; hidden?: boolean }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [error, setError] = useState(false)
  // «Più tardi» vale per la versione proposta: una versione successiva viene riproposta.
  const [dismissed, setDismissed] = useState<ServiceWorker | 'error' | null>(null)
  useEffect(() => {
    if (!import.meta.env.PROD || import.meta.env.VITE_PWA_ENABLED !== 'true' || !('serviceWorker' in navigator)) return
    let disposed = false
    let applying = false
    const onController = () => { if (applying) window.location.reload() }
    navigator.serviceWorker.addEventListener('controllerchange', onController)
    const offer = (worker: ServiceWorker | null) => {
      if (!disposed && worker) setWaiting(worker)
    }
    void navigator.serviceWorker.register('/sw.js').then(registration => {
      if (registration.waiting) offer(registration.waiting)
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        installing?.addEventListener('statechange', () => {
          if (installing.state === 'installed' && navigator.serviceWorker.controller) offer(registration.waiting)
        })
      })
    }).catch(() => { if (!disposed) setError(true) })
    const apply = () => { applying = true }
    window.addEventListener('peppitness:apply-update', apply)
    return () => { disposed = true; navigator.serviceWorker.removeEventListener('controllerchange', onController); window.removeEventListener('peppitness:apply-update', apply) }
  }, [])
  if (hidden) return null
  if (error) return dismissed === 'error' ? null : <div className="toast update-banner" role="status"><span>La cache dell’app non è disponibile. Riprova alla prossima apertura online.</span><div className="toast-actions"><button type="button" className="toast-action" onClick={() => setDismissed('error')}>Chiudi</button></div></div>
  if (!waiting || dismissed === waiting) return null
  const later = <button type="button" className="toast-action" onClick={() => setDismissed(waiting)}>Più tardi</button>
  if (busy) return <div className="toast update-banner" role="status"><span>Aggiornamento disponibile: potrai installarlo al termine della seduta o delle modifiche.</span><div className="toast-actions">{later}</div></div>
  return <div className="toast update-banner" role="status"><span>{hasDemoData ? 'Nuova versione pronta. Le modifiche non conservate saranno perse.' : 'Una nuova versione di peppitness è pronta.'}</span><div className="toast-actions">{later}<button type="button" className="toast-action is-primary" onClick={() => { window.dispatchEvent(new Event('peppitness:apply-update')); waiting.postMessage({ type: 'SKIP_WAITING' }) }}>{hasDemoData ? 'Aggiorna e ricarica' : 'Aggiorna'}</button></div></div>
}
