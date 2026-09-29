import { Icon } from '../../components/Icon'
import type { ReadingIssue } from '../../import/contracts/index.ts'
import { readingIssueClasses } from '../../import/validation/coverage.ts'
import './import.css'

type Group = 'not_read' | 'uncertain' | 'notes'
const groupOf = (code: string): Group => {
  const kind = readingIssueClasses[code] ?? 'reading_uncertain'
  return kind === 'source_not_read' || kind === 'source_hidden_content' ? 'not_read' : kind === 'reading_note' ? 'notes' : 'uncertain'
}
const groups: { key: Group; title: string; help: string }[] = [
  { key: 'not_read', title: 'Parti non lette', help: 'Questo contenuto non è stato letto e non verrà usato: controllalo sul documento originale.' },
  { key: 'uncertain', title: 'Da controllare sul documento', help: 'Il testo è stato letto, ma la posizione o l’ordine di alcuni valori potrebbe non essere quello giusto.' },
  { key: 'notes', title: 'Avvisi di lettura', help: 'Informazioni su come è stato letto il documento.' },
]

/** Il documento non ha pagine leggibili come testo (solo scansioni o immagini). */
export const onlyScans = (issues: readonly ReadingIssue[], blockCount: number) => blockCount === 0 && issues.some(issue => issue.code === 'no_text_layer')
/** La lettura ha lasciato parti non lette: il documento non va presentato come letto per intero. */
export const hasUnreadParts = (issues: readonly ReadingIssue[]) => issues.some(issue => groupOf(issue.code) === 'not_read')

/**
 * Problemi del reader (task 11), raggruppati con la classificazione applicativa della validazione
 * (`readingIssueClasses`). I messaggi sono quelli del reader, mostrati come testo. `onShow` porta ai blocchi
 * citati nella fonte; le pagine scansionate sono dichiarate non lette, senza OCR né estrazione.
 */
export function ImportIssues({ issues, blockCount, onShow, headingLevel = 2 }: {
  issues: readonly ReadingIssue[]
  blockCount: number
  onShow?: (blockIds: readonly string[]) => void
  headingLevel?: 2 | 3
}) {
  const Heading = `h${headingLevel}` as const
  const Sub = `h${headingLevel + 1}` as 'h3' | 'h4'
  const scans = issues.filter(issue => issue.code === 'no_text_layer')
  return <section className="panel import-issues" aria-labelledby="import-issues-title">
    <Heading id="import-issues-title">Come è stato letto</Heading>
    {scans.length > 0 && <div className="import-callout is-warning">
      <Icon name="alert" size={20} />
      <div>
        <strong>{onlyScans(issues, blockCount) ? 'Nessun testo leggibile: sembra una scansione' : `Pagine da leggere come immagine: ${scans.length}`}</strong>
        <p>{onlyScans(issues, blockCount)
          ? 'Il documento contiene solo immagini di pagine, senza testo. Serve una lettura da immagine, che non è ancora disponibile: non è stato letto nulla. Prova con il file Word originale o con un PDF esportato con il testo.'
          : 'Alcune pagine sono scansioni o immagini senza testo. Richiedono una lettura da immagine, non ancora disponibile: il loro contenuto non è stato letto e non verrà usato.'}</p>
      </div>
    </div>}
    {issues.length === 0 ? <p className="import-issues-none"><Icon name="check" size={20} />Nessun problema segnalato: il testo del documento è stato letto per intero.</p>
      : groups.map(group => {
        const entries = issues.filter(issue => groupOf(issue.code) === group.key)
        if (!entries.length) return null
        const list = <ul className="import-issue-list">{entries.map((issue, index) => <li key={`${issue.code}-${index}`} className={`import-issue is-${group.key}`}>
          <p>{issue.message}</p>
          {onShow && issue.sourceRefs.length > 0 && <button type="button" className="text-button" onClick={() => onShow(issue.sourceRefs)}>
            Mostra nel testo{issue.sourceRefs.length > 1 ? ` (${issue.sourceRefs.length} punti)` : ''}
          </button>}
        </li>)}</ul>
        return group.key === 'notes'
          ? <details key={group.key} className="import-issue-group is-notes"><summary><Sub>{group.title} ({entries.length})</Sub></summary><p className="field-help">{group.help}</p>{list}</details>
          : <div key={group.key} className={`import-issue-group is-${group.key}`}><Sub>{group.title} ({entries.length})</Sub><p className="field-help">{group.help}</p>{list}</div>
      })}
  </section>
}
