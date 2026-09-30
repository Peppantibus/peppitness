/**
 * Coordinamento di rete dell'importazione (task 21, specifica §§9.3, 12.3, 13): analisi, ripresa del job,
 * conferma con una sola RPC e riconciliazione delle risposte perse. Nessuno stato proprio della sessione:
 * ogni esito diventa un evento del riduttore 07 applicato dall'host (il motore 11, `import-review-store.ts`)
 * alla stessa `ImportSession` dello slot e scritto nello stesso journal. Qui restano solo le regole di rete:
 *
 * - l'analisi parte solo su richiesta esplicita; una risposta persa si recupera cercando il job per chiave
 *   (sola lettura), mai con una seconda richiesta al provider; riaprire un'analisi compatibile non costa;
 * - la conferma congela mapping, ID tecnici, opzioni e requestId nel journal e parte solo se il journal li
 *   ha scritti (`save_started` durevole): un'altra scheda sulla stessa bozza ottiene un conflitto, non un'altra chiave;
 * - timeout o rete dopo l'invio → `save_unknown`, poi lettura della ricevuta con la stessa chiave; il retry
 *   reinvia lo stesso comando, mai un requestId nuovo; solo un rifiuto certo del server torna alla revisione;
 * - una ricevuta `deleted` è un esito (piano eliminato), non un invito a salvare di nuovo;
 * - dopo il salvataggio si rileggono piani e catalogo; un errore di rilettura non cambia l'esito salvato.
 */
import {
  IMPORT_COMMIT_PROTOCOL_VERSION, IMPORT_PROVENANCE_FORMAT, EXTRACTION_SCHEMA_VERSION, TEXT_NORMALIZATION_VERSION, extractionSchemaIds, normalizedDocumentLimitViolations, sameJsonValue,
  type CommitCommand, type ExtractionKind, type ImportError, type ImportJobResult, type ImportReceipt, type JsonValue, type ReviewDraft, type SelectionOptions,
} from '../import/contracts/index.ts'
import { commandHash, contentHash } from '../import/mapping/canonical.ts'
import { mapReviewedDiet, type DietMapping, type DietMappingIds } from '../import/mapping/diet.ts'
import { mapReviewedWorkout, type WorkoutMapping, type WorkoutMappingIds } from '../import/mapping/workout.ts'
import { createReviewDraft, pointerOf, randomLocalIds, type LocalIdFactory } from '../import/review/draft.ts'
import { ImportStateError, type ImportEvent, type ImportSession } from '../import/review/state.ts'
import { validateDraft } from '../import/validation/validate.ts'
import { CommitRejected, ImportsFailure, type CommitRejection, type DuplicateImport, type ImportsRepository } from './imports-repository.ts'

// ---------------------------------------------------------------------------
// Comando di conferma
// ---------------------------------------------------------------------------

export type MappingIds<K extends ExtractionKind> = K extends 'workout' ? WorkoutMappingIds : DietMappingIds
export type MappingValue = WorkoutMapping | DietMapping

/**
 * Comando della RPC dal mapping 09/10 già calcolato sulla bozza: payload = `mapping.resolved`, un elemento di
 * provenienza per ogni elemento corrente (target dal mapping, puntatore della proposta o null se aggiunto,
 * decisioni di quell'elemento con il campo per `set`/`confirm`). Nessun valore ricalcolato o completato qui.
 */
export function buildCommitCommand(input: { draft: ReviewDraft; mapping: MappingValue; requestId: string; selectionOptions: SelectionOptions }): CommitCommand {
  const { draft, mapping } = input
  const pointers = pointerOf(draft)
  const provenance = {
    formatVersion: IMPORT_PROVENANCE_FORMAT, kind: draft.kind,
    analysis: {
      jobId: draft.proposal.jobId, proposalId: draft.proposal.proposalId, proposalVersion: draft.proposal.proposalVersion,
      schemaId: extractionSchemaIds[draft.kind], source: structuredClone(draft.proposal.source),
    },
    items: (draft.current as readonly { localId: string }[]).map(item => ({
      localId: item.localId,
      targetId: mapping.targets[item.localId] ?? null,
      sourcePointer: pointers.get(item.localId) ?? null,
      decisions: draft.decisions.filter(decision => decision.localId === item.localId)
        .map(decision => ({ field: decision.op === 'set' || decision.op === 'confirm' ? decision.field ?? null : null, reason: decision.reason })),
    })),
  }
  return {
    requestId: input.requestId,
    payload: { protocolVersion: IMPORT_COMMIT_PROTOCOL_VERSION, kind: draft.kind, mode: 'create_new', resolved: structuredClone(mapping.resolved) },
    provenance,
    selectionOptions: { ...input.selectionOptions },
  } as CommitCommand
}

/** Stesso comando a meno della chiave: una conferma ripetuta riusa il comando già congelato. */
const sameCommand = (a: CommitCommand, b: CommitCommand) =>
  sameJsonValue({ ...a, requestId: '' } as unknown as JsonValue, { ...b, requestId: '' } as unknown as JsonValue)

// ---------------------------------------------------------------------------
// Host e stato di rete
// ---------------------------------------------------------------------------

export type NetworkActivity = 'looking_up' | 'analyzing' | 'recovering' | 'confirming' | 'saving' | 'reconciling' | 'refreshing'
export interface NetworkProblem { code: string; title: string; message: string }
export interface CompatibleAnalysis { jobId: string; analysisRequestId: string; expiresAt: string; cached: boolean }

/** Stato di rete di uno slot: solo in memoria, azzerato a stop/logout/cambio account (nessuna cache globale). */
export interface ImportNetwork {
  activity: NetworkActivity | null
  problem: NetworkProblem | null
  /** Analisi pronte della stessa fonte, da riaprire senza nuove chiamate; null = non cercate. */
  compatible: CompatibleAnalysis[] | null
  /** Importazioni confermate con lo stesso contenuto; la conferma resta ferma finché non si sceglie. */
  duplicates: DuplicateImport[] | null
  /** Ultimo rifiuto certo della RPC (nulla scritto): guida la nuova conferma. */
  rejection: CommitRejection | null
  /** Rilettura di piani e catalogo dopo il salvataggio, distinta dall'esito salvato. */
  refresh: 'idle' | 'pending' | 'done' | 'failed'
}
export const idleNetwork = (): ImportNetwork => ({ activity: null, problem: null, compatible: null, duplicates: null, rejection: null, refresh: 'idle' })

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type SessionEvent = DistributiveOmit<ImportEvent, 'ownerId' | 'sessionId' | 'at'>
export interface ImportTicket { ownerId: string | null; epoch: number; signal: AbortSignal }
export interface DispatchResult { session: ImportSession; storage: 'durable' | 'volatile' | 'conflict' | null }

/** Ciò che il motore locale (11) offre al coordinatore: stessa sessione, stesso journal, stesso account. */
export interface ImportSessionHost {
  readonly ownerId: string
  current(kind: ExtractionKind): ImportSession | null
  /** Biglietto dell'account: stop, logout e cambio account lo invalidano e annullano il segnale. */
  ticket(): ImportTicket
  isCurrent(ticket: ImportTicket): boolean
  /** Applica l'evento alla sessione `sessionId` dello slot e ne attende la scrittura nel journal; null se superata. */
  dispatch(kind: ExtractionKind, sessionId: string, event: SessionEvent): Promise<DispatchResult | null>
  /** Rilegge la sessione dal journal (conflitto con un'altra scheda). */
  reload(kind: ExtractionKind): Promise<void>
  network(kind: ExtractionKind): ImportNetwork
  setNetwork(kind: ExtractionKind, patch: Partial<ImportNetwork>): void
}

export interface ImportsStoreOptions {
  newId?: () => string
  localIds?: LocalIdFactory
  online?: () => boolean
  /** Rilettura di piani/catalogo dopo un salvataggio confermato (App 22); il fallimento non annulla l'esito. */
  refresh?: (receipt: ImportReceipt, signal: AbortSignal) => Promise<void>
  /** Attesa fra due letture di un job ancora `running` e durata massima dell'attesa (solo a pagina aperta). */
  poll?: { intervalMs: number; maxMs: number }
}

const problems = {
  offline: { code: 'offline', title: 'Sei offline', message: 'Senza connessione puoi rivedere e modificare la bozza, ma non analizzare né salvare.' },
  journal: { code: 'journal_unavailable', title: 'Salvataggio non avviato', message: 'L’archivio del dispositivo non è disponibile (per esempio in navigazione privata o con lo spazio esaurito): senza di esso un esito perso non sarebbe verificabile, quindi il salvataggio non parte.' },
  conflict: { code: 'journal_conflict', title: 'Bozza aperta in un’altra scheda', message: 'Questa importazione è stata modificata in un’altra scheda: ho ricaricato la versione aggiornata e non ho inviato nulla.' },
  session: { code: 'session', title: 'Accesso da rinnovare', message: 'La sessione non è valida per questo account: accedi di nuovo per continuare.' },
  lookupFailed: { code: 'lookup_failed', title: 'Verifica non riuscita', message: 'Non riesco a verificare online l’esito. La bozza resta qui: riprova quando torna la connessione.' },
  notReady: { code: 'not_ready', title: 'Revisione da completare', message: 'Restano problemi da risolvere o confermare prima del salvataggio.' },
} satisfies Record<string, NetworkProblem>

const rejectionProblems: Record<CommitRejection, NetworkProblem> = {
  invalid_command: { code: 'invalid_command', title: 'Piano respinto', message: 'Il server ha respinto il piano: nulla è stato salvato. Controlla la revisione e conferma di nuovo.' },
  not_available: { code: 'not_available', title: 'Riferimento non disponibile', message: 'L’analisi o un esercizio scelto non è più disponibile per questo account: nulla è stato salvato.' },
  request_conflict: { code: 'request_conflict', title: 'Conferma da ripetere', message: 'Questa conferma usa identificativi già impiegati: nulla è stato salvato. Conferma di nuovo per creare una nuova operazione.' },
  selection_conflict: { code: 'selection_conflict', title: 'Piano seguito cambiato', message: 'Il piano seguito è cambiato su un altro dispositivo: nulla è stato salvato. Controlla la selezione e conferma di nuovo, seguendolo o no.' },
  catalog_conflict: { code: 'catalog_conflict', title: 'Catalogo cambiato', message: 'Un esercizio del catalogo è cambiato nel frattempo: nulla è stato salvato. Rivedi le scelte del catalogo e conferma di nuovo.' },
  analysis_expired: { code: 'analysis_expired', title: 'Analisi scaduta', message: 'L’analisi è scaduta sul server: nulla è stato salvato. Serve una nuova analisi del documento.' },
}

const importError = (code: ImportError['code'], message: string, retryable: boolean): ImportError => ({ code, message, retryable, limit: null })

/** Esito della proposta (dominio sbagliato, nessun contenuto, illeggibile) da mostrare prima della revisione. */
export const analysisOutcome = (session: ImportSession) => session.draft?.proposal.extraction.outcome ?? null

// ---------------------------------------------------------------------------
// Coordinatore
// ---------------------------------------------------------------------------

export class ImportsStore {
  private readonly host: ImportSessionHost
  private readonly repository: ImportsRepository
  private readonly newId: () => string
  private readonly localIds: LocalIdFactory
  private readonly online: () => boolean
  private readonly refresher: ImportsStoreOptions['refresh']
  private readonly poll: NonNullable<ImportsStoreOptions['poll']>
  /** Un'operazione di rete per slot: doppio click e retry concorrenti non producono seconde richieste. */
  private readonly running = new Map<ExtractionKind, Promise<void>>()

  constructor(host: ImportSessionHost, repository: ImportsRepository, options: ImportsStoreOptions = {}) {
    if (repository.ownerId !== host.ownerId) throw new Error('Repository e journal di account diversi.')
    this.host = host
    this.repository = repository
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.localIds = options.localIds ?? randomLocalIds
    this.online = options.online ?? (() => globalThis.navigator?.onLine !== false)
    this.refresher = options.refresh
    this.poll = options.poll ?? { intervalMs: 3000, maxMs: 150_000 }
  }

  busy(kind: ExtractionKind) { return this.running.has(kind) }

  /** Cerca analisi già pronte della stessa fonte (stesso account, dominio, reader): si possono riaprire senza costi. */
  lookupCompatible(kind: ExtractionKind) {
    return this.exclusive(kind, 'looking_up', async (session, ticket) => {
      if (!session.document) return
      const found = await this.repository.findCompatibleAnalysis({ kind, sourceHash: session.document.sourceHash, readerVersion: session.document.readerVersion }, ticket.signal)
      if (this.stale(kind, session, ticket)) return
      this.host.setNetwork(kind, { compatible: found.map(job => ({ jobId: job.jobId, analysisRequestId: job.analysisRequestId, expiresAt: job.expiresAt, cached: job.usageSummary.cached })) })
    })
  }

  /** Riapre un'analisi compatibile: legge job e fonte conservata, nessuna chiamata al provider. */
  reopen(kind: ExtractionKind, jobId: string) {
    return this.exclusive(kind, 'recovering', async (session, ticket) => {
      if (!session.document) return
      const [job, stored] = await Promise.all([this.repository.readJob(jobId, ticket.signal), this.repository.readDraft(jobId, ticket.signal)])
      if (this.stale(kind, session, ticket)) return
      if (!job || job.status !== 'ready' || job.kind !== kind || !stored || stored.document.sourceHash !== session.document.sourceHash || stored.document.readerVersion !== session.document.readerVersion) {
        this.host.setNetwork(kind, { compatible: null, problem: { code: 'job_not_found', title: 'Analisi non disponibile', message: 'Questa analisi non è più disponibile (scaduta o di un altro documento): puoi avviarne una nuova.' } })
        return
      }
      const started = await this.dispatch(kind, session, { type: 'analysis_started', analysisRequestId: job.analysisRequestId }, ticket)
      if (!started) return
      await this.applyJob(kind, started.session, job, ticket)
      this.host.setNetwork(kind, { compatible: null })
    })
  }

  /** Nuova analisi esplicita: nuova chiave, stesso documento letto. */
  analyze(kind: ExtractionKind) { return this.startAnalysis(kind, null) }

  /**
   * Stessa richiesta, stesso input, stessa chiave: il server restituisce il job esistente (nessuna seconda
   * chiamata) o, se la prima richiesta non era arrivata, la esegue una volta sola.
   */
  resumeAnalysis(kind: ExtractionKind) {
    const session = this.host.current(kind)
    const id = session?.reanalysis?.analysisRequestId ?? session?.analysisRequestId ?? null
    return id ? this.startAnalysis(kind, id) : Promise.resolve()
  }

  /** Dopo chiusura o risposta persa: cerca il job per chiave (sola lettura) e ne applica l'esito. */
  recoverAnalysis(kind: ExtractionKind) {
    return this.exclusive(kind, 'recovering', async (session, ticket) => {
      const id = session.reanalysis?.status !== 'ready' && session.reanalysis ? session.reanalysis.analysisRequestId : session.status === 'failed' ? session.analysisRequestId : null
      if (!id || !session.document) return
      const job = await this.repository.findJob(id, ticket.signal)
      if (this.stale(kind, session, ticket)) return
      if (!job) { this.host.setNetwork(kind, { problem: { code: 'job_not_found', title: 'Analisi non trovata', message: 'L’analisi non risulta avviata sul server. Puoi ripeterla con la stessa richiesta, senza doppio addebito.' } }); return }
      if (job.status === 'running') { this.host.setNetwork(kind, { problem: runningProblem }); return }
      const started = await this.dispatch(kind, session, { type: 'analysis_started', analysisRequestId: id }, ticket)
      if (started) await this.applyJob(kind, started.session, job, ticket)
    })
  }

  /**
   * Conferma: rivalidazione e mapping della bozza corrente con gli ID prenotati, comando congelato e scritto,
   * controllo dei duplicati, poi una sola RPC. `allowDuplicate`: copia esplicita di un'importazione identica.
   */
  confirm<K extends ExtractionKind>(kind: K, input: { ids: MappingIds<K>; selection: SelectionOptions; allowDuplicate?: boolean }) {
    return this.exclusive(kind, 'confirming', async (session, ticket) => {
      if (!this.online()) { this.host.setNetwork(kind, { problem: problems.offline }); return }
      if (!session.document || !session.draft || (session.status !== 'reviewing' && session.status !== 'ready')) return
      const { document, draft } = session
      const findings = validateDraft(document, draft).findings
      const mapping = kind === 'workout'
        ? mapReviewedWorkout(document, draft as Extract<ReviewDraft, { kind: 'workout' }>, input.ids as WorkoutMappingIds)
        : mapReviewedDiet(document, draft as Extract<ReviewDraft, { kind: 'diet' }>, input.ids as DietMappingIds)
      if (!mapping.ok) { this.host.setNetwork(kind, { problem: problems.notReady }); return }
      const candidate = buildCommitCommand({ draft, mapping: mapping.value, requestId: session.commit?.command.requestId ?? this.newId(), selectionOptions: input.selection })

      let current: ImportSession = session
      // Un comando congelato e mai inviato si riusa solo se identico; altrimenti decade con la revisione.
      if (current.commit && !current.commit.sent && !sameCommand(current.commit.command, candidate)) {
        const reset = await this.dispatch(kind, current, { type: 'draft_changed', draft }, ticket)
        if (!reset) return
        current = reset.session
      }
      if (!current.commit) {
        let ready: DispatchResult | null
        try { ready = await this.dispatch(kind, current, { type: 'readiness_confirmed', draft, findings, mapping }, ticket) } catch (error) {
          if (error instanceof ImportStateError && error.code === 'not_ready') { this.host.setNetwork(kind, { problem: problems.notReady }); return }
          throw error
        }
        if (!ready) return
        const command = { ...candidate, requestId: this.newId() }
        const frozen = await this.dispatch(kind, ready.session, { type: 'command_frozen', command, commandHash: await commandHash(command) }, ticket)
        if (!frozen || !await this.storageOk(kind, frozen)) return
        current = frozen.session
      }
      if (current.commit?.journalRevision === null || current.persistence !== 'durable') { this.host.setNetwork(kind, { problem: problems.journal }); return }

      if (!input.allowDuplicate) {
        const duplicates = await this.repository.findDuplicate({ kind, contentHash: await contentHash(current.commit!.command.payload) }, ticket.signal)
        if (this.stale(kind, current, ticket)) return
        if (duplicates.length) { this.host.setNetwork(kind, { duplicates }); return }
      }
      this.host.setNetwork(kind, { duplicates: null, rejection: null })
      await this.send(kind, current, ticket)
    })
  }

  /** Stato incerto: prima la ricevuta, poi (solo se assente) lo stesso comando con la stessa chiave. */
  retrySave(kind: ExtractionKind) {
    return this.exclusive(kind, 'saving', async (session, ticket) => {
      if (session.status !== 'save_unknown' || !session.commit) return
      if (!this.online()) { this.host.setNetwork(kind, { problem: problems.offline }); return }
      const settled = await this.lookupReceipt(kind, session, ticket)
      if (settled !== 'absent') return
      await this.send(kind, this.host.current(kind)!, ticket)
    })
  }

  /** Solo verifica della ricevuta (riapertura, ritorno online o in primo piano): nessun invio. */
  reconcile(kind: ExtractionKind) {
    return this.exclusive(kind, 'reconciling', async (session, ticket) => {
      if (session.status !== 'save_unknown' || !session.commit) return
      const settled = await this.lookupReceipt(kind, session, ticket)
      if (settled === 'absent') this.host.setNetwork(kind, { problem: { code: 'save_not_found', title: 'Salvataggio non ancora avvenuto', message: 'Il piano non risulta salvato. Puoi riprovare: verrà inviata la stessa conferma, senza creare copie.' } })
    })
  }

  /** Ripete la rilettura di piani e catalogo dopo un salvataggio confermato. */
  refresh(kind: ExtractionKind) {
    const session = this.host.current(kind)
    return session?.status === 'saved' && session.receipt ? this.runRefresh(kind, session, session.receipt, this.host.ticket()) : Promise.resolve()
  }

  /** Dopo la riapertura o il ritorno della rete: riconcilia i salvataggi incerti e cerca le analisi interrotte. */
  async resume() {
    for (const kind of ['workout', 'diet'] as const) {
      const session = this.host.current(kind)
      if (!session || this.busy(kind) || !this.online()) continue
      if (session.status === 'save_unknown') await this.reconcile(kind)
      else if (session.status === 'failed' && session.analysisRequestId && session.document && session.error?.code === 'interrupted') await this.recoverAnalysis(kind)
      else if (session.reanalysis?.status === 'failed' && session.reanalysis.error === null) await this.recoverAnalysis(kind)
    }
  }

  // -------------------------------------------------------------------------

  private startAnalysis(kind: ExtractionKind, reuse: string | null) {
    return this.exclusive(kind, 'analyzing', async (session, ticket) => {
      if (!this.online()) { this.host.setNetwork(kind, { problem: problems.offline }); return }
      if (!session.document) return
      const violations = normalizedDocumentLimitViolations(session.document)
      if (violations.length) {
        this.host.setNetwork(kind, { problem: { code: 'limit_exceeded', title: 'Documento troppo grande', message: 'Il testo letto supera i limiti dell’analisi: serve una selezione di sezioni o pagine.' } })
        return
      }
      const analysisRequestId = reuse ?? this.newId()
      const started = await this.dispatch(kind, session, { type: 'analysis_started', analysisRequestId }, ticket)
      if (!started) return
      this.host.setNetwork(kind, { compatible: null, problem: null })
      let result
      try {
        result = await this.repository.analyze({ analysisRequestId, kind, normalizedDocument: session.document, expectedSchemaVersion: EXTRACTION_SCHEMA_VERSION }, ticket.signal)
      } catch (error) {
        if (!(error instanceof ImportsFailure)) throw error
        if (error.kind === 'aborted' || this.stale(kind, started.session, ticket)) return
        if (error.kind === 'session') { await this.failAnalysis(kind, analysisRequestId, importError('unauthenticated', problems.session.message, false), ticket); return }
        // Risposta persa: la stessa chiave si cerca, non si rinvia.
        await this.followUp(kind, analysisRequestId, ticket)
        return
      }
      if (this.stale(kind, started.session, ticket)) return
      if (!result.ok) {
        if (result.error.code === 'internal') { await this.followUp(kind, analysisRequestId, ticket); return }
        await this.failAnalysis(kind, analysisRequestId, result.error, ticket)
        return
      }
      if (result.job.analysisRequestId !== analysisRequestId || result.job.kind !== kind) { await this.followUp(kind, analysisRequestId, ticket); return }
      if (result.job.status === 'running') { await this.followUp(kind, analysisRequestId, ticket); return }
      await this.applyJob(kind, this.host.current(kind)!, result.job, ticket)
    })
  }

  /** Dopo una risposta persa o un job ancora in corso: letture per chiave finché la pagina è aperta, poi rinuncia dichiarata. */
  private async followUp(kind: ExtractionKind, analysisRequestId: string, ticket: ImportTicket) {
    const deadline = Date.now() + this.poll.maxMs
    while (this.host.isCurrent(ticket)) {
      let job: ImportJobResult | null
      try { job = await this.repository.findJob(analysisRequestId, ticket.signal) } catch (error) {
        if (!(error instanceof ImportsFailure)) throw error
        if (error.kind === 'aborted' || !this.host.isCurrent(ticket)) return
        await this.failAnalysis(kind, analysisRequestId, importError('internal', 'Risposta dell’analisi persa e verifica non riuscita: controlla più tardi, senza avviare una nuova analisi.', true), ticket)
        this.host.setNetwork(kind, { problem: problems.lookupFailed })
        return
      }
      if (!this.host.isCurrent(ticket)) return
      if (job === null) {
        await this.failAnalysis(kind, analysisRequestId, importError('internal', 'Risposta persa: l’analisi non risulta avviata. Puoi ripeterla con la stessa richiesta, senza doppio addebito.', true), ticket)
        return
      }
      if (job.status !== 'running') { await this.applyJob(kind, this.host.current(kind)!, job, ticket); return }
      if (Date.now() >= deadline) {
        await this.failAnalysis(kind, analysisRequestId, importError('internal', runningProblem.message, true), ticket)
        this.host.setNetwork(kind, { problem: runningProblem })
        return
      }
      await wait(this.poll.intervalMs, ticket.signal)
    }
  }

  /** Esito del job applicato alla sessione: bozza nuova (o rianalisi da adottare) dall'estrazione immutabile. */
  private async applyJob(kind: ExtractionKind, session: ImportSession, job: ImportJobResult, ticket: ImportTicket) {
    const reanalysis = session.reanalysis?.analysisRequestId === job.analysisRequestId
    if (job.status === 'ready' && job.extraction && session.document) {
      const previous = reanalysis && session.draft ? { proposalId: session.draft.proposal.proposalId, proposalVersion: session.draft.proposal.proposalVersion } : null
      const draft = createReviewDraft({
        kind, extraction: job.extraction as never, proposalId: this.newId(), jobId: job.jobId, previous, localIds: this.localIds,
        source: { sourceHash: session.document.sourceHash, readerVersion: session.document.readerVersion, textNormalizationVersion: TEXT_NORMALIZATION_VERSION },
      })
      await this.dispatch(kind, session, { type: 'analysis_succeeded', analysisRequestId: job.analysisRequestId, jobId: job.jobId, draft, serverExpiresAt: job.expiresAt }, ticket)
      return
    }
    const error = job.status === 'failed' && job.error ? job.error
      : importError('job_not_found', 'L’analisi è scaduta sul server e i suoi contenuti sono stati eliminati: serve una nuova analisi.', false)
    await this.failAnalysis(kind, job.analysisRequestId, error, ticket)
  }

  private async failAnalysis(kind: ExtractionKind, analysisRequestId: string, error: ImportError, ticket: ImportTicket) {
    const session = this.host.current(kind)
    if (session) await this.dispatch(kind, session, { type: 'analysis_failed', analysisRequestId, error }, ticket)
  }

  /** Invio dell'unica RPC: parte solo se `save_started` è scritto nel journal. */
  private async send(kind: ExtractionKind, session: ImportSession, ticket: ImportTicket) {
    const priorAttempt = session.commit!.sent
    const started = await this.dispatch(kind, session, { type: 'save_started' }, ticket)
    if (!started) return
    if (started.storage !== 'durable') {
      if (started.storage === 'conflict') { await this.host.reload(kind); this.host.setNetwork(kind, { problem: problems.conflict }); return }
      // Nulla è partito: senza journal l'invio non sarebbe recuperabile.
      if (!priorAttempt) await this.dispatch(kind, started.session, { type: 'save_rejected', error: { code: problems.journal.code, message: problems.journal.message } }, ticket)
      else await this.dispatch(kind, started.session, { type: 'save_outcome_unknown', error: { code: problems.journal.code, message: problems.journal.message } }, ticket)
      this.host.setNetwork(kind, { problem: problems.journal })
      return
    }
    this.host.setNetwork(kind, { activity: 'saving', problem: null })
    const command = started.session.commit!.command
    let receipt: ImportReceipt
    try {
      receipt = command.payload.kind === 'workout'
        ? await this.repository.commitWorkout(command as Extract<CommitCommand, { payload: { kind: 'workout' } }>, ticket.signal)
        : await this.repository.commitDiet(command as Extract<CommitCommand, { payload: { kind: 'diet' } }>, ticket.signal)
    } catch (error) {
      if (!this.host.isCurrent(ticket)) return // stop/logout: il journal conserva `saving`, riaperto come `save_unknown`
      if (error instanceof CommitRejected) {
        // Il replay precede ogni altro controllo: un rifiuto certo prova che nessun tentativo precedente è stato salvato.
        const rejected = await this.dispatch(kind, started.session, { type: 'save_rejected', error: { code: error.reason, message: rejectionProblems[error.reason].message } }, ticket)
        // ID tecnici già usati: la prossima conferma prenota ID nuovi (e avrà una nuova chiave).
        if (rejected && error.reason === 'request_conflict' && rejected.session.draft) await this.dispatch(kind, rejected.session, { type: 'draft_changed', draft: rejected.session.draft, reservations: null }, ticket)
        this.host.setNetwork(kind, { rejection: error.reason, problem: rejectionProblems[error.reason] })
        return
      }
      if (!(error instanceof ImportsFailure)) throw error
      const message = error.kind === 'session' ? problems.session.message : 'Esito del salvataggio non confermato: verifico con la stessa richiesta.'
      const unknown = await this.dispatch(kind, started.session, { type: 'save_outcome_unknown', error: { code: error.kind, message } }, ticket)
      if (!unknown) return
      if (error.kind === 'session') { this.host.setNetwork(kind, { problem: problems.session }); return }
      const settled = await this.lookupReceipt(kind, unknown.session, ticket)
      if (settled === 'absent') this.host.setNetwork(kind, { problem: { code: 'save_not_found', title: 'Salvataggio non confermato', message: 'Il piano non risulta ancora salvato. Puoi riprovare: verrà inviata la stessa conferma, senza creare copie.' } })
      return
    }
    await this.settle(kind, started.session, receipt, ticket)
  }

  /** Ricevuta per la stessa chiave: `settled` (salvato o eliminato), `absent` (nessun commit) o `unknown` (lettura fallita). */
  private async lookupReceipt(kind: ExtractionKind, session: ImportSession, ticket: ImportTicket): Promise<'settled' | 'absent' | 'unknown'> {
    let receipt: ImportReceipt | null
    try { receipt = await this.repository.getReceipt(session.commit!.command.requestId, ticket.signal) } catch (error) {
      if (!(error instanceof ImportsFailure)) throw error
      if (error.kind !== 'aborted' && this.host.isCurrent(ticket)) this.host.setNetwork(kind, { problem: error.kind === 'session' ? problems.session : problems.lookupFailed })
      return 'unknown'
    }
    if (this.stale(kind, session, ticket)) return 'unknown'
    if (receipt === null) return 'absent'
    return await this.settle(kind, this.host.current(kind)!, receipt, ticket) ? 'settled' : 'unknown'
  }

  private async settle(kind: ExtractionKind, session: ImportSession, receipt: ImportReceipt, ticket: ImportTicket): Promise<boolean> {
    let saved: DispatchResult | null
    try { saved = await this.dispatch(kind, session, { type: 'save_succeeded', receipt }, ticket) } catch (error) {
      if (!(error instanceof ImportStateError)) throw error
      // Ricevuta che non corrisponde al comando: non vale come «salvato».
      if (session.status === 'saving') await this.dispatch(kind, session, { type: 'save_outcome_unknown', error: { code: 'receipt_mismatch', message: error.message } }, ticket)
      this.host.setNetwork(kind, { problem: { code: 'receipt_mismatch', title: 'Esito da verificare', message: 'La conferma del server non corrisponde a questa importazione: nulla viene dato per salvato.' } })
      return false
    }
    if (!saved) return false
    this.host.setNetwork(kind, { problem: null, rejection: null, duplicates: null })
    if (receipt.resultState === 'committed') await this.runRefresh(kind, saved.session, receipt, ticket)
    return true
  }

  private async runRefresh(kind: ExtractionKind, session: ImportSession, receipt: ImportReceipt, ticket: ImportTicket) {
    if (!this.refresher) return
    this.host.setNetwork(kind, { refresh: 'pending' })
    try {
      await this.refresher(receipt, ticket.signal)
      if (this.host.isCurrent(ticket) && this.host.current(kind)?.sessionId === session.sessionId) this.host.setNetwork(kind, { refresh: 'done' })
    } catch {
      if (this.host.isCurrent(ticket) && this.host.current(kind)?.sessionId === session.sessionId) this.host.setNetwork(kind, { refresh: 'failed' })
    }
  }

  /** Solo con il biglietto ancora valido: dopo stop, logout o cambio account nessuna risposta tocca stato o journal. */
  private async dispatch(kind: ExtractionKind, session: ImportSession, event: SessionEvent, ticket: ImportTicket) {
    return this.host.isCurrent(ticket) ? this.host.dispatch(kind, session.sessionId, event) : null
  }

  private async storageOk(kind: ExtractionKind, result: DispatchResult) {
    if (result.storage === 'durable') return true
    if (result.storage === 'conflict') await this.host.reload(kind)
    this.host.setNetwork(kind, { problem: result.storage === 'conflict' ? problems.conflict : problems.journal })
    return false
  }

  private stale(kind: ExtractionKind, session: ImportSession, ticket: ImportTicket) {
    return !this.host.isCurrent(ticket) || this.host.current(kind)?.sessionId !== session.sessionId
  }

  /** Esegue un'operazione alla volta per slot, con l'attività visibile e gli errori di rete tradotti. */
  private exclusive(kind: ExtractionKind, activity: NetworkActivity, body: (session: ImportSession, ticket: ImportTicket) => Promise<void>): Promise<void> {
    const active = this.running.get(kind)
    if (active) return active
    const session = this.host.current(kind)
    if (!session) return Promise.resolve()
    const ticket = this.host.ticket()
    this.host.setNetwork(kind, { activity, problem: null })
    const run = (async () => {
      try { await body(session, ticket) } catch (error) {
        if (!this.host.isCurrent(ticket)) return
        if (error instanceof ImportsFailure) {
          if (error.kind !== 'aborted') this.host.setNetwork(kind, { problem: error.kind === 'session' ? problems.session : problems.lookupFailed })
          return
        }
        if (error instanceof ImportStateError) { this.host.setNetwork(kind, { problem: { code: error.code, title: 'Operazione non ammessa', message: error.message } }); return }
        throw error
      } finally {
        this.running.delete(kind)
        if (this.host.isCurrent(ticket)) this.host.setNetwork(kind, { activity: null })
      }
    })()
    this.running.set(kind, run)
    return run
  }
}

const runningProblem: NetworkProblem = { code: 'analysis_running', title: 'Analisi ancora in corso', message: 'L’analisi è ancora in corso sul server e non continua in background su questo dispositivo: verifica più tardi, senza avviarne una nuova.' }

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const timer = setTimeout(done, ms)
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    signal.addEventListener('abort', done, { once: true })
  })
}
