/**
 * Comando di conferma dell'importazione (specifica §§11–12): piano già risolto, scelte del
 * catalogo, provenienza separata, opzioni di selezione e chiave idempotente. È il terzo
 * contratto, distinto dal documento normalizzato e dal DTO dell'interprete: nessun null
 * «da completare», nessuna evidence, nessun owner. Il mapping (09/10) lo produce, le RPC
 * (18–20) lo ricontrollano in SQL; qui forma, bounds del dominio e regole fra campi.
 *
 * Firme SQL congelate (argomenti UUID/JSONB, owner sempre da auth.uid()):
 *   public.commit_workout_import(p_request_id uuid, p_resolved_payload jsonb, p_provenance jsonb, p_selection_options jsonb) returns jsonb
 *   public.commit_diet_import(p_request_id uuid, p_resolved_payload jsonb, p_provenance jsonb, p_selection_options jsonb) returns jsonb
 *   public.get_import_receipt(p_request_id uuid) returns jsonb   -- null se assente; solo ricevute proprie
 * Il risultato delle due RPC è la ricevuta (ImportReceipt), identica a ogni retry dello stesso comando.
 */
import { domainLimits, domainText, isoDateSchema, requiredDomainText, trimmedDomainText } from './domain-limits.ts'
import { extractionKinds, extractionSchemaIds, proposalPointerSchema, type ExtractionKind } from './extraction.ts'
import {
  decisionReasons, exerciseChoiceSchema, exerciseChoiceValues, fieldNameSchema, localIdSchema, proposalSourceSchema,
  type ExerciseChoice, type ValidationIssue,
} from './review.ts'
import {
  array, boolean, contractLimits, enumeration, errorList, literal, nullable, number, object, refine, sha256HexSchema, uuidSchema, validate,
  type ContractError, type Infer, type Rule, type Schema, type ValidationResult,
} from './schema.ts'

// ---------------------------------------------------------------------------
// Payload risolto della scheda
// ---------------------------------------------------------------------------

const workoutLimits = domainLimits.workout
const integerIn = (range: { min: number; max: number }) => number({ integer: true, minimum: range.min, maximum: range.max })
/** Decimale in notazione semplice: la preview lo riporta nei campi testo del dominio senza esponenti. */
const plainDecimal: Rule<number> = {
  code: 'pattern', description: 'Decimale senza esponente.',
  check(value, report) { if (!/^\d+(?:\.\d+)?$/.test(String(value))) report('', 'Usare un decimale semplice, senza esponente.') },
}
const decimalIn = (range: { min: number; max: number }) => refine(number({ minimum: range.min, maximum: range.max }), [plainDecimal])

/**
 * Prescrizione eseguibile: nessun valore mancante da completare. La modalità deriva dall'esercizio
 * scelto: reps → repsMin/repsMax interi e durata null; seconds → durata e reps null.
 * Recupero sempre risolto (0 solo se esplicito o scelto); RIR/RPE null se non prescritti.
 */
export const resolvedPrescriptionSchema = object({
  /** UUID tecnico prenotato dall'app una sola volta per lo snapshot confermato. */
  id: uuidSchema,
  /** Valore di ProgramExercise.id nella preview: ID personale reale (existing) o riferimento provvisorio (shared/new). */
  exerciseRef: uuidSchema,
  sets: integerIn(workoutLimits.sets),
  optionalSets: integerIn(workoutLimits.optionalSets),
  repsMin: nullable(integerIn(workoutLimits.reps)),
  repsMax: nullable(integerIn(workoutLimits.reps)),
  durationSeconds: nullable(integerIn(workoutLimits.durationSeconds)),
  restSeconds: integerIn(workoutLimits.restSeconds),
  rir: nullable(decimalIn(workoutLimits.rir)),
  rpe: nullable(decimalIn(workoutLimits.rpe)),
  note: domainText(workoutLimits.prescriptionNote),
})
export const resolvedWorkoutDaySchema = object({
  id: uuidSchema,
  label: trimmedDomainText(workoutLimits.dayLabel),
  title: trimmedDomainText(workoutLimits.dayTitle),
  note: domainText(workoutLimits.dayNote),
  /** Una seduta pubblicata ha almeno una prescrizione (validateProgram(document, true)). */
  prescriptions: array(resolvedPrescriptionSchema, { minItems: 1, maxItems: workoutLimits.prescriptionsPerDay }),
})
/** Associazione fra il riferimento usato dalla preview e la scelta del catalogo. */
export const catalogBindingSchema = object({ ref: uuidSchema, choice: exerciseChoiceSchema })
export const resolvedCycleSchema = object({
  start: isoDateSchema(workoutLimits.cycleStart.min, workoutLimits.cycleStart.max),
  weeks: integerIn(workoutLimits.cycleWeeks),
})
export const resolvedWorkoutImportSchema = object({
  planId: uuidSchema,
  versionId: uuidSchema,
  /** Nome del programma e titolo della prima versione. */
  title: trimmedDomainText(workoutLimits.title),
  guidance: domainText(workoutLimits.guidance),
  /** Ciclo completo oppure assente: mai una sola metà. */
  cycle: nullable(resolvedCycleSchema),
  days: array(resolvedWorkoutDaySchema, { minItems: 1, maxItems: workoutLimits.days }),
  catalog: array(catalogBindingSchema, { minItems: 1, maxItems: workoutLimits.days * workoutLimits.prescriptionsPerDay }),
})

export type ResolvedPrescription = Infer<typeof resolvedPrescriptionSchema>
export type ResolvedWorkoutDay = Infer<typeof resolvedWorkoutDaySchema>
export type CatalogBinding = Infer<typeof catalogBindingSchema>
export type ResolvedCycle = Infer<typeof resolvedCycleSchema>
export type ResolvedWorkoutImport = Infer<typeof resolvedWorkoutImportSchema>

/**
 * Proiezione di preview (implementata dal mapping 09), senza cambiare i tipi di dominio:
 *   ProgramDocument { planId, id: versionId, title, guidance, days: days.map(day => ({ id, label, title, note,
 *     exercises: prescriptions.map(p => ({ id: p.id, exercise: { id: p.exerciseRef, ...exerciseChoiceValues(choice) },
 *       sets/optionalSets/restSeconds: String(n), repsMin/repsMax/durationSeconds/rir/rpe: n === null ? '' : String(n), note })) })) }
 * più ProgramCycle { start, weeks } se `cycle` non è null. Per shared/new `exercise.id` è un riferimento
 * provvisorio dichiarato in `catalog`: non è un esercizio persistito, non va passato alle RPC manuali
 * (save_workout_draft, save_workout_revision…) né al diario. La RPC di conferma sostituisce ogni ref con
 * l'ID personale reale e restituisce la corrispondenza in ImportReceipt.exerciseBindings.
 */
export const provisionalExerciseRefs = (resolved: ResolvedWorkoutImport): Set<string> =>
  new Set(resolved.catalog.filter(binding => binding.choice.source !== 'existing').map(binding => binding.ref))
/** ID fra quelli indicati che sono riferimenti provvisori della preview: devono essere zero prima di ogni scrittura manuale. */
export function findProvisionalRefs(ids: Iterable<string>, resolved: ResolvedWorkoutImport): string[] {
  const provisional = provisionalExerciseRefs(resolved)
  return [...new Set(ids)].filter(id => provisional.has(id))
}

function resolvedWorkoutErrors(resolved: ResolvedWorkoutImport, prefix: string, errors: ReturnType<typeof errorList>) {
  const technical = new Map<string, string>()
  const claim = (path: string, id: string) => {
    if (technical.has(id)) errors.add(path, 'duplicate_id', `UUID tecnico ripetuto (già in ${technical.get(id)}).`)
    else technical.set(id, path)
  }
  claim(`${prefix}/planId`, resolved.planId)
  claim(`${prefix}/versionId`, resolved.versionId)

  const bindings = new Map<string, ExerciseChoice>()
  const choiceKeys = new Set<string>()
  const existingIds = new Set(resolved.catalog.flatMap(binding => binding.choice.source === 'existing' ? [binding.choice.personalId] : []))
  resolved.catalog.forEach((binding, index) => {
    const at = `${prefix}/catalog/${index}`
    const { choice } = binding
    if (bindings.has(binding.ref)) errors.add(`${at}/ref`, 'duplicate_id', 'Riferimento del catalogo ripetuto.')
    else bindings.set(binding.ref, choice)
    const key = choice.source === 'existing' ? `existing:${choice.personalId}` : choice.source === 'shared' ? `shared:${choice.templateId}` : `new:${choice.localKey}`
    if (choiceKeys.has(key)) errors.add(`${at}/choice`, 'duplicate_ref', 'La stessa scelta compare in due associazioni: le occorrenze condividono un solo ref.')
    choiceKeys.add(key)
    if (choice.source === 'existing') {
      if (binding.ref !== choice.personalId) errors.add(`${at}/ref`, 'binding_mismatch', 'Per un esercizio esistente il ref è l’ID personale reale.')
    } else {
      if (existingIds.has(binding.ref)) errors.add(`${at}/ref`, 'binding_mismatch', 'Un riferimento provvisorio non può coincidere con un esercizio personale.')
      claim(`${at}/ref`, binding.ref)
    }
  })

  const labels = new Set<string>()
  const used = new Set<string>()
  resolved.days.forEach((day, dayIndex) => {
    const dayAt = `${prefix}/days/${dayIndex}`
    claim(`${dayAt}/id`, day.id)
    if (labels.has(day.label)) errors.add(`${dayAt}/label`, 'duplicate_id', 'Ogni seduta ha un’etichetta diversa.')
    labels.add(day.label)
    day.prescriptions.forEach((prescription, index) => {
      const at = `${dayAt}/prescriptions/${index}`
      claim(`${at}/id`, prescription.id)
      const choice = bindings.get(prescription.exerciseRef)
      if (!choice) { errors.add(`${at}/exerciseRef`, 'dangling_ref', 'Esercizio senza associazione nel catalogo.'); return }
      used.add(prescription.exerciseRef)
      const reps = exerciseChoiceValues(choice).measurementMode === 'reps'
      if (reps && (prescription.repsMin === null || prescription.repsMax === null || prescription.durationSeconds !== null)) {
        errors.add(at, 'mode_mismatch', 'Esercizio a ripetizioni: servono ripetizioni minime e massime, senza durata.')
      } else if (!reps && (prescription.durationSeconds === null || prescription.repsMin !== null || prescription.repsMax !== null)) {
        errors.add(at, 'mode_mismatch', 'Esercizio a tempo: serve la durata, senza ripetizioni.')
      }
      if (prescription.repsMin !== null && prescription.repsMax !== null && prescription.repsMin > prescription.repsMax) {
        errors.add(`${at}/repsMin`, 'range_order', 'Le ripetizioni minime superano le massime.')
      }
    })
  })
  resolved.catalog.forEach((binding, index) => {
    // Un'associazione inutilizzata creerebbe o adotterebbe un esercizio che nessuna seduta usa.
    if (!used.has(binding.ref)) errors.add(`${prefix}/catalog/${index}`, 'unused_binding', 'Associazione non usata da alcuna prescrizione.')
  })
  return technical
}

// ---------------------------------------------------------------------------
// Payload risolto della dieta
// ---------------------------------------------------------------------------

const dietLimits = domainLimits.diet
const lines = array(requiredDomainText(dietLimits.lineChars), { maxItems: dietLimits.linesPerList })
export const resolvedFoodSchema = object({ name: requiredDomainText(dietLimits.foodName), quantity: domainText(dietLimits.foodQuantity) })
export const resolvedMealSchema = object({
  id: uuidSchema,
  name: requiredDomainText(dietLimits.mealName),
  time: domainText(dietLimits.mealTime),
  foods: array(resolvedFoodSchema, { maxItems: dietLimits.foodsPerMeal }),
  alternatives: lines,
  additions: lines,
  note: domainText(dietLimits.note),
})
export const resolvedDietDaySchema = object({
  id: uuidSchema,
  name: requiredDomainText(dietLimits.dayName),
  /** Tipo scelto o confermato: `any` è una scelta, mai il sostituto di un tipo ignoto. */
  dayType: enumeration(['training', 'rest', 'any']),
  note: domainText(dietLimits.note),
  meals: array(resolvedMealSchema, { minItems: 1, maxItems: dietLimits.mealsPerDay }),
})
/** MealPlanDraft del dominio con le stesse proprietà chiuse; almeno una giornata con pasti: un piano vuoto non è un import riuscito. */
export const resolvedMealPlanSchema = object({
  id: uuidSchema,
  name: trimmedDomainText(dietLimits.name),
  document: object({
    guidance: domainText(dietLimits.guidance),
    days: array(resolvedDietDaySchema, { minItems: 1, maxItems: dietLimits.days }),
  }),
})
/** La provenienza resta fuori da `meal_plans.document`, nel comando e nella ricevuta. */
export const resolvedDietImportSchema = object({ plan: resolvedMealPlanSchema })

export type ResolvedFood = Infer<typeof resolvedFoodSchema>
export type ResolvedMeal = Infer<typeof resolvedMealSchema>
export type ResolvedDietDay = Infer<typeof resolvedDietDaySchema>
export type ResolvedMealPlan = Infer<typeof resolvedMealPlanSchema>
export type ResolvedDietImport = Infer<typeof resolvedDietImportSchema>

const utf8Length = (text: string) => new TextEncoder().encode(text).length

function resolvedDietErrors(resolved: ResolvedDietImport, prefix: string, errors: ReturnType<typeof errorList>) {
  const technical = new Map<string, string>()
  const claim = (path: string, id: string) => {
    if (technical.has(id)) errors.add(path, 'duplicate_id', `UUID tecnico ripetuto (già in ${technical.get(id)}).`)
    else technical.set(id, path)
  }
  claim(`${prefix}/plan/id`, resolved.plan.id)
  resolved.plan.document.days.forEach((day, dayIndex) => {
    claim(`${prefix}/plan/document/days/${dayIndex}/id`, day.id)
    day.meals.forEach((meal, index) => claim(`${prefix}/plan/document/days/${dayIndex}/meals/${index}/id`, meal.id))
  })
  const bytes = utf8Length(JSON.stringify(resolved.plan.document))
  if (bytes > dietLimits.documentBytes) errors.add(`${prefix}/plan/document`, 'too_large', `Documento di ${bytes} byte: il limite è ${dietLimits.documentBytes}.`)
  return technical
}

// ---------------------------------------------------------------------------
// Provenienza, opzioni di selezione e comando
// ---------------------------------------------------------------------------

export const IMPORT_COMMIT_PROTOCOL_VERSION = 'peppitness.import-commit.v1'
export const IMPORT_PROVENANCE_FORMAT = 'peppitness.import-provenance.v1'
/** MVP: solo nuovo piano. Una futura «nuova versione di questo programma» richiede un nuovo valore esplicito. */
export const importCommitModes = ['create_new'] as const

/**
 * Provenienza minima, separata dalle tabelle del dominio: quale analisi, quale elemento locale
 * e quali campi vengono da decisioni dell'utente. Nessun testo del documento né dati del provider.
 */
export const importProvenanceSchema = object({
  formatVersion: literal(IMPORT_PROVENANCE_FORMAT),
  kind: enumeration(extractionKinds),
  analysis: object({
    jobId: nullable(uuidSchema),
    proposalId: uuidSchema,
    proposalVersion: number({ integer: true, minimum: 1 }),
    schemaId: enumeration([extractionSchemaIds.workout, extractionSchemaIds.diet]),
    source: proposalSourceSchema,
  }),
  items: array(object({
    localId: localIdSchema,
    /** UUID tecnico dell'elemento salvato (seduta/prescrizione, giornata/pasto); null per il piano. */
    targetId: nullable(uuidSchema),
    /** Elemento della proposta; null se aggiunto dall'utente. */
    sourcePointer: nullable(proposalPointerSchema),
    decisions: array(object({ field: nullable(fieldNameSchema), reason: enumeration(decisionReasons) }), { maxItems: contractLimits.refsPerItem }),
  }), { maxItems: contractLimits.largeItems }),
})

/**
 * follow=false (default) non modifica alcuna sezione di active_plans. follow=true aggiorna solo la
 * sezione del comando, se la revisione di active_plans è ancora quella vista: expectedActiveRevision
 * null significa «nessuna selezione esistente vista», non «ignora i conflitti».
 */
export const selectionOptionsSchema = refine(object({
  follow: boolean(),
  expectedActiveRevision: nullable(number({ integer: true, minimum: 1 })),
}), [{
  code: 'selection_options', description: 'Senza follow la revisione attesa è null.',
  check(options, report) { if (!options.follow && options.expectedActiveRevision !== null) report('/expectedActiveRevision', 'Senza «Inizia a seguirlo» non si indica una revisione della selezione.') },
}])
export const defaultSelectionOptions: SelectionOptions = Object.freeze({ follow: false, expectedActiveRevision: null })

const payloadHead = { protocolVersion: literal(IMPORT_COMMIT_PROTOCOL_VERSION), mode: enumeration(importCommitModes) }
export const workoutCommitPayloadSchema = object({ ...payloadHead, kind: literal('workout'), resolved: resolvedWorkoutImportSchema })
export const dietCommitPayloadSchema = object({ ...payloadHead, kind: literal('diet'), resolved: resolvedDietImportSchema })

/**
 * Comando congelato prima dell'invio (07 lo conserva con il requestId). requestId: UUID
 * dell'operazione, generato una volta; invariato su retry; nuovo solo per un comando
 * esplicitamente diverso o una copia voluta. Nessun owner: il server usa auth.uid().
 */
export const workoutCommitCommandSchema = object({
  requestId: uuidSchema,
  payload: workoutCommitPayloadSchema,
  provenance: importProvenanceSchema,
  selectionOptions: selectionOptionsSchema,
})
export const dietCommitCommandSchema = object({
  requestId: uuidSchema,
  payload: dietCommitPayloadSchema,
  provenance: importProvenanceSchema,
  selectionOptions: selectionOptionsSchema,
})
export const commitCommandSchemas = { workout: workoutCommitCommandSchema, diet: dietCommitCommandSchema } as const

export type ImportProvenance = Infer<typeof importProvenanceSchema>
export type SelectionOptions = Infer<typeof selectionOptionsSchema>
export type ImportCommitMode = typeof importCommitModes[number]
export type WorkoutCommitPayload = Infer<typeof workoutCommitPayloadSchema>
export type DietCommitPayload = Infer<typeof dietCommitPayloadSchema>
export type CommitPayload = WorkoutCommitPayload | DietCommitPayload
export type WorkoutCommitCommand = Infer<typeof workoutCommitCommandSchema>
export type DietCommitCommand = Infer<typeof dietCommitCommandSchema>
export type CommitCommand = WorkoutCommitCommand | DietCommitCommand
export type CommitCommandFor<K extends ExtractionKind> = K extends 'workout' ? WorkoutCommitCommand : DietCommitCommand

function commandErrors(command: CommitCommand): ContractError[] {
  const errors = errorList()
  const { payload, provenance } = command
  const technical = payload.kind === 'workout'
    ? resolvedWorkoutErrors(payload.resolved, '/payload/resolved', errors)
    : resolvedDietErrors(payload.resolved, '/payload/resolved', errors)
  if (provenance.kind !== payload.kind) errors.add('/provenance/kind', 'kind_mismatch', 'Provenienza di un altro dominio.')
  if (provenance.analysis.schemaId !== extractionSchemaIds[payload.kind]) errors.add('/provenance/analysis/schemaId', 'kind_mismatch', 'Schema dell’analisi di un altro dominio.')
  const provisional = payload.kind === 'workout' ? provisionalExerciseRefs(payload.resolved) : new Set<string>()
  const localIds = new Set<string>()
  provenance.items.forEach((item, index) => {
    const at = `/provenance/items/${index}`
    if (localIds.has(item.localId)) errors.add(`${at}/localId`, 'duplicate_id', 'Elemento locale ripetuto nella provenienza.')
    localIds.add(item.localId)
    if (item.targetId !== null && (!technical.has(item.targetId) || provisional.has(item.targetId))) {
      errors.add(`${at}/targetId`, 'dangling_ref', 'La provenienza indica un elemento assente dal piano.')
    }
  })
  return errors.errors
}

/** Forma, bounds del dominio, UUID tecnici unici, associazioni del catalogo e provenienza coerenti. */
export function validateCommitCommand<K extends ExtractionKind>(kind: K, value: unknown): ValidationResult<CommitCommandFor<K>> {
  const shape = validate<unknown>(commitCommandSchemas[kind], value) as ValidationResult<CommitCommand>
  if (!shape.ok) return shape
  const errors = commandErrors(shape.value)
  return (errors.length ? { ok: false, errors } : shape) as ValidationResult<CommitCommandFor<K>>
}
export const validateWorkoutCommitCommand = (value: unknown) => validateCommitCommand('workout', value)
export const validateDietCommitCommand = (value: unknown) => validateCommitCommand('diet', value)

/** Nomi delle RPC import: solo `authenticated`, mai scrittura diretta delle ricevute dal client. */
export const importRpcNames = { workout: 'commit_workout_import', diet: 'commit_diet_import', receipt: 'get_import_receipt' } as const
export interface CommitRpcArgs { p_request_id: string; p_resolved_payload: CommitPayload; p_provenance: ImportProvenance; p_selection_options: SelectionOptions }
/** Argomenti della RPC del dominio del comando: nessun campo aggiunto o tolto rispetto al comando congelato. */
export function commitRpcArgs(command: CommitCommand): CommitRpcArgs {
  return { p_request_id: command.requestId, p_resolved_payload: command.payload, p_provenance: command.provenance, p_selection_options: command.selectionOptions }
}

/**
 * Esiti di errore delle RPC di conferma (SQLSTATE + messaggio stabile, come le RPC esistenti).
 * Una ricevuta `deleted` non è un errore: è il risultato restituito a un vecchio retry.
 */
export const commitRpcErrors = {
  authentication: { sqlstate: '42501', message: 'Authentication required' },
  /** ID del catalogo o job non visibili all'utente: nessun dettaglio su dati altrui. */
  notAvailable: { sqlstate: '42501', message: 'Import reference not available' },
  invalidCommand: { sqlstate: '22023', message: 'Invalid import command' },
  requestConflict: { sqlstate: 'PT409', message: 'Import request conflict' },
  selectionConflict: { sqlstate: 'PT409', message: 'Active selection conflict' },
  catalogConflict: { sqlstate: 'PT409', message: 'Catalog changed' },
  /** Job dell'analisi scaduto dopo la preparazione del comando (HTTP 410): nessuna scrittura, serve una nuova analisi. */
  analysisExpired: { sqlstate: 'PT410', message: 'Import analysis expired' },
} as const

// ---------------------------------------------------------------------------
// Ricevuta
// ---------------------------------------------------------------------------

/**
 * existing: esercizio personale usato così com'è; adopted: template adottato ora; already_adopted:
 * copia personale del template già presente, attiva e identica ai valori visti; created: nuovo
 * esercizio. Copia archiviata o diversa dai valori visti, esercizio con revisione cambiata:
 * catalogConflict, mai riattivazione o rinomina.
 */
export const exerciseBindingResolutions = ['existing', 'adopted', 'already_adopted', 'created'] as const
export const receiptResultStates = ['committed', 'deleted'] as const

/**
 * Ricevuta idempotente (unique owner+requestId). L'owner non compare: è derivato dal server e
 * la lettura restituisce solo ricevute proprie. `selection` è la riga active_plans risultante
 * quando follow=true, null quando la selezione non è stata toccata. Dopo l'eliminazione del piano
 * la ricevuta resta con resultState `deleted` e impedisce che un vecchio retry lo ricrei.
 */
export const importReceiptSchema = object({
  requestId: uuidSchema,
  kind: enumeration(extractionKinds),
  commandHash: sha256HexSchema,
  contentHash: sha256HexSchema,
  resultState: enumeration(receiptResultStates),
  planId: uuidSchema,
  /** Versione pubblicata creata (scheda); null per la dieta. */
  versionId: nullable(uuidSchema),
  exerciseBindings: array(object({ ref: uuidSchema, exerciseId: uuidSchema, resolution: enumeration(exerciseBindingResolutions) }), { maxItems: workoutLimits.days * workoutLimits.prescriptionsPerDay }),
  selection: nullable(object({
    revision: number({ integer: true, minimum: 1 }),
    workoutPlanId: nullable(uuidSchema),
    mealPlanId: nullable(uuidSchema),
  })),
})
export type ExerciseBindingResolution = typeof exerciseBindingResolutions[number]
export type ReceiptResultState = typeof receiptResultStates[number]
export type ImportReceipt = Infer<typeof importReceiptSchema>
export type ExerciseBindingResult = ImportReceipt['exerciseBindings'][number]

function receiptErrors(receipt: ImportReceipt): ContractError[] {
  const errors = errorList()
  if (receipt.kind === 'diet') {
    if (receipt.versionId !== null) errors.add('/versionId', 'kind_mismatch', 'Una dieta non ha versioni.')
    if (receipt.exerciseBindings.length) errors.add('/exerciseBindings', 'kind_mismatch', 'Una dieta non ha esercizi.')
  } else if (receipt.versionId === null) errors.add('/versionId', 'kind_mismatch', 'Una scheda salvata ha una versione pubblicata.')
  const refs = new Set<string>()
  receipt.exerciseBindings.forEach((binding, index) => {
    if (refs.has(binding.ref)) errors.add(`/exerciseBindings/${index}/ref`, 'duplicate_id', 'Riferimento ripetuto.')
    refs.add(binding.ref)
    if ((binding.resolution === 'existing') !== (binding.ref === binding.exerciseId)) {
      errors.add(`/exerciseBindings/${index}`, 'binding_mismatch', 'Solo un esercizio esistente conserva il proprio ID come ref.')
    }
  })
  const section = receipt.kind === 'workout' ? receipt.selection?.workoutPlanId : receipt.selection?.mealPlanId
  if (receipt.selection !== null && section !== receipt.planId) errors.add('/selection', 'selection_options', 'La selezione risultante non segue il piano importato.')
  return errors.errors
}

export function validateImportReceipt(value: unknown): ValidationResult<ImportReceipt> {
  const shape = validate(importReceiptSchema, value)
  if (!shape.ok) return shape
  const errors = receiptErrors(shape.value)
  return errors.length ? { ok: false, errors } : shape
}

/**
 * Una ricevuta valida vale come «salvato» solo se corrisponde al comando inviato: stessa chiave,
 * dominio, hash calcolato localmente, piano/versione prenotati, follow e riferimenti del catalogo.
 */
export function receiptMismatches(receipt: ImportReceipt, command: CommitCommand, expectedCommandHash: string): ContractError[] {
  const errors = errorList()
  if (receipt.requestId !== command.requestId) errors.add('/requestId', 'binding_mismatch', 'Ricevuta di un’altra operazione.')
  if (receipt.kind !== command.payload.kind) errors.add('/kind', 'kind_mismatch', 'Ricevuta di un altro dominio.')
  if (receipt.commandHash !== expectedCommandHash) errors.add('/commandHash', 'binding_mismatch', 'La ricevuta riguarda un comando diverso.')
  const planId = command.payload.kind === 'workout' ? command.payload.resolved.planId : command.payload.resolved.plan.id
  if (receipt.planId !== planId) errors.add('/planId', 'binding_mismatch', 'Piano diverso da quello prenotato.')
  if (command.payload.kind === 'workout' && receipt.versionId !== command.payload.resolved.versionId) errors.add('/versionId', 'binding_mismatch', 'Versione diversa da quella prenotata.')
  if (receipt.resultState === 'committed' && command.selectionOptions.follow !== (receipt.selection !== null)) {
    errors.add('/selection', 'selection_options', 'La selezione risultante non corrisponde alla scelta «Inizia a seguirlo».')
  }
  const expected = command.payload.kind === 'workout' ? command.payload.resolved.catalog : []
  const received = new Map(receipt.exerciseBindings.map(binding => [binding.ref, binding]))
  if (received.size !== expected.length) errors.add('/exerciseBindings', 'binding_mismatch', 'Numero di associazioni diverso dal comando.')
  for (const binding of expected) {
    const result = received.get(binding.ref)
    const allowed = binding.choice.source === 'existing' ? ['existing'] : binding.choice.source === 'shared' ? ['adopted', 'already_adopted'] : ['created']
    if (!result || !allowed.includes(result.resolution)) errors.add('/exerciseBindings', 'binding_mismatch', `Associazione assente o incoerente per ${binding.ref}.`)
  }
  return errors.errors
}

// ---------------------------------------------------------------------------
// Risultato dei mapper
// ---------------------------------------------------------------------------

/**
 * Esito unico dei mapper 09/10: un valore salvabile senza problemi bloccanti, oppure solo
 * problemi. Non esiste un output «quasi valido» dichiarato salvabile.
 */
export type MappingResult<T> =
  | { ok: true; value: T; issues: ValidationIssue[] }
  | { ok: false; issues: ValidationIssue[] }

/**
 * Chiude un mapping: con un problema bloccante o senza valore l'esito è un fallimento; se
 * `contract` rifiuta il valore, il fallimento riceve un problema bloccante `resolved_contract_violation`.
 * Un fallimento senza alcun problema bloccante è un errore di programmazione del mapper.
 */
export function finishMapping<T>(value: T | null, issues: readonly ValidationIssue[], contract?: (value: T) => ValidationResult<unknown>): MappingResult<T> {
  const all = [...issues]
  if (value !== null && contract && !all.some(issue => issue.severity === 'blocking')) {
    const checked = contract(value)
    if (!checked.ok) {
      const first = checked.errors[0]!
      all.push({
        code: 'resolved_contract_violation', severity: 'blocking', stage: 'mapping', localId: null, sourcePath: '', sourceRefs: [],
        message: `Il piano risolto viola il contratto di conferma (${first.code} in "${first.path}").`, resolutions: ['user_edit'],
      })
    }
  }
  if (all.some(issue => issue.severity === 'blocking')) return { ok: false, issues: all }
  if (value === null) throw new TypeError('finishMapping: un mapping senza valore deve riportare un problema bloccante.')
  return { ok: true, value, issues: all }
}

/** Adattatore per `finishMapping` sul payload del dominio indicato. */
export const resolvedPayloadContract = {
  workout: (value: ResolvedWorkoutImport) => {
    const shape = validate(resolvedWorkoutImportSchema, value)
    if (!shape.ok) return shape
    const errors = errorList()
    resolvedWorkoutErrors(shape.value, '', errors)
    return errors.errors.length ? { ok: false as const, errors: errors.errors } : shape
  },
  diet: (value: ResolvedDietImport) => {
    const shape = validate(resolvedDietImportSchema, value)
    if (!shape.ok) return shape
    const errors = errorList()
    resolvedDietErrors(shape.value, '', errors)
    return errors.errors.length ? { ok: false as const, errors: errors.errors } : shape
  },
} satisfies Record<ExtractionKind, (value: never) => ValidationResult<unknown>>

/** Schema del payload risolto per dominio, per chi deve derivarne il JSON Schema o i campi. */
export const resolvedPayloadSchemas: { workout: Schema<ResolvedWorkoutImport>; diet: Schema<ResolvedDietImport> } = {
  workout: resolvedWorkoutImportSchema, diet: resolvedDietImportSchema,
}
