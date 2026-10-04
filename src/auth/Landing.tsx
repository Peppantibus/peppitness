import { BrandLogo } from '../components/BrandLogo'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/Icon'
import breakfast from '../assets/meals/breakfast.png'
import lunch from '../assets/meals/lunch.png'
import legs from '../assets/muscle-groups/legs.png'
import './landing.css'

/** Hash delle due viste pubbliche: la landing e il modulo di accesso. */
export const landingHash = '#/benvenuto'
export const signInHash = '#/accedi'

const features: { icon: IconName; title: string; text: string }[] = [
  { icon: 'dumbbell', title: 'La seduta di oggi', text: 'Il programma segue la tua settimana: apri la scheda e trovi già la seduta prevista, esercizio per esercizio.' },
  { icon: 'history', title: 'L’ultima volta, accanto', text: 'Carichi e ripetizioni della volta precedente vicino a ogni serie, senza cercarli nello storico.' },
  { icon: 'clock', title: 'Recupero che non si perde', text: 'Il timer parte quando completi la serie e riprende da dove era, anche se chiudi l’app.' },
  { icon: 'fork', title: 'I pasti della giornata', text: 'Piano alimentare con alternative e calorie stimate. Segni «Seguito» con un tocco, o annoti cosa è cambiato.' },
  { icon: 'trend', title: 'Progressi chiari', text: 'Costanza settimana per settimana e andamento degli esercizi, a colpo d’occhio.' },
  { icon: 'cloudCheck', title: 'Anche senza rete', text: 'In palestra con poco segnale le registrazioni restano sul telefono e partono appena torna la connessione.' },
]

const steps: { title: string; text: string }[] = [
  { title: 'Ricevi l’invito', text: 'Gli account vengono attivati dall’amministratore: niente registrazioni pubbliche.' },
  { title: 'Accedi e installa', text: 'Dal browser del telefono scegli «Aggiungi alla schermata Home»: peppitness si apre come un’app.' },
  { title: 'Porta i tuoi piani', text: 'Crea scheda e dieta con la procedura guidata, oppure importale dai modelli Word.' },
]

function scrollToSteps() {
  const target = document.getElementById('landing-steps')
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  target?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' })
  target?.focus({ preventScroll: true })
}

/** Pagina pubblica per chi arriva sul sito senza sessione. Nessun dato personale: solo testo e illustrazioni. */
export function Landing() {
  return <div className="landing">
    <header className="landing-bar">
      <span className="landing-brand"><BrandLogo className="landing-logo" /><span>peppitness</span></span>
      <a className="button secondary landing-bar-signin" href={signInHash}>Accedi</a>
    </header>

    <main id="main-content" tabIndex={-1}>
      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-hero-copy">
          <span className="landing-pill"><Icon name="leaf" size={16} />Allenamento e alimentazione</span>
          <h1 id="landing-title">Un giorno alla volta<span className="heading-dot">.</span></h1>
          <p className="landing-lead">La seduta di oggi, le serie da completare, il recupero e i pasti della giornata. Tutto in un posto solo, pensato per il telefono.</p>
          <div className="landing-actions">
            <a className="button primary lg" href={signInHash}>Accedi<Icon name="arrow" size={20} /></a>
            <button className="button secondary lg" type="button" onClick={scrollToSteps}>Come funziona</button>
          </div>
          <p className="landing-note"><Icon name="info" size={16} />Accesso su invito: gli account vengono attivati dall’amministratore.</p>
        </div>
        <Preview />
      </section>

      <section className="landing-section" aria-labelledby="landing-features-title">
        <span className="eyebrow">Cosa puoi fare</span>
        <h2 id="landing-features-title">Quello che serve, quando serve</h2>
        <ul className="landing-features">
          {features.map(feature => <li key={feature.title} className="landing-feature">
            <span className="landing-feature-icon"><Icon name={feature.icon} size={24} /></span>
            <h3>{feature.title}</h3>
            <p>{feature.text}</p>
          </li>)}
        </ul>
      </section>

      <section className="landing-section" id="landing-steps" tabIndex={-1} aria-labelledby="landing-steps-title">
        <span className="eyebrow">Come funziona</span>
        <h2 id="landing-steps-title">Pronto in tre passaggi</h2>
        <ol className="landing-steps">
          {steps.map(step => <li key={step.title}><h3>{step.title}</h3><p>{step.text}</p></li>)}
        </ol>
      </section>

      <section className="landing-section landing-trust" aria-labelledby="landing-trust-title">
        <div>
          <span className="eyebrow">I tuoi dati</span>
          <h2 id="landing-trust-title">Il tuo diario resta tuo</h2>
        </div>
        <ul className="landing-trust-list">
          <li><Icon name="check" size={20} />Ogni account vede soltanto i propri piani e il proprio diario: il controllo è nel database, non solo nell’app.</li>
          <li><Icon name="check" size={20} />Verifica in due passaggi con un’app di autenticazione.</li>
          <li><Icon name="check" size={20} />Nessuna pubblicità, nessun profilo pubblico, nessuna dieta generata al posto tuo.</li>
        </ul>
      </section>

      <section className="landing-cta" aria-labelledby="landing-cta-title">
        <h2 id="landing-cta-title">Hai già un account?</h2>
        <p>Entra e riprendi da dove eri rimasto.</p>
        <a className="button primary lg" href={signInHash}>Accedi<Icon name="arrow" size={20} /></a>
      </section>
    </main>

    <footer className="landing-footer"><BrandLogo className="landing-footer-logo" /><span>peppitness · un progetto personale, fatto per il telefono</span></footer>
  </div>
}

/** Anteprima illustrativa dell'app: dati inventati, solo decorativa. */
function Preview() {
  return <div className="landing-preview" aria-hidden="true">
    <div className="landing-phone">
      <div className="lp-head"><strong>La tua scheda<span className="heading-dot">.</span></strong><span>Lun 6 ott</span></div>
      <div className="lp-card lp-session">
        <img src={legs} alt="" width={48} height={48} />
        <span><strong>Seduta A · Gambe</strong><small>5 esercizi · circa 55 min</small></span>
      </div>
      <div className="lp-card">
        <div className="lp-exercise"><strong>Squat</strong><span className="lp-chip">Ultima volta 60 kg × 8</span></div>
        <ol className="lp-sets">
          <li className="is-done"><span>1</span><span>62,5 kg</span><span>8 rip.</span><Icon name="check" size={16} strokeWidth={2.5} /></li>
          <li className="is-done"><span>2</span><span>62,5 kg</span><span>8 rip.</span><Icon name="check" size={16} strokeWidth={2.5} /></li>
          <li className="is-current"><span>3</span><span>62,5 kg</span><span>— rip.</span><span className="lp-dot" /></li>
        </ol>
      </div>
      <div className="lp-timer"><Icon name="clock" size={20} /><span>Recupero</span><strong>1:24</strong><span className="lp-timer-plus">+15 s</span></div>
    </div>
    <div className="lp-float lp-meal"><img src={breakfast} alt="" width={44} height={44} /><span><strong>Colazione</strong><small><Icon name="check" size={16} strokeWidth={2.5} />Seguito</small></span></div>
    <div className="lp-float lp-lunch"><img src={lunch} alt="" width={44} height={44} /><span><strong>Pranzo</strong><small>≈ 640 kcal</small></span></div>
    <div className="lp-float lp-week"><Icon name="trend" size={20} /><span><strong>4 su 4</strong><small>sedute questa settimana</small></span></div>
  </div>
}
