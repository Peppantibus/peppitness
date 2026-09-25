import { useEffect, useState } from 'react'

export function PwaUpdate({ busy, hasDemoData }: { busy: boolean; hasDemoData: boolean }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)
  const [error, setError] = useState(false)
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
  if (error) return <div className="update-banner" role="status">La cache dell’app non è disponibile. Riprova alla prossima apertura online.</div>
  if (!waiting) return null
  return <div className="update-banner" role="status"><span>{busy ? 'Aggiornamento disponibile. Termina la seduta prima di aggiornare.' : hasDemoData ? 'Aggiornamento disponibile. Le modifiche non conservate saranno perse.' : 'Una nuova versione di peppitness è pronta.'}</span><button className="button primary" disabled={busy} onClick={() => { window.dispatchEvent(new Event('peppitness:apply-update')); waiting.postMessage({ type: 'SKIP_WAITING' }) }}>{hasDemoData ? 'Aggiorna e ricarica' : 'Aggiorna'}</button></div>
}
