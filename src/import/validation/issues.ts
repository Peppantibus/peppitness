/**
 * Catalogo dei problemi applicativi dell'importazione (specifica §§4.6, 7.5) e modello comune degli
 * elementi su cui girano le regole. La severità, la fase e le risoluzioni ammesse dipendono solo dal
 * codice: un problema segnalato dal modello non decide mai se un salvataggio è possibile, e nessuna
 * regola produce percentuali di fiducia. Stesso modulo per browser, worker e Deno (solo import relativi).
 */
import {
  proposalFieldPointer,
  type ExerciseChoice, type IssueResolution, type ReviewCollection, type ValidationIssue, type ValidationIssueSeverity, type ValidationStage,
} from '../contracts/index.ts'

interface IssueRule {
  readonly severity: ValidationIssueSeverity
  readonly stage: ValidationStage
  readonly resolutions: readonly IssueResolution[]
  readonly description: string
}
const rule = (severity: ValidationIssueSeverity, stage: ValidationStage, resolutions: readonly IssueResolution[], description: string): IssueRule =>
  ({ severity, stage, resolutions, description })

const EDIT = ['user_edit'] as const
const EDIT_OR_REANALYZE = ['user_edit', 'reanalyze'] as const
const SCOPE = ['scope_choice', 'reanalyze'] as const
const NONE = ['none'] as const

/**
 * Codici stabili (snake_case) con severità fissa. `blocking` impedisce il salvataggio finché la regola
 * scatta ancora o, se ammesso, finché una decisione di ambito non la chiude; `confirmation` richiede una
 * decisione esplicita legata al valore; `info` resta visibile senza azioni. Un bloccante non accetta mai
 * `confirmed_missing`: una sola spunta non chiude una criticità.
 */
export const issueCatalog = {
  // --- Lettura della fonte (problemi dichiarati dal reader) -------------------------------------------
  source_not_read: rule('blocking', 'reading', SCOPE, 'Parte potenzialmente pertinente non letta: pagina senza testo, immagine, componente o parte danneggiata.'),
  source_hidden_content: rule('confirmation', 'reading', ['scope_choice'], 'Testo nascosto escluso dalla lettura.'),
  reading_uncertain: rule('confirmation', 'reading', SCOPE, 'Ordine di lettura, numeri disallineati o testo sovrapposto: la riga di un valore può essere incerta.'),
  reading_note: rule('info', 'reading', NONE, 'Avviso del reader che non toglie contenuto.'),
  suspicious_source_text: rule('info', 'reading', NONE, 'La fonte contiene testo rivolto all’interprete: resta un dato, mai un comando.'),

  // --- Prove dell'estrazione ----------------------------------------------------------------------------
  missing_evidence: rule('blocking', 'extraction', ['user_edit', 'remove_item', 'reanalyze'], 'Valore prescrittivo o istruzione senza citazione.'),
  quote_not_found: rule('blocking', 'extraction', ['user_edit', 'remove_item', 'reanalyze'], 'Valore prescrittivo o istruzione con citazioni assenti dal blocco indicato.'),
  unverified_detail: rule('confirmation', 'extraction', ['user_edit', 'scope_choice'], 'Dettaglio non prescrittivo (nome, etichetta, tipo) senza riscontro nella fonte.'),
  extra_quote_not_found: rule('confirmation', 'extraction', ['scope_choice', 'user_edit'], 'Una delle citazioni del campo non esiste; le altre sì.'),
  wrong_context: rule('blocking', 'extraction', EDIT_OR_REANALYZE, 'Citazione presa dalla riga, dall’esercizio o dalla sezione di un altro elemento.'),
  wrong_column: rule('blocking', 'extraction', EDIT_OR_REANALYZE, 'Numero citato da una colonna diversa da quella del campo.'),
  value_contradicts_source: rule('blocking', 'extraction', EDIT_OR_REANALYZE, 'La fonte, letta in modo deterministico, indica un valore diverso.'),
  value_unverified: rule('confirmation', 'extraction', ['user_edit', 'scope_choice'], 'Citazione presente ma valore non ricavabile in modo deterministico.'),
  text_not_in_quote: rule('blocking', 'extraction', EDIT_OR_REANALYZE, 'Testo critico diverso da quanto citato (completato o riformulato).'),
  local_override_ignored: rule('blocking', 'extraction', EDIT, 'Regola generale applicata dove la riga indica un valore proprio.'),
  reps_sequence_as_range: rule('blocking', 'extraction', EDIT, 'Sequenza come 12/10/8 ridotta a intervallo.'),
  non_numeric_reps: rule('blocking', 'extraction', EDIT, 'AMRAP, cedimento o drop set tradotti in un numero di ripetizioni.'),
  sets_range_as_number: rule('blocking', 'extraction', EDIT, 'Serie indicate come intervallo (3–4) rese come numero o come serie facoltative.'),
  rir_rpe_swapped: rule('blocking', 'extraction', EDIT, 'RIR e RPE scambiati o convertiti.'),
  evidence_from_suspicious_text: rule('blocking', 'extraction', ['user_edit', 'remove_item', 'reanalyze'], 'Valore ricavato da testo rivolto all’interprete.'),
  evidence_dangling_path: rule('info', 'extraction', NONE, 'Citazione per un campo inesistente.'),
  evidence_for_null: rule('info', 'extraction', NONE, 'Citazione per un campo vuoto.'),
  evidence_too_coarse: rule('info', 'extraction', NONE, 'Citazione su un intero elemento invece che su un campo.'),
  dangling_source_ref: rule('info', 'extraction', NONE, 'Riferimento a un blocco inesistente.'),
  duplicate_source_ref: rule('info', 'extraction', NONE, 'Riferimento ripetuto.'),
  model_reported_missing: rule('info', 'extraction', NONE, 'L’interprete segnala un dato mancante che nessuna regola rende necessario.'),
  model_reported_ambiguous: rule('confirmation', 'extraction', ['user_edit', 'scope_choice'], 'L’interprete segnala un’ambiguità.'),
  model_reported_conflict: rule('confirmation', 'extraction', ['user_edit', 'scope_choice'], 'L’interprete segnala un conflitto.'),
  model_reported_unreadable: rule('confirmation', 'extraction', SCOPE, 'L’interprete segnala una parte illeggibile.'),
  model_reported_unsupported: rule('confirmation', 'extraction', ['user_edit', 'scope_choice'], 'L’interprete segnala un contenuto non rappresentabile.'),

  // --- Copertura ---------------------------------------------------------------------------------------
  uncovered_numeric_content: rule('confirmation', 'validation', SCOPE, 'Blocco con numeri non collegato alla proposta.'),
  uncovered_text: rule('info', 'validation', NONE, 'Blocco di testo senza numeri non collegato alla proposta.'),
  section_not_covered: rule('confirmation', 'validation', SCOPE, 'Intera sezione della fonte assente dalla proposta.'),
  page_not_covered: rule('confirmation', 'validation', SCOPE, 'Intera pagina con testo assente dalla proposta.'),
  complex_rule_not_extracted: rule('confirmation', 'validation', SCOPE, 'Fase, progressione, scarico, superserie o circuito della fonte non riportato fra le regole.'),
  alternative_not_extracted: rule('confirmation', 'validation', SCOPE, 'Alternativa o sostituzione della fonte non riportata.'),
  addition_not_extracted: rule('confirmation', 'validation', SCOPE, 'Aggiunta o condizione della fonte non riportata.'),
  unassigned_content: rule('confirmation', 'validation', SCOPE, 'Contenuto che l’interprete non ha saputo collocare.'),
  other_domain_content: rule('info', 'validation', NONE, 'Contenuto dell’altro dominio in un documento misto.'),

  // --- Relazioni fra campi e regole di dominio --------------------------------------------------------
  title_missing: rule('blocking', 'validation', EDIT, 'Nome del piano mancante.'),
  no_sessions: rule('blocking', 'validation', EDIT_OR_REANALYZE, 'Nessuna seduta.'),
  cycle_incomplete: rule('blocking', 'validation', EDIT, 'Ciclo con una sola fra data d’inizio e settimane.'),
  cycle_start_invalid: rule('blocking', 'validation', EDIT, 'Data d’inizio non leggibile come data reale.'),
  cycle_start_unconfirmed: rule('confirmation', 'validation', ['scope_choice', 'user_edit'], 'Data che la fonte non presenta come inizio del ciclo (per esempio in copertina).'),
  session_label_missing: rule('blocking', 'validation', EDIT, 'Etichetta della seduta mancante.'),
  session_label_duplicate: rule('blocking', 'validation', EDIT, 'Due sedute con la stessa etichetta.'),
  session_title_missing: rule('confirmation', 'validation', EDIT, 'Titolo della seduta mancante.'),
  session_empty: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Seduta senza esercizi.'),
  exercise_name_missing: rule('blocking', 'validation', ['user_edit', 'catalog_choice', 'remove_item'], 'Nome dell’esercizio mancante.'),
  measurement_mode_missing: rule('blocking', 'validation', ['user_edit', 'catalog_choice'], 'Modalità ripetizioni/tempo non indicata.'),
  sets_missing: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Serie mancanti o ambigue.'),
  repetitions_missing: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Ripetizioni mancanti per un esercizio a ripetizioni.'),
  duration_missing: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Durata mancante per un esercizio a tempo.'),
  reps_duration_conflict: rule('blocking', 'validation', EDIT, 'Ripetizioni e durata insieme.'),
  mode_conflict: rule('blocking', 'validation', ['user_edit', 'catalog_choice'], 'Modalità in contrasto con ripetizioni o durata.'),
  rest_missing: rule('blocking', 'validation', EDIT, 'Recupero non indicato: mai 0 automatico.'),
  rest_range: rule('confirmation', 'validation', ['timer_choice'], 'Recupero a intervallo: serve il valore del timer.'),
  duration_range: rule('confirmation', 'validation', ['timer_choice'], 'Durata a intervallo: serve il valore del timer.'),
  rir_range: rule('confirmation', 'validation', EDIT, 'RIR a intervallo: il dominio ne conserva uno.'),
  rpe_range: rule('confirmation', 'validation', EDIT, 'RPE a intervallo: il dominio ne conserva uno.'),
  optional_sets_missing: rule('confirmation', 'validation', ['confirmed_missing', 'user_edit'], 'Serie facoltative non indicate: confermare nessuna o indicarle.'),
  intensity_not_prescribed: rule('info', 'validation', NONE, 'RIR e RPE non prescritti: restano vuoti.'),
  complex_rule_unresolved: rule('blocking', 'validation', ['scope_choice'], 'Fase, progressione, scarico, superserie o circuito da risolvere esplicitamente.'),
  complex_rule_review: rule('confirmation', 'validation', ['scope_choice', 'user_edit'], 'Regola (cardio o altro) da confermare.'),
  rule_target_unresolved: rule('info', 'validation', NONE, 'Regola riferita a un elemento inesistente.'),
  no_days: rule('blocking', 'validation', EDIT_OR_REANALYZE, 'Nessuna giornata.'),
  day_name_missing: rule('blocking', 'validation', EDIT, 'Nome della giornata mancante.'),
  day_type_missing: rule('confirmation', 'validation', EDIT, 'Tipo di giornata non indicato: scegliere allenamento, riposo o qualsiasi.'),
  day_without_meals: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Giornata senza pasti.'),
  meal_name_missing: rule('blocking', 'validation', EDIT, 'Nome del pasto mancante.'),
  meal_time_missing: rule('info', 'validation', NONE, 'Orario del pasto non indicato.'),
  food_name_missing: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Nome dell’alimento mancante.'),
  food_quantity_missing: rule('confirmation', 'validation', ['confirmed_missing', 'user_edit'], 'Quantità non indicata: confermare il vuoto o indicarla, mai inventarla.'),
  alternative_in_base: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Alimento di un’alternativa inserito nel pasto base.'),
  conditional_in_base: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Alimento di un’aggiunta condizionata inserito nel pasto base.'),
  global_rule_in_meal: rule('blocking', 'validation', EDIT, 'Regola globale copiata in un pasto: va riportata una sola volta.'),
  wrong_section: rule('blocking', 'validation', EDIT_OR_REANALYZE, 'Elemento collocato sotto una sezione diversa da quella della fonte.'),

  // --- Catalogo (risoluzione dell'08, nessuna query qui) ----------------------------------------------
  catalog_choice_required: rule('blocking', 'catalog', ['catalog_choice'], 'Esercizio da associare al catalogo (esistente, comune o nuovo).'),
  catalog_mode_mismatch: rule('blocking', 'catalog', ['catalog_choice', 'user_edit'], 'L’esercizio scelto ha una modalità diversa dalla prescrizione.'),

  // --- Compatibilità con il dominio (limiti senza clamp) ----------------------------------------------
  text_too_long: rule('blocking', 'validation', EDIT, 'Testo oltre il limite del dominio: mai troncato.'),
  text_invalid: rule('blocking', 'validation', EDIT, 'Carattere di controllo non ammesso dal database.'),
  too_many_items: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Troppi elementi per il dominio: mai tagliati.'),
  value_out_of_bounds: rule('blocking', 'validation', EDIT, 'Numero fuori dai limiti del dominio: mai limitato.'),
  value_not_integer: rule('blocking', 'validation', EDIT, 'Decimale dove il dominio vuole un intero: mai arrotondato.'),
  document_too_large: rule('blocking', 'validation', ['user_edit', 'remove_item'], 'Piano oltre la dimensione massima del documento.'),
} as const satisfies Record<string, IssueRule>

export type ValidationIssueCode = keyof typeof issueCatalog
export const validationIssueCodes = Object.keys(issueCatalog) as ValidationIssueCode[]

// ---------------------------------------------------------------------------
// Elementi su cui girano le regole
// ---------------------------------------------------------------------------

/**
 * Elemento della proposta o della bozza corrente. `pointer` è il puntatore sulla proposta immutabile
 * (null per un elemento aggiunto dall'utente); `localId` è null solo per la proposta ancora senza bozza.
 * `userFields` sono i campi il cui valore corrente viene da una decisione: non richiedono citazioni.
 */
export interface RuleItem {
  readonly key: string
  readonly localId: string | null
  readonly pointer: string | null
  readonly collection: ReviewCollection
  readonly parentKey: string | null
  readonly values: Readonly<Record<string, unknown>>
  readonly catalog: ExerciseChoice | null
  readonly userFields: ReadonlySet<string>
}

/** Problema applicativo con il campo interessato (null = intero elemento), necessario per legare le conferme (07). */
export interface ValidationFinding {
  readonly issue: ValidationIssue
  readonly field: string | null
}

/**
 * Costruisce un problema dal catalogo. `path` (puntatore completo) serve per un elemento di una lista di
 * testi (`/guidance/1`); senza, il percorso è il campo dell'elemento o l'elemento stesso.
 */
export function finding(code: ValidationIssueCode, item: RuleItem, field: string | null, message: string, options: { refs?: readonly string[]; path?: string } = {}): ValidationFinding {
  const entry = issueCatalog[code]
  const sourcePath = item.pointer === null ? null : options.path ?? (field === null ? item.pointer : proposalFieldPointer(item.pointer, field))
  return {
    field,
    issue: {
      code, severity: entry.severity, stage: entry.stage, localId: item.localId, sourcePath,
      sourceRefs: [...new Set(options.refs ?? [])].slice(0, 50), message, resolutions: [...entry.resolutions],
    },
  }
}

/** Un finding per elemento, campo e codice: la prima regola che lo produce vince. */
export class FindingList {
  readonly items: ValidationFinding[] = []
  private readonly seen = new Set<string>()
  add(entry: ValidationFinding) {
    const key = `${entry.issue.code}\u0000${entry.issue.localId ?? ''}\u0000${entry.issue.sourcePath ?? ''}\u0000${entry.field ?? ''}\u0000${entry.issue.sourceRefs.join(' ')}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.items.push(entry)
  }
  addAll(entries: Iterable<ValidationFinding>) { for (const entry of entries) this.add(entry) }
}

/** Testo non vuoto dopo trim. */
export const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
export const isRangeValue = (value: unknown): value is { min: number; max: number } =>
  typeof value === 'object' && value !== null && typeof (value as { min?: unknown }).min === 'number' && typeof (value as { max?: unknown }).max === 'number'
