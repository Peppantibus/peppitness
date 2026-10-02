/** Invented development source, independent of personal documents and the held-out corpus. */
import type { NormalizedDocument, SourceBlock, WorkoutExtraction } from '../../../../src/import/contracts/index.ts'

export function threeSessionFixture(): { document: NormalizedDocument; extraction: WorkoutExtraction } {
  const blocks: SourceBlock[] = []
  const extraction: WorkoutExtraction = { schemaVersion: '1.0', kind: 'workout', outcome: 'extracted', title: 'Programma sintetico', guidance: [],
    schedule: 'unknown', cycle: { startDate: null, weeks: null }, sessions: [], complexRules: [], evidence: [], issues: [], unassigned: [] }
  const block = (id: string, kind: SourceBlock['kind'], text: string, extras: Partial<SourceBlock> = {}) => {
    blocks.push({ id, kind, text, page: null, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, headingIds: [], origin: 'native', bbox: null, ...extras })
  }
  const cite = (path: string, blockId: string, quote: string) => extraction.evidence.push({ path, spans: [{ blockId, quote }] })
  block('h:0', 'heading', extraction.title!)
  cite('/title', 'h:0', extraction.title!)
  for (let s = 0; s < 3; s++) {
    const heading = `h:${s + 1}`, tableId = `t:${s}`, label = String.fromCharCode(65 + s)
    block(heading, 'heading', `Seduta ${label}`)
    cite(`/sessions/${s}/label`, heading, label)
    const session: WorkoutExtraction['sessions'][number] = { label, title: null, weekday: null, notes: [], exercises: [] }
    extraction.sessions.push(session)
    for (let r = 0; r <= 6; r++) {
      const phase = s === 2 && r === 6
      const text = phase ? 'Settimane 1–4: 2 serie; terza facoltativa dalla settimana 5.' : r === 1 ? '2 + 1 facoltativa' : '3'
      const cells = r === 0 ? ['Esercizio', 'Serie', 'Ripetizioni', 'Recupero', 'RIR'] : [`Movimento ${label}${r}`, text, '8–10', '90–120 s', '2–3']
      const rowId = `${tableId}:r:${r}`
      block(rowId, 'table_row', cells.join(' | '), { tableId, row: r, headingIds: [heading] })
      cells.forEach((text, column) => block(`${rowId}:c:${column}`, 'table_cell', text, { tableId, row: r, column, parentId: rowId, headingIds: [heading] }))
      if (r === 0) continue
      const at = `/sessions/${s}/exercises/${r - 1}`
      session.exercises.push({ name: cells[0]!, variant: null, equipment: null, measurementMode: null, sets: phase ? null : r === 1 ? 2 : 3,
        optionalSets: phase ? null : r === 1 ? 1 : null, repetitions: { min: 8, max: 10 }, durationSeconds: null,
        restSeconds: { min: 90, max: 120 }, rir: { min: 2, max: 3 }, rpe: null, perSide: null, loadUnit: null, loadConvention: null,
        loadInstruction: null, tempoInstruction: null, prescriptionText: cells.join(' | '), notes: [] })
      cite(`${at}/name`, `${rowId}:c:0`, cells[0]!)
      if (!phase) { cite(`${at}/sets`, `${rowId}:c:1`, text); if (r === 1) cite(`${at}/optionalSets`, `${rowId}:c:1`, text) }
      cite(`${at}/repetitions`, `${rowId}:c:2`, cells[2]!)
      cite(`${at}/restSeconds`, `${rowId}:c:3`, cells[3]!)
      cite(`${at}/rir`, `${rowId}:c:4`, cells[4]!)
      cite(`${at}/prescriptionText`, rowId, cells.join(' | '))
      if (phase) {
        extraction.complexRules.push({ kind: 'phase', text, sourceRefs: [`${rowId}:c:1`], targetPaths: [at] })
        cite('/complexRules/0/text', `${rowId}:c:1`, text)
      }
    }
  }
  return { document: { sourceHash: 'e'.repeat(64), readerVersion: 'synthetic-recovery/1', blocks, readingIssues: [] }, extraction }
}
