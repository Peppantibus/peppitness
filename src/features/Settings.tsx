import { useState } from 'react'
import { Segmented } from '../components/Segmented'
import { SubpageHeader } from '../components/SubpageHeader'
import { readThemePreference, saveThemePreference } from '../theme'
import type { ThemePreference } from '../theme'
import { Account } from '../auth/Account'
import { weekdayLabels } from '../domain/settings'
import type { SettingsState, SettingsStore } from '../persistence/settings-store'

export function Settings({ hasUnsavedData, catalogBusy = false, onSignedOut, store, state, dirty, backSection = 'dieta', weeklyProgram = false }: {
  /** Sezione da cui si è arrivati: il ritorno porta lì. */
  backSection?: 'dieta' | 'scheda'
  /** Con un programma settimanale seguito i giorni di allenamento vengono dal programma. */
  weeklyProgram?: boolean
  hasUnsavedData: boolean; catalogBusy?: boolean; onSignedOut?: () => void; store: SettingsStore | null; state: SettingsState; dirty: boolean
}) {
  const busy = ['loading', 'saving', 'checking'].includes(state.phase)
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference)
  const chooseTheme = (value: ThemePreference) => { setTheme(value); saveThemePreference(value) }
  return <><SubpageHeader back={`#/${backSection}`} backLabel={backSection === 'scheda' ? 'Torna alla scheda' : 'Torna alla dieta'} title="Impostazioni" />
    <div className="settings-stack">
      <section className="panel settings-panel preferences-panel" aria-labelledby="preferences-title">
        <h2 id="preferences-title">Preferenze</h2>
        {!store && <p className="field-help">Accedi per salvare le preferenze nel tuo account.</p>}
        {store && (state.phase === 'loading' ? <p role="status">Caricamento delle preferenze…</p>
          : state.phase === 'error' ? <><p role="alert">{state.message}</p><button className="button secondary" onClick={() => void store.load()}>Riprova</button></>
            : <form className="preferences-form" onSubmit={event => { event.preventDefault(); void store.save() }}>
              <fieldset disabled={busy || state.phase === 'uncertain'}>
                <label htmlFor="display-name">Come ti chiami?<input id="display-name" autoComplete="nickname" maxLength={120} value={state.draft.displayName} onChange={event => store.edit({ ...state.draft, displayName: event.target.value })} /></label>
                <label htmlFor="time-zone">Fuso orario del diario<input id="time-zone" list="time-zones" required maxLength={80} autoComplete="off" spellCheck={false} value={state.draft.timeZone} aria-describedby="time-zone-help" onChange={event => store.edit({ ...state.draft, timeZone: event.target.value })} /></label>
                <datalist id="time-zones">{['Europe/Rome', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'].map(zone => <option key={zone} value={zone} />)}</datalist>
                <p id="time-zone-help" className="field-help">Determina la data di oggi. Le giornate già annotate mantengono la loro data.</p>
                {weeklyProgram
                  ? <div className="settings-note"><strong>Giorni di allenamento</strong><p>Segui un programma settimanale: la Scheda propone la seduta del giorno dal programma, quindi qui non serve indicarli.</p></div>
                  : <><fieldset className="weekday-options"><legend>Giorni abituali di allenamento</legend><div className="chip-row">{weekdayLabels.map((label, i) => <label key={label} className="chip chip-check"><input type="checkbox" value={i + 1} checked={state.draft.workoutWeekdays.includes(i + 1)} onChange={event => store.edit({ ...state.draft, workoutWeekdays: event.target.checked ? [...state.draft.workoutWeekdays, i + 1].sort() : state.draft.workoutWeekdays.filter(day => day !== i + 1) })} />{label}</label>)}</div></fieldset>
                    <p className="field-help">Puoi iniziare una seduta anche nei giorni liberi.</p></>}
              </fieldset>
              {state.phase === 'conflict' && <div className="preferences-conflict" role="region" aria-label="Confronto preferenze">
                <h3>Preferenze attualmente online</h3>
                {state.remote ? <dl className="info-list"><div><dt>Nome</dt><dd>{state.remote.displayName || 'Non indicato'}</dd></div><div><dt>Fuso orario</dt><dd>{state.remote.timeZone}</dd></div><div><dt>Giorni</dt><dd>{state.remote.workoutWeekdays.map(day => weekdayLabels[day - 1]).join(', ') || 'Nessuno'}</dd></div></dl> : <p>Non ci sono preferenze salvate online.</p>}
                <div className="button-row preferences-actions"><button type="button" className="button secondary" onClick={store.useRemote}>Usa quelle online</button><button type="button" className="button primary" onClick={() => void store.save(true)}>Salva le mie modifiche</button></div>
              </div>}
              {state.message && <p className="preferences-message" role={state.phase === 'ready' ? 'status' : 'alert'}>{state.message}</p>}
              <div className="button-row">
                {state.phase === 'uncertain' ? <button className="button secondary" type="button" onClick={() => void store.check()}>Verifica online</button>
                  : state.phase !== 'conflict' && <button className="button primary" type="submit" disabled={busy || (!dirty && state.saved !== null)}>{state.phase === 'saving' ? 'Salvataggio…' : state.phase === 'checking' ? 'Verifica in corso…' : 'Salva preferenze'}</button>}
              </div>
              {dirty && !state.message && <p className="field-help" role="status">Modifiche da salvare. Restano in questa pagina finché non le salvi online.</p>}
            </form>)}
      </section>
      <section className="panel settings-panel" aria-labelledby="appearance-title">
        <h2 id="appearance-title">Aspetto</h2>
        <p className="field-help">Automatico segue il tema del telefono. La scelta resta solo su questo dispositivo.</p>
        <Segmented className="theme-choice" label="Tema" value={theme} onChange={chooseTheme} options={[{ value: 'system', label: 'Automatico' }, { value: 'light', label: 'Chiaro', icon: 'sun' }, { value: 'dark', label: 'Scuro', icon: 'moon' }]} />
      </section>
      {/* Valori fissi di questa versione: presentati come informazioni, non come righe da toccare. */}
      <section className="panel settings-panel" aria-labelledby="info-title">
        <h2 id="info-title">Informazioni</h2>
        <p className="field-help">Valori fissi in questa versione dell’app.</p>
        <dl className="info-list"><div><dt>Lingua</dt><dd>Italiano</dd></div><div><dt>Unità di carico</dt><dd>Chilogrammi (kg)</dd></div>{!store && <div><dt>Fuso orario del diario</dt><dd>Europe/Rome</dd></div>}</dl>
      </section>
      <Account hasUnsavedData={hasUnsavedData} busy={catalogBusy || (busy && Boolean(store))} onSignedOut={onSignedOut} />
    </div>
  </>
}
