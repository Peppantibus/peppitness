import { useState } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { Modal } from './Modal'

interface Entry { href: string; icon: IconName; title: string; detail: string }

/** Voci usate di rado (storico, programmi, catalogo, piani) raccolte in un pannello dal basso. */
export function SectionMenu({ section, full }: { section: 'dieta' | 'scheda'; full: boolean }) {
  const [open, setOpen] = useState(false)
  const entries: Entry[] = section === 'scheda'
    ? [{ href: '#/scheda/storico', icon: 'history', title: 'Storico', detail: 'Le sedute completate, correggibili' },
      ...(full ? [{ href: '#/scheda/progressi', icon: 'trend', title: 'I tuoi progressi', detail: 'Costanza e andamento degli esercizi' },
        { href: '#/scheda/programmi', icon: 'calendar', title: 'I tuoi programmi', detail: 'Crea o modifica il tuo programma' },
        { href: '#/scheda/catalogo', icon: 'dumbbell', title: 'I tuoi esercizi', detail: 'Il catalogo personale' }] satisfies Entry[] : [])]
    : [{ href: '#/dieta/storico', icon: 'history', title: 'Storico', detail: 'I pasti registrati, giorno per giorno' },
      ...(full ? [{ href: '#/dieta/piani', icon: 'fork', title: 'I tuoi piani alimentari', detail: 'Crea o modifica i tuoi pasti' }] satisfies Entry[] : [])]
  return <>
    <button type="button" className="icon-button section-menu-button" aria-haspopup="dialog" aria-label={section === 'scheda' ? 'Storico, programmi ed esercizi' : 'Storico e piani alimentari'} onClick={() => setOpen(true)}><Icon name="menu" size={21} /></button>
    {open && <Modal label={section === 'scheda' ? 'La tua scheda' : 'La tua dieta'} variant="sheet" onClose={() => setOpen(false)}>
      <nav className="section-menu" aria-label={section === 'scheda' ? 'La tua scheda' : 'La tua dieta'}>
        <h2>{section === 'scheda' ? 'La tua scheda' : 'La tua dieta'}</h2>
        {entries.map(entry => <a key={entry.href} href={entry.href} onClick={() => setOpen(false)}><span className="section-menu-icon"><Icon name={entry.icon} size={20} /></span><span><strong>{entry.title}</strong><small>{entry.detail}</small></span><Icon name="chevron" size={18} /></a>)}
      </nav>
    </Modal>}
  </>
}
