import { exerciseMuscleGroup } from '../domain/muscle-groups'
import type { MuscleGroup } from '../domain/muscle-groups'
import chest from '../assets/muscle-groups/chest.png'
import back from '../assets/muscle-groups/back.png'
import shoulders from '../assets/muscle-groups/shoulders.png'
import biceps from '../assets/muscle-groups/biceps.png'
import triceps from '../assets/muscle-groups/triceps.png'
import legs from '../assets/muscle-groups/legs.png'
import glutes from '../assets/muscle-groups/glutes.png'
import calves from '../assets/muscle-groups/calves.png'
import abs from '../assets/muscle-groups/abs.png'
import fullBody from '../assets/muscle-groups/full-body.png'
import cardio from '../assets/muscle-groups/cardio.png'
import unclassified from '../assets/muscle-groups/unclassified.png'

const images: Record<MuscleGroup, string> = {
  Petto: chest, Schiena: back, Spalle: shoulders, Bicipiti: biceps,
  Tricipiti: triceps, Gambe: legs, Glutei: glutes, Polpacci: calves,
  Addome: abs, 'Full body': fullBody, Cardio: cardio,
}

/** Il badge testuale adiacente dà il nome accessibile; l'immagine è decorativa. */
export function MuscleGroupImage({ exercise, compact = false }: {
  exercise: Parameters<typeof exerciseMuscleGroup>[0]; compact?: boolean
}) {
  const group = exerciseMuscleGroup(exercise)
  return <img className={`muscle-group-image${compact ? ' is-compact' : ''}`}
    src={group ? images[group] : unclassified} alt="" aria-hidden="true"
    width={compact ? 24 : 52} height={compact ? 24 : 52} decoding="async" />
}
