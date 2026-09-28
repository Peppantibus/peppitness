import { useState } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { Modal } from './Modal'

export interface SectionMenuEntry { href: string; icon: IconName; title: string; detail: string }

/**
 * Azioni dell'intestazione di Dieta e Scheda: «Storico» sempre visibile con etichetta;
 * gli strumenti di gestione (progressi, programmi, catalogo, piani) in un pannello «Gestisci».
 * `extra`: voci contestuali in cima al pannello, per esempio «Modifica programma».
 */
export function SectionMenu({ section, full, extra = [] }: { section: 'dieta' | 'scheda'; full: boolean; extra?: SectionMenuEntry[] }) {
  const [open, setOpen] = useState(false)
  const entries: SectionMenuEntry[] = !full ? [] : section === 'scheda'
    ? [...extra, { href: '#/scheda/progressi', icon: 'trend', title: 'I tuoi progressi', detail: 'Costanza e andamento degli esercizi' },
      { href: '#/scheda/programmi', icon: 'calendar', title: 'I tuoi programmi', detail: 'Crea o modifica il tuo programma' },
      { href: '#/scheda/catalogo', icon: 'dumbbell', title: 'I tuoi esercizi', detail: 'Il catalogo personale' }]
    : [...extra, { href: '#/dieta/piani', icon: 'fork', title: 'I tuoi piani alimentari', detail: 'Crea o modifica i tuoi pasti' }]
  const title = section === 'scheda' ? 'Gestisci la scheda' : 'Gestisci la dieta'
  return <div className="section-actions">
    <a className="history-button" href={`#/${section}/storico`}><Icon name="history" size={20} /><span>Storico</span></a>
    {entries.length > 0 && <button type="button" className="icon-button is-outlined section-menu-button" aria-haspopup="dialog" aria-label={section === 'scheda' ? 'Gestisci: progressi, programmi ed esercizi' : 'Gestisci i piani alimentari'} onClick={() => setOpen(true)}><Icon name="sliders" size={20} /></button>}
    {open && <Modal label={title} variant="sheet" onClose={() => setOpen(false)}>
      <nav className="section-menu" aria-label={title}>
        <h2>{title}</h2>
        {entries.map(entry => <a key={entry.href} href={entry.href} onClick={() => setOpen(false)}><span className="section-menu-icon"><Icon name={entry.icon} size={20} /></span><span><strong>{entry.title}</strong><small>{entry.detail}</small></span><Icon name="chevron" size={20} /></a>)}
      </nav>
    </Modal>}
  </div>
}
