import { muscleGroups, unclassifiedLabel } from '../domain/muscle-groups'
import type { MuscleGroup, MuscleGroupFilter } from '../domain/muscle-groups'

export function MuscleGroupSelect(props: {
  id: string; value: MuscleGroup | ''; onChange: (value: MuscleGroup | null) => void; filter?: false; disabled?: boolean
} | {
  id: string; value: MuscleGroupFilter; onChange: (value: MuscleGroupFilter) => void; filter: true; disabled?: boolean
}) {
  return <label className="muscle-group-select" htmlFor={props.id}>Gruppo muscolare<select id={props.id} value={props.value} disabled={props.disabled} onChange={event => {
    if (props.filter) props.onChange(event.target.value as MuscleGroupFilter)
    else props.onChange((event.target.value || null) as MuscleGroup | null)
  }}>
    {props.filter && <option value="all">Tutti i gruppi</option>}
    <option value={props.filter ? 'unclassified' : ''}>{unclassifiedLabel}</option>
    {muscleGroups.map(group => <option key={group} value={group}>{group}</option>)}
  </select></label>
}
