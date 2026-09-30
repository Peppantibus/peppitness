/**
 * Stato locale dell'importazione per account (task 07, specifica §9.3), distinto dal job del server:
 * selected → reading → analyzing → reviewing → ready → saving → saved, più failed, cancelled, expired e
 * save_unknown. Riduttore puro: gli effetti (reader, rete, IndexedDB) stanno nei chiamanti (11, 21) e
 * arrivano come eventi. Regole che il riduttore garantisce:
 * - un evento di un altro account, di un'analisi superata o arrivato dopo stop/annullamento è ignorato;
 * - `ready` solo con validazione e mapping validi della bozza corrente, passati come risultato;
 * - il comando si congela con requestId prima dell'invio e si invia solo se il journal è durevole;
 * - `save_unknown` conserva comando e requestId: niente edit né nuovo requestId finché non è riconciliato;
 * - una rianalisi produce una proposta separata da adottare esplicitamente, la bozza in uso resta intatta;
 * - l'originale non è conservato: si riapre solo riselezionando un file con lo stesso sourceHash.
 */
import {
  importLocalStates, receiptMismatches, sameJsonValue, validateCommitCommand,
  type CommitCommand, type JsonValue, type ExtractionKind, type ImportError, type ImportLocalState, type ImportReceipt, type MappingResult,
  type NormalizedDocument, type ReviewDraft,
} from '../contracts/index.ts'
import type { ValidationFinding } from '../validation/validate.ts'
import { evaluateReadiness, verifyDraft, type Readiness } from './decisions.ts'

export { importLocalStates }

/** Giorni di inattività dopo i quali i contenuti locali scadono (valore iniziale della specifica, uguale al server). */
export const IMPORT_INACTIVITY_DAYS = 7
const DAY = 24 * 60 * 60 * 1000

/** Metadati non sensibili del file scelto: mai i byte, mai il percorso locale. */
export interface SelectedFile { name: string; size: number; format: 'docx' | 'pdf'; sourceHash: string | null }

export interface FrozenCommit {
  command: CommitCommand
  commandHash: string
  frozenAt: string
  /** Revisione dello stato in cui il comando è stato scritto nel journal; null finché non è durevole. */
  journalRevision: number | null
  /** Il comando è stato inviato almeno una volta: da qui in poi solo retry con lo stesso requestId. */
  sent: boolean
}

/**
 * ID tecnici prenotati per il mapping della bozza (09/10: piano, versione, elementi, identità shared/new),
 * conservati con la bozza finché il comando non li congela: una ripresa non ne genera di nuovi.
 */
export interface MappingReservations {
  planId: string
  versionId?: string
  items: Readonly<Record<string, string>>
  exercises?: Readonly<Record<string, string>>
}

export interface Reanalysis {
  analysisRequestId: string
  status: 'running' | 'ready' | 'failed'
  /** Nuova proposta con la propria bozza, da confrontare e adottare esplicitamente. */
  draft: ReviewDraft | null
  error: ImportError | null
}

export interface ImportSession {
  formatVersion: typeof IMPORT_SESSION_FORMAT
  sessionId: string
  ownerId: string
  kind: ExtractionKind
  status: ImportLocalState
  file: SelectedFile
  /** Documento normalizzato: citazioni e rivalidazione restano disponibili senza l'originale. */
  document: NormalizedDocument | null
  analysisRequestId: string | null
  jobId: string | null
  /** Bozza in uso; le bozze delle proposte precedenti restano in `previousDrafts`. */
  draft: ReviewDraft | null
  previousDrafts: ReviewDraft[]
  reanalysis: Reanalysis | null
  /** Prenotazioni del mapping per la bozza in uso; null = da prenotare. Assenti nelle voci scritte prima del 22. */
  reservations?: MappingReservations | null
  commit: FrozenCommit | null
  receipt: ImportReceipt | null
  error: ImportError | { code: string; message: string } | null
  createdAt: string
  lastActivityAt: string
  /** Scadenza del job sul server, se nota (informativa). */
  serverExpiresAt: string | null
  /** Revisione dell'ultima scrittura riuscita nel journal locale; null = mai scritto. */
  revision: number | null
  /** durable: ultima modifica scritta; volatile: scrittura fallita o archivio assente, niente ripresa promessa. */
  persistence: 'durable' | 'volatile'
}
export const IMPORT_SESSION_FORMAT = 'peppitness.import-session.v1'

export class ImportStateError extends Error {
  readonly code: 'invalid_transition' | 'not_ready' | 'journal_required' | 'uncertain_save' | 'invalid_input'
  constructor(code: ImportStateError['code'], message: string) { super(message); this.name = 'ImportStateError'; this.code = code }
}

// ---------------------------------------------------------------------------
// Eventi
// ---------------------------------------------------------------------------

type Owned<T> = T & { ownerId: string; sessionId: string; at: string }
export type ImportEvent = Owned<
  | { type: 'read_started' }
  | { type: 'read_succeeded'; document: NormalizedDocument; sourceHash: string }
  | { type: 'read_failed'; error: { code: string; message: string } }
  | { type: 'analysis_started'; analysisRequestId: string }
  | { type: 'analysis_succeeded'; analysisRequestId: string; jobId: string | null; draft: ReviewDraft; serverExpiresAt: string | null }
  | { type: 'analysis_failed'; analysisRequestId: string; error: ImportError }
  | { type: 'reanalysis_adopted' }
  | { type: 'reanalysis_dismissed' }
  | { type: 'draft_changed'; draft: ReviewDraft; reservations?: MappingReservations | null }
  | { type: 'readiness_confirmed'; draft: ReviewDraft; findings: readonly ValidationFinding[]; mapping: MappingResult<unknown> }
  | { type: 'command_frozen'; command: CommitCommand; commandHash: string }
  | { type: 'save_started' }
  | { type: 'save_succeeded'; receipt: ImportReceipt }
  | { type: 'save_rejected'; error: ImportError | { code: string; message: string } }
  | { type: 'save_outcome_unknown'; error: { code: string; message: string } }
  | { type: 'cancelled' }
  | { type: 'expired' }
>

export type Outcome = { state: ImportSession; applied: true } | { state: ImportSession; applied: false; reason: 'other_owner' | 'other_session' | 'stale_response' | 'after_stop' }

// ---------------------------------------------------------------------------
// Creazione e regole
// ---------------------------------------------------------------------------

export function createImportSession(input: { ownerId: string; sessionId: string; kind: ExtractionKind; file: SelectedFile; at: string }): ImportSession {
  if (!input.ownerId) throw new ImportStateError('invalid_input', 'Serve l’account proprietario.')
  if (!Number.isSafeInteger(input.file.size) || input.file.size < 0) throw new ImportStateError('invalid_input', 'Dimensione del file non valida.')
  return {
    formatVersion: IMPORT_SESSION_FORMAT, sessionId: input.sessionId, ownerId: input.ownerId, kind: input.kind, status: 'selected',
    file: { ...input.file }, document: null, analysisRequestId: null, jobId: null, draft: null, previousDrafts: [], reanalysis: null, reservations: null,
    commit: null, receipt: null, error: null, createdAt: input.at, lastActivityAt: input.at, serverExpiresAt: null, revision: null, persistence: 'volatile',
  }
}

/**
 * Stati in cui qualcosa è in corso (lettura, analisi, invio): la UI mostra attesa e non chiude senza avviso.
 * `reading` con il documento già letto è la lettura conclusa in attesa dell'analisi, non un lavoro in corso.
 */
export const isBusy = (state: ImportSession) => (state.status === 'reading' && state.document === null) || state.status === 'analyzing' || state.status === 'saving' || state.reanalysis?.status === 'running'
/** Ci sono modifiche che una chiusura farebbe perdere: journal non durevole con una bozza o un comando. */
export const isDirty = (state: ImportSession) => state.persistence === 'volatile' && (state.draft !== null || state.commit !== null)
/** Con un comando già inviato l'identità dell'operazione va conservata finché non è riconciliata. */
export const hasUncertainCommand = (state: ImportSession) => state.status === 'save_unknown' || (state.commit?.sent === true && state.status !== 'saved')

export const inactivityExpiry = (state: ImportSession) => new Date(Date.parse(state.lastActivityAt) + IMPORT_INACTIVITY_DAYS * DAY).toISOString()
/** Scaduto per inattività; mai durante un invio o con un comando incerto o già salvato. */
export function isExpired(state: ImportSession, now: string): boolean {
  if (state.status === 'saving' || state.status === 'saved' || state.status === 'expired' || hasUncertainCommand(state)) return false
  return Date.parse(now) >= Date.parse(inactivityExpiry(state))
}

/** Cosa si può fare ora. Offline si rivede e si modifica una bozza già scaricata, non si analizza né si salva. */
export function capabilities(state: ImportSession, environment: { online: boolean }) {
  const reviewing = state.status === 'reviewing' || state.status === 'ready'
  return {
    edit: reviewing && state.reanalysis?.status !== 'running',
    analyze: environment.online && state.document !== null && (state.status === 'reading' || state.status === 'failed' || reviewing) && state.reanalysis?.status !== 'running',
    save: environment.online && state.status === 'ready' && state.persistence === 'durable',
    retrySave: environment.online && state.status === 'save_unknown',
    discard: !isBusy(state),
    /** Scartare un comando incerto richiede una conferma dedicata: il piano potrebbe essere già salvato. */
    discardNeedsWarning: hasUncertainCommand(state) || isDirty(state),
  }
}

/** Il file riselezionato è lo stesso originale (per riaprire la fonte), mai un'identità nuova dell'operazione. */
export const matchesOriginal = (state: ImportSession, sourceHash: string) =>
  (state.file.sourceHash ?? state.draft?.proposal.source.sourceHash ?? null) === sourceHash

// ---------------------------------------------------------------------------
// Riduttore
// ---------------------------------------------------------------------------

const terminal: ReadonlySet<ImportLocalState> = new Set(['saved', 'cancelled', 'expired'])
const fail = (state: ImportSession, event: ImportEvent): never => {
  throw new ImportStateError('invalid_transition', `Evento ${event.type} non ammesso nello stato ${state.status}.`)
}
const touch = (state: ImportSession, event: ImportEvent, patch: Partial<ImportSession>): ImportSession => ({ ...state, ...patch, lastActivityAt: event.at })

/**
 * Applica un evento. Risposte di un altro account, di un'altra sessione, di un'analisi non più attuale o
 * arrivate dopo stop/annullamento sono ignorate (`applied: false`); transizioni impossibili lanciano
 * `ImportStateError` (errore del chiamante, non della rete).
 */
export function applyImportEvent(state: ImportSession, event: ImportEvent): Outcome {
  if (event.ownerId !== state.ownerId) return { state, applied: false, reason: 'other_owner' }
  if (event.sessionId !== state.sessionId) return { state, applied: false, reason: 'other_session' }
  const ignored = (reason: 'stale_response' | 'after_stop'): Outcome => ({ state, applied: false, reason })
  if (terminal.has(state.status) && event.type !== 'expired') {
    const late = event.type.endsWith('_succeeded') || event.type.endsWith('_failed') || event.type === 'save_outcome_unknown' || event.type === 'save_rejected' || event.type === 'cancelled'
    return late ? ignored('after_stop') : fail(state, event)
  }
  const done = (next: ImportSession): Outcome => ({ state: next, applied: true })

  switch (event.type) {
    case 'read_started':
      return state.status === 'selected' || state.status === 'failed' ? done(touch(state, event, { status: 'reading', error: null })) : fail(state, event)
    case 'read_succeeded':
      if (state.status !== 'reading') return ignored('stale_response')
      return done(touch(state, event, { document: event.document, file: { ...state.file, sourceHash: event.sourceHash } }))
    case 'read_failed':
      if (state.status !== 'reading') return ignored('stale_response')
      return done(touch(state, event, { status: 'failed', error: event.error }))

    case 'analysis_started': {
      if (state.document === null) throw new ImportStateError('invalid_transition', 'Serve il documento letto prima dell’analisi.')
      if (state.status === 'reviewing' || state.status === 'ready') {
        if (state.reanalysis?.status === 'running') return fail(state, event)
        return done(touch(state, event, { status: 'reviewing', reanalysis: { analysisRequestId: event.analysisRequestId, status: 'running', draft: null, error: null } }))
      }
      if (state.status !== 'reading' && state.status !== 'failed') return fail(state, event)
      return done(touch(state, event, { status: 'analyzing', analysisRequestId: event.analysisRequestId, error: null }))
    }
    case 'analysis_succeeded':
    case 'analysis_failed': {
      const checked = event.type === 'analysis_succeeded' ? verifyDraft(event.draft) : null
      if (checked && !checked.ok) throw new ImportStateError('invalid_input', `Bozza dell’analisi non valida: ${checked.message}`)
      if (checked && checked.ok && checked.draft.kind !== state.kind) throw new ImportStateError('invalid_input', 'Bozza di un altro dominio.')
      if (state.reanalysis?.analysisRequestId === event.analysisRequestId && state.reanalysis.status === 'running') {
        return done(touch(state, event, {
          reanalysis: event.type === 'analysis_succeeded'
            ? { ...state.reanalysis, status: 'ready', draft: event.draft }
            : { ...state.reanalysis, status: 'failed', error: event.error },
        }))
      }
      if (state.status !== 'analyzing' || state.analysisRequestId !== event.analysisRequestId) return ignored('stale_response')
      return done(event.type === 'analysis_succeeded'
        ? touch(state, event, { status: 'reviewing', draft: event.draft, jobId: event.jobId, serverExpiresAt: event.serverExpiresAt, reservations: null })
        : touch(state, event, { status: 'failed', error: event.error }))
    }
    case 'reanalysis_adopted': {
      if (state.reanalysis?.status !== 'ready' || !state.draft || !state.reanalysis.draft || (state.status !== 'reviewing' && state.status !== 'ready')) return fail(state, event)
      const next = state.reanalysis.draft
      return done(touch(state, event, {
        status: 'reviewing', draft: next, previousDrafts: [...state.previousDrafts, state.draft], analysisRequestId: state.reanalysis.analysisRequestId,
        jobId: next.proposal.jobId, reanalysis: null, commit: null, reservations: null,
      }))
    }
    case 'reanalysis_dismissed':
      if (!state.reanalysis || state.reanalysis.status === 'running') return fail(state, event)
      return done(touch(state, event, { reanalysis: null }))

    case 'draft_changed': {
      if (state.status !== 'reviewing' && state.status !== 'ready') {
        if (hasUncertainCommand(state)) throw new ImportStateError('uncertain_save', 'Salvataggio in attesa di esito: la bozza non si modifica finché non è riconciliato.')
        return fail(state, event)
      }
      if (!state.draft || event.draft.proposal.proposalId !== state.draft.proposal.proposalId) throw new ImportStateError('invalid_input', 'La modifica riguarda un’altra proposta.')
      const checked = verifyDraft(event.draft)
      if (!checked.ok) throw new ImportStateError('invalid_input', `Bozza non valida: ${checked.message}`)
      // Ogni modifica richiede di rivalutare la prontezza; un comando congelato e mai inviato decade.
      // Prenotazioni: quelle dell'evento se indicate (anche null = da rigenerare), altrimenti restano.
      const reservations = event.reservations === undefined ? state.reservations ?? null : event.reservations
      return done(touch(state, event, { status: 'reviewing', draft: checked.draft, commit: null, reservations }))
    }
    case 'readiness_confirmed': {
      if (state.status !== 'reviewing' && state.status !== 'ready') return fail(state, event)
      if (!state.draft || !sameJsonValue(event.draft as unknown as JsonValue, state.draft as unknown as JsonValue)) throw new ImportStateError('not_ready', 'Validazione e mapping devono riferirsi alla bozza corrente.')
      const readiness: Readiness = evaluateReadiness(state.draft, event.findings, event.mapping)
      if (!readiness.ready) throw new ImportStateError('not_ready', `Bozza non pronta: ${readiness.blocking.length} bloccanti, ${readiness.confirmations.length} conferme, mapping ${readiness.mapping}.`)
      return done(touch(state, event, { status: 'ready' }))
    }
    case 'command_frozen': {
      if (state.status !== 'ready' || !state.draft) return fail(state, event)
      if (state.commit) {
        // Congelare di nuovo lo stesso comando è idempotente; un comando diverso richiede di tornare alla revisione.
        if (state.commit.commandHash === event.commandHash && state.commit.command.requestId === event.command.requestId) return ignored('stale_response')
        throw new ImportStateError('invalid_transition', 'Esiste già un comando congelato per questa bozza.')
      }
      const checked = validateCommitCommand(state.kind, event.command)
      if (!checked.ok) throw new ImportStateError('invalid_input', `Comando non valido: ${checked.errors[0]!.code} in "${checked.errors[0]!.path}".`)
      if (event.command.provenance.analysis.proposalId !== state.draft.proposal.proposalId) throw new ImportStateError('invalid_input', 'Il comando non deriva dalla bozza corrente.')
      if (!/^[0-9a-f]{64}$/.test(event.commandHash)) throw new ImportStateError('invalid_input', 'commandHash non valido.')
      return done(touch(state, event, { commit: { command: event.command, commandHash: event.commandHash, frozenAt: event.at, journalRevision: null, sent: false } }))
    }
    case 'save_started': {
      if (state.status === 'save_unknown') {
        // Retry dello stesso comando, con lo stesso requestId: mai un'identità nuova.
        return done(touch(state, event, { status: 'saving', commit: { ...state.commit!, sent: true } }))
      }
      if (state.status !== 'ready' || !state.commit) return fail(state, event)
      if (state.persistence !== 'durable' || state.commit.journalRevision === null) throw new ImportStateError('journal_required', 'Il comando non è scritto in modo durevole sul dispositivo: salvataggio non avviato.')
      return done(touch(state, event, { status: 'saving', commit: { ...state.commit, sent: true } }))
    }
    case 'save_succeeded': {
      if ((state.status !== 'saving' && state.status !== 'save_unknown') || !state.commit) return ignored('stale_response')
      const mismatches = receiptMismatches(event.receipt, state.commit.command, state.commit.commandHash)
      if (mismatches.length) throw new ImportStateError('invalid_input', `Ricevuta che non corrisponde al comando: ${mismatches[0]!.message}`)
      return done(touch(state, event, { status: 'saved', receipt: event.receipt, error: null }))
    }
    case 'save_rejected':
      // Rifiuto definitivo del server: nulla è stato scritto, si torna alla revisione e il prossimo comando avrà un requestId nuovo.
      if (state.status !== 'saving' && state.status !== 'save_unknown') return ignored('stale_response')
      return done(touch(state, event, { status: 'reviewing', commit: null, error: event.error }))
    case 'save_outcome_unknown':
      if (state.status !== 'saving') return ignored('stale_response')
      return done(touch(state, event, { status: 'save_unknown', error: event.error }))

    case 'cancelled':
      if (state.status === 'saving' || state.status === 'save_unknown') throw new ImportStateError('uncertain_save', 'Un salvataggio inviato non si annulla: va riconciliato.')
      if (state.status === 'reviewing' || state.status === 'ready') {
        // Stop di una rianalisi: la bozza resta.
        if (state.reanalysis?.status === 'running') return done(touch(state, event, { reanalysis: null }))
        return fail(state, event)
      }
      return done(touch(state, event, { status: 'cancelled' }))
    case 'expired':
      if (state.status === 'saving' || hasUncertainCommand(state) || state.status === 'saved') return ignored('stale_response')
      // I contenuti scadono davvero: bozza, documento e comando non inviato non restano sul dispositivo.
      return done({ ...state, status: 'expired', document: null, draft: null, previousDrafts: [], reanalysis: null, commit: null, reservations: null })
  }
}

/** Da chiamare dopo una scrittura riuscita del journal: la revisione rende durevole anche un comando congelato. */
export function markPersisted(state: ImportSession, revision: number): ImportSession {
  return { ...state, revision, persistence: 'durable', commit: state.commit ? { ...state.commit, journalRevision: state.commit.journalRevision ?? revision } : null }
}
/** Scrittura fallita (quota, archivio disabilitato): stato volatile, avviso di chiusura, nessun invio possibile. */
export function markVolatile(state: ImportSession): ImportSession {
  return { ...state, persistence: 'volatile', commit: state.commit && !state.commit.sent ? { ...state.commit, journalRevision: null } : state.commit }
}

/**
 * Normalizzazione alla riapertura: un invio interrotto da chiusura o crash diventa `save_unknown`
 * (il server potrebbe averlo applicato); lettura e analisi interrotte tornano ripetibili.
 */
export function resumeImportSession(state: ImportSession, now: string): ImportSession {
  if (isExpired(state, now)) return { ...state, status: 'expired', document: null, draft: null, previousDrafts: [], reanalysis: null, commit: null, reservations: null }
  switch (state.status) {
    case 'saving': return { ...state, status: 'save_unknown', error: { code: 'interrupted', message: 'Invio interrotto: esito da verificare con lo stesso requestId.' } }
    case 'reading': return { ...state, status: state.document ? 'reading' : 'failed', error: state.document ? null : { code: 'interrupted', message: 'Lettura interrotta: riselezionare il file.' } }
    case 'analyzing': return { ...state, status: 'failed', error: { code: 'interrupted', message: 'Analisi interrotta: rileggere il job o ripeterla.' } }
    default: return state.reanalysis?.status === 'running' ? { ...state, reanalysis: { ...state.reanalysis, status: 'failed', error: null } } : state
  }
}

// ---------------------------------------------------------------------------
// Account corrente
// ---------------------------------------------------------------------------

/**
 * Identità attiva e lavori in corso. Al cambio account (o stop) annulla le operazioni pendenti e
 * incrementa l'epoca: una risposta tardiva porta ancora owner ed epoca vecchi ed è scartata.
 * StrictMode: `switchTo` con lo stesso owner non annulla nulla; `dispose` è idempotente.
 */
export class ImportAccountScope {
  private owner: string | null
  private epoch = 0
  private controller = new AbortController()
  constructor(ownerId: string | null) { this.owner = ownerId }
  get ownerId() { return this.owner }
  get signal() { return this.controller.signal }
  /** Biglietto da allegare a un'operazione asincrona. */
  ticket() { return { ownerId: this.owner, epoch: this.epoch, signal: this.controller.signal } }
  isCurrent(ticket: { ownerId: string | null; epoch: number }) { return ticket.ownerId === this.owner && ticket.epoch === this.epoch && !this.controller.signal.aborted }
  /** Restituisce l'owner precedente se è cambiato: il chiamante ne cancella la cache privata. */
  switchTo(ownerId: string | null): string | null {
    if (ownerId === this.owner) return null
    const previous = this.owner
    this.stop()
    this.owner = ownerId
    return previous
  }
  /** Interrompe ogni operazione in corso; le risposte successive non valgono più. */
  stop() {
    this.controller.abort(new DOMExceptionLike('Operazione interrotta', 'AbortError'))
    this.controller = new AbortController()
    this.epoch += 1
  }
  dispose() { this.controller.abort(new DOMExceptionLike('Operazione interrotta', 'AbortError')) }
}

/** Motivo di annullamento senza dipendere da DOMException (assente in alcuni runtime server). */
class DOMExceptionLike extends Error { constructor(message: string, name: string) { super(message); this.name = name } }
