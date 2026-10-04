import { exerciseMuscleGroup } from '../domain/muscle-groups'
import type { MuscleGroup } from '../domain/muscle-groups'
import chest from '../assets/muscle-groups/chest.webp'
import back from '../assets/muscle-groups/back.webp'
import shoulders from '../assets/muscle-groups/shoulders.webp'
import biceps from '../assets/muscle-groups/biceps.webp'
import triceps from '../assets/muscle-groups/triceps.webp'
import legs from '../assets/muscle-groups/legs.webp'
import glutes from '../assets/muscle-groups/glutes.webp'
import calves from '../assets/muscle-groups/calves.webp'
import abs from '../assets/muscle-groups/abs.webp'
import fullBody from '../assets/muscle-groups/full-body.webp'
import cardio from '../assets/muscle-groups/cardio.webp'
import unclassified from '../assets/muscle-groups/unclassified.webp'

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
