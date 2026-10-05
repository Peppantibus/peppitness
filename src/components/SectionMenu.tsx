import { useState } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { Modal } from './Modal'

interface SectionMenuEntry { href: string; icon: IconName; title: string; detail?: string }

/**
 * Azioni dell'intestazione di Dieta e Scheda: «Storico» sempre visibile con etichetta;
 * gli strumenti di gestione in un pannello «Gestisci», una voce per area senza doppioni.
 * Modifica e importazione stanno nelle pagine Programmi e Piani; `current` è il piano seguito.
 */
export function SectionMenu({ section, full, current = null }: { section: 'dieta' | 'scheda'; full: boolean; current?: string | null }) {
  const [open, setOpen] = useState(false)
  const detail = current ?? undefined
  const entries: SectionMenuEntry[] = !full ? [] : section === 'scheda'
    ? [{ href: '#/scheda/programmi', icon: 'calendar', title: 'Programmi', detail },
      { href: '#/scheda/catalogo', icon: 'dumbbell', title: 'Esercizi' },
      { href: '#/scheda/progressi', icon: 'trend', title: 'Progressi' }]
    : [{ href: '#/dieta/piani', icon: 'fork', title: 'Piani alimentari', detail }]
  const title = section === 'scheda' ? 'Gestisci la scheda' : 'Gestisci la dieta'
  return <div className="section-actions">
    <a className="history-button" href={`#/${section}/storico`}><Icon name="history" size={20} /><span>Storico</span></a>
    {entries.length > 0 && <button type="button" className="icon-button is-outlined section-menu-button" aria-haspopup="dialog" aria-label={section === 'scheda' ? 'Gestisci: programmi, esercizi e progressi' : 'Gestisci i piani alimentari'} onClick={() => setOpen(true)}><Icon name="sliders" size={20} /></button>}
    {open && <Modal label={title} variant="sheet" onClose={() => setOpen(false)}>
      <nav className="section-menu" aria-label={title}>
        <h2>{title}</h2>
        {entries.map(entry => <a key={entry.href} href={entry.href} onClick={() => setOpen(false)}><Icon name={entry.icon} size={20} /><span><strong>{entry.title}</strong>{entry.detail && <small>{entry.detail}</small>}</span><Icon name="chevron" size={20} /></a>)}
      </nav>
    </Modal>}
  </div>
}
