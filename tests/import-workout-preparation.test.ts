import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { threeSessionFixture } from './fixtures/import/recovery/workout-three-sessions.ts'
import { createReviewDraft, sequentialLocalIds } from '../src/import/review/draft.ts'
import { prepareWorkoutReview } from '../src/import/review/prepare-workout.ts'
import { chooseCatalog, setField, verifyDraft, removeItem } from '../src/import/review/decisions.ts'
import { validateDraft } from '../src/import/validation/validate.ts'
import { mapReviewedWorkout } from '../src/import/mapping/workout.ts'
import { reserveWorkoutIds } from '../src/features/import/review-model.ts'
import type { CatalogSnapshot } from '../src/import/matching/exercises.ts'
import type { WorkoutExtraction, WorkoutReviewDraft } from '../src/import/contracts/index.ts'

const empty: CatalogSnapshot = { personal: [], shared: [], complete: true }
const uuid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const source = { sourceHash: 'e'.repeat(64), readerVersion: 'synthetic-recovery/1', textNormalizationVersion: 'peppitness.text-normalization.v1' as const }
function setup() {
  const { document, extraction } = threeSessionFixture()
  const draft = createReviewDraft({ kind: 'workout', extraction, proposalId: uuid(1), jobId: null, source, localIds: sequentialLocalIds() })
  return { document, draft }
}
const exercises = (draft: WorkoutReviewDraft) => draft.current.filter(i => i.collection === 'exercises')
const edit = (d: WorkoutReviewDraft, id: string, field: string, value: any) => setField(d,id,field,value) as WorkoutReviewDraft
const catalogRow = (name: string, id = uuid(30)) => ({ id, name, variant: '', equipment: '', loadConvention: 'total' as const,
  loadUnit: 'kg' as const, measurementMode: 'reps' as const, perSide: false, note: '', archivedAt: null, revision: 1 })

test('preparation: 18 exercises with absent metadata need no per-row catalog choice; immutable, reload stable', () => {
  const { document, draft } = setup(), original = structuredClone(draft)
  const next = prepareWorkoutReview(document,draft,empty)
  assert.equal(exercises(next).length,18)
  assert.ok(exercises(next).every(i => i.catalog?.source === 'new' && i.catalog.values.measurementMode === 'reps'))
  assert.equal(validateDraft(document,next).issues.filter(i => i.code === 'catalog_choice_required').length,0)
  assert.ok(verifyDraft(next).ok)
  assert.deepEqual(draft,original)
  assert.equal(prepareWorkoutReview(document,next,empty),next)
  const restored = JSON.parse(JSON.stringify(next))
  assert.equal(prepareWorkoutReview(document,restored,empty),restored)
  let n = 100
  const ids = reserveWorkoutIds(next,null,() => uuid(n++))
  assert.equal(reserveWorkoutIds(restored,ids),ids)
})

test('preparation: repeated new identities share a key; distinct equipment and units stay separate', () => {
  const { document, draft } = setup(), [a,b,c] = exercises(draft)
  let edited = edit(draft,b!.localId,'name',a!.values.name)
  edited = edit(edited,c!.localId,'name',a!.values.name)
  edited = edit(edited,c!.localId,'equipment','Manubri')
  edited = edit(edited,c!.localId,'loadConvention','single-dumbbell')
  edited = edit(edited,c!.localId,'loadUnit','lb')
  edited = edit(edited,c!.localId,'perSide',true)
  const next = prepareWorkoutReview(document,edited,empty), [one,two,three] = exercises(next)
  assert.deepEqual(one!.catalog,two!.catalog)
  assert.notDeepEqual(one!.catalog,three!.catalog)
  assert.ok(three!.catalog?.source === 'new')
  assert.equal(three!.catalog.values.loadUnit,'lb')
  assert.equal(three!.catalog.values.perSide,true)
})

test('preparation: exact personal/shared matches; fuzzy names become new; archived and duplicate identities need choice', () => {
  const { document, draft } = setup(), name = exercises(draft)[0]!.values.name!
  const row = catalogRow(name)
  const personal = prepareWorkoutReview(document,draft,{ ...empty, personal:[row] })
  assert.equal(exercises(personal)[0]!.catalog?.source,'existing')
  const shared = prepareWorkoutReview(document,draft,{ ...empty, shared:[row] })
  assert.equal(exercises(shared)[0]!.catalog?.source,'shared')
  const fuzzy = prepareWorkoutReview(document,draft,{ ...empty, personal:[{...row,name:name+' variante'}] })
  assert.equal(exercises(fuzzy)[0]!.catalog?.source,'new')
  const archived = prepareWorkoutReview(document,draft,{ ...empty, personal:[{...row,archivedAt:'2026-10-01'}] })
  assert.equal(exercises(archived)[0]!.catalog,null)
  const ambiguous = prepareWorkoutReview(document,draft,{ ...empty, personal:[row,{...row,id:uuid(31)}] })
  assert.equal(exercises(ambiguous)[0]!.catalog,null)
  assert.equal(prepareWorkoutReview(document,draft,{...empty,complete:false}),draft)
})

test('preparation: manual catalog choice/removal wins; editing an automatically prepared identity refreshes it', () => {
  const { document, draft } = setup()
  const prepared = prepareWorkoutReview(document,draft,empty), exercise = exercises(prepared)[0]!
  const changed = prepareWorkoutReview(document,edit(prepared,exercise.localId,'name','Nome corretto'),empty)
  const binding = exercises(changed)[0]!.catalog!
  assert.ok(binding.source === 'new'); assert.equal(binding.values.name,'Nome corretto')
  assert.notEqual(binding.localKey,(exercise.catalog as any).localKey)
  const manual = chooseCatalog(changed,exercise.localId,null,{decisionId:'manual-clear'}) as WorkoutReviewDraft
  assert.equal(prepareWorkoutReview(document,manual,empty),manual)
  const copy = chooseCatalog(changed,exercise.localId,exercise.catalog,{decisionId:'manual-pick'}) as WorkoutReviewDraft
  const renamed = edit(copy,exercise.localId,'name','Altro nome')
  assert.equal(prepareWorkoutReview(document,renamed,empty),renamed)
})

test('preparation: no catalog default conceals a missing name, oversized name, or conflicting measurement', () => {
  const { document,draft } = setup(), id = exercises(draft)[0]!.localId
  for (const edited of [edit(draft,id,'name',null),edit(draft,id,'name','x'.repeat(121)),edit(draft,id,'durationSeconds',{min:30,max:30})]) {
    assert.equal(exercises(prepareWorkoutReview(document,edited,empty))[0]!.catalog,null)
  }
})

function delayed() {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/${name}`,import.meta.url),'utf8'))
  const document = read('documents/workout-spec-example.json')
  const extraction: WorkoutExtraction = read('extractions/workout-spec-example.json')
  const exercise = extraction.sessions[0]!.exercises[0]!
  exercise.sets = 2; exercise.optionalSets = 1; exercise.restSeconds = {min:120,max:120}
  exercise.prescriptionText = 'Squat | 2 x 8-10; 2 + 1 facoltativa | recupero 120 s'
  for (const block of document.blocks) {
    block.text = block.text.replace('3 x 8-10','2 x 8-10; 2 + 1 facoltativa').replace('recupero non indicato','recupero 120 s')
  }
  for (const entry of extraction.evidence) for (const span of entry.spans) span.quote = span.quote.replace('3 x 8-10','2 x 8-10; 2 + 1 facoltativa').replace('recupero non indicato','recupero 120 s')
  extraction.evidence.push({path:'/sessions/0/exercises/0/optionalSets',spans:[{blockId:'t:1:r:1',quote:'2 + 1 facoltativa'}]},
    {path:'/sessions/0/exercises/0/restSeconds',spans:[{blockId:'t:1:r:1',quote:'recupero 120 s'}]})
  extraction.issues = []
  const id = 'conditional-note', text = 'terza facoltativa da S5'
  document.blocks.push({ ...document.blocks[0], id, kind:'paragraph', text, headingIds:[] })
  extraction.complexRules.push({kind:'progression',text,sourceRefs:[id],targetPaths:['/sessions/0/exercises/0']})
  const draft = createReviewDraft({kind:'workout',extraction,proposalId:uuid(1),jobId:null,
    source:{...source,sourceHash:document.sourceHash,readerVersion:document.readerVersion},localIds:sequentialLocalIds()})
  return {document,draft}
}

test('instructions: delayed optional set is not executable from week one; instruction preserved and mapped without scope checkbox', () => {
  const { document,draft } = delayed(), before = structuredClone(draft.proposal)
  let next = prepareWorkoutReview(document,draft,empty)
  const exercise = exercises(next)[0]!, rule = next.current.find(i => i.collection === 'complexRules')!
  assert.equal(exercise.values.sets,2)
  assert.equal(exercise.values.optionalSets,0)
  assert.deepEqual(next.proposal,before)
  assert.ok(next.decisions.some(d => d.op === 'set' && d.field === 'optionalSets' && d.reason === 'scope_choice'))
  assert.ok(validateDraft(document,next).issues.some(i => i.code === 'complex_rule_preserved' && i.localId === rule.localId && i.severity === 'info'))
  assert.equal(validateDraft(document,next).provenance.find(p => p.localId === exercise.localId && p.field === 'optionalSets')!.origin,'app')
  const root = next.current.find(i => i.collection === 'root')!
  next = edit(next,root.localId,'schedule','rotation')
  const session = next.current.find(i => i.collection === 'sessions')!
  next = edit(next,session.localId,'title','Seduta A')
  let n = 100
  const mapped = mapReviewedWorkout(document,next,reserveWorkoutIds(next,null,()=>uuid(n++)))
  assert.equal(mapped.ok,true,JSON.stringify(mapped.issues))
  if(mapped.ok) {
    assert.match(mapped.value.program.guidance,/terza facoltativa da S5/)
    assert.equal(mapped.value.resolved.days[0]!.prescriptions[0]!.optionalSets,0)
  }
})

test('instructions: ambiguous base, manual active conditional set, missing target or wrong source remain unresolved', () => {
  const { document,draft } = delayed(), id = exercises(draft)[0]!.localId
  const missing = prepareWorkoutReview(document,edit(draft,id,'sets',null),empty)
  assert.ok(validateDraft(document,missing).issues.some(i => i.code === 'complex_rule_unresolved'))
  const manual = prepareWorkoutReview(document,edit(edit(draft,id,'optionalSets',0),id,'optionalSets',1),empty)
  assert.equal(exercises(manual)[0]!.values.optionalSets,1)
  assert.ok(validateDraft(document,manual).issues.some(i => i.code === 'complex_rule_unresolved'))
  const prepared = prepareWorkoutReview(document,draft,empty)
  const removed = removeItem(prepared,id) as WorkoutReviewDraft
  assert.ok(validateDraft(document,removed).issues.some(i => i.code === 'complex_rule_unresolved'))
  const bad = delayed()
  bad.document.blocks.find((b:any) => b.id === 'conditional-note').text = 'Testo diverso'
  assert.equal(exercises(prepareWorkoutReview(bad.document,bad.draft,empty))[0]!.values.optionalSets,1)
  assert.ok(validateDraft(bad.document,bad.draft).issues.some(i => i.code === 'missing_evidence'))
})
