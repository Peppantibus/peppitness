import type { ReactNode } from 'react'
import { Icon } from './Icon'

export function Layout({ section, children, hasTimer = false }: { section: 'dieta' | 'scheda'; children: ReactNode; hasTimer?: boolean }) {
  return <div className={`app-shell ${hasTimer ? 'has-timer' : ''}`}>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Vai al contenuto</a>
    <aside className="sidebar">
      <a href="#/scheda" className="brand" aria-label="peppitness, vai alla scheda"><img className="brand-logo" src="/logo.svg" alt="" width="128" height="104" /></a>
      <p className="brand-caption">IL TUO DIARIO</p>
      <nav className="primary-nav" aria-label="Navigazione principale">
        <a href="#/dieta" aria-current={section === 'dieta' ? 'page' : undefined}><Icon name="fork" /><span>Dieta</span><Icon name="chevron" size={16} /></a>
        <a href="#/scheda" aria-current={section === 'scheda' ? 'page' : undefined}><Icon name="dumbbell" /><span>Scheda</span><Icon name="chevron" size={16} /></a>
      </nav>
      <div className="sidebar-bottom"><a className="account-link" href="#/impostazioni"><span className="avatar"><Icon name="user" size={20} /></span><span><strong>Il tuo spazio</strong><small>Impostazioni</small></span><Icon name="chevron" size={16} /></a></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span className="topbar-caption">{section === 'scheda' ? 'Allenamento' : 'Alimentazione'}<span>/ Il tuo diario</span></span><a href="#/scheda" className="mobile-brand" aria-label="peppitness, vai alla scheda"><img className="brand-logo" src="/logo.svg" alt="" width="128" height="104" /></a><a href="#/impostazioni" className="icon-button account-button" aria-label="Account e impostazioni"><Icon name="user" size={20} /></a></header>
      <main id="main-content" tabIndex={-1}>{children}</main>
    </div>
    <nav className="bottom-nav" aria-label="Navigazione mobile"><a href="#/dieta" aria-current={section === 'dieta' ? 'page' : undefined}><Icon name="fork" /><span>Dieta</span></a><a href="#/scheda" aria-current={section === 'scheda' ? 'page' : undefined}><Icon name="dumbbell" /><span>Scheda</span></a></nav>
  </div>
}
