import { Icon } from '../components/Icon'

export function Settings() {
  return <><a className="back-link" href="#/scheda"><Icon name="back" size={18} />Torna alla scheda</a><div className="page-heading"><div><span className="eyebrow">IL TUO SPAZIO</span><h1>Impostazioni</h1></div></div><section className="panel settings-panel"><h2>Preferenze</h2><dl><div><dt>Lingua</dt><dd>Italiano</dd></div><div><dt>Unità di carico</dt><dd>Chilogrammi · kg</dd></div><div><dt>Fuso orario del diario</dt><dd>Europe/Rome</dd></div><div><dt>Aspetto</dt><dd>Chiaro</dd></div></dl></section></>
}
