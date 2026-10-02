import { muscleGroupLabel } from '../domain/muscle-groups'
import { MuscleGroupImage } from './MuscleGroupImage'

export function MuscleGroupBadge({ exercise, illustrated = true }: { exercise: Parameters<typeof muscleGroupLabel>[0]; illustrated?: boolean }) {
  return <span className="muscle-group-badge">{illustrated && <MuscleGroupImage exercise={exercise} compact />}{muscleGroupLabel(exercise)}</span>
}
