import type { ReactNode } from 'react'
import { Avatar } from './Avatar'
import { BrandLogo } from './BrandLogo'
import { Icon } from './Icon'

/**
 * Guscio dell'app. Su desktop la sidebar è l'unica navigazione (marchio, sezioni, salvataggio,
 * account); su mobile la barra superiore porta marchio, salvataggio e account, quella inferiore le sezioni.
 * `section`: sezione evidenziata; `null` in Impostazioni.
 * `focus`: creazione guidata a tutto schermo su mobile. `subpage`: pagina con la propria intestazione.
 * `status` / `sidebarStatus`: indicatore del salvataggio, compatto in alto e con etichetta nella sidebar.
 */
export function Layout({ section, children, hasTimer = false, focus = false, session = false, subpage = false, status, sidebarStatus, userName }: {
  section: 'dieta' | 'scheda' | null; children: ReactNode; hasTimer?: boolean; focus?: boolean; session?: boolean; subpage?: boolean; status?: ReactNode; sidebarStatus?: ReactNode; userName?: string
}) {
  return <div className={`app-shell ${hasTimer ? 'has-timer' : ''} ${focus ? 'focus-mode' : ''} ${session ? 'session-mode' : ''} ${subpage ? 'subpage-mode' : ''}`}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Vai al contenuto</a>
    <aside className="sidebar">
      <a href="#/scheda" className="brand" aria-label="peppitness, vai alla scheda"><BrandLogo /><span className="brand-name" aria-hidden="true">peppitness<span>.</span></span></a>
      <nav className="primary-nav" aria-label="Navigazione principale">
        <a href="#/dieta" aria-current={section === 'dieta' ? 'page' : undefined}><Icon name="fork" size={20} /><span>Dieta</span></a>
        <a href="#/scheda" aria-current={section === 'scheda' ? 'page' : undefined}><Icon name="dumbbell" size={20} /><span>Scheda</span></a>
      </nav>
      <div className="sidebar-bottom">
        {sidebarStatus && <div className="sidebar-status">{sidebarStatus}</div>}
        <a className="account-link" href="#/impostazioni" aria-current={section === null ? 'page' : undefined}><Avatar name={userName} /><span><strong>Il tuo spazio</strong><small>Impostazioni e account</small></span></a>
      </div>
    </aside>
    <div className="workspace">
      <header className="topbar"><a href="#/scheda" className="mobile-brand" aria-label="peppitness, vai alla scheda"><BrandLogo /><span className="brand-name" aria-hidden="true">peppitness<span>.</span></span></a><div className="topbar-actions">{status}<a href="#/impostazioni" className="account-button" aria-label="Account e impostazioni" aria-current={section === null ? 'page' : undefined}><Avatar name={userName} size="sm" /></a></div></header>
      <main id="main-content" tabIndex={-1}>{children}</main>
    </div>
    <nav className="bottom-nav" aria-label="Navigazione mobile"><a href="#/dieta" aria-current={section === 'dieta' ? 'page' : undefined}><Icon name="fork" /><span>Dieta</span></a><a href="#/scheda" aria-current={section === 'scheda' ? 'page' : undefined}><Icon name="dumbbell" /><span>Scheda</span></a></nav>
  </div>
}
