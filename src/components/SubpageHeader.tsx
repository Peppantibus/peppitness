import type { ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * Intestazione comune delle sottopagine: indietro, titolo ed eventuali azioni.
 * Stessa forma della barra del wizard, così ogni pagina secondaria si legge allo stesso modo.
 */
export function SubpageHeader({ back, backLabel, title, subtitle, actions }: { back: string; backLabel: string; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return <header className="subpage-header">
    <a className="icon-button is-outlined subpage-back" href={back} aria-label={backLabel}><Icon name="back" size={20} /></a>
    <div className="subpage-title"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {actions && <div className="subpage-actions">{actions}</div>}
  </header>
}
