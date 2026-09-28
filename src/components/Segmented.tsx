import type { ReactNode } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  icon?: IconName
  /** Nome accessibile quando l'etichetta visibile è abbreviata (es. «A» per una seduta). */
  ariaLabel?: string
  /** Piccolo punto accanto all'etichetta (es. seduta suggerita); il significato va nel nome accessibile. */
  dot?: boolean
}

/**
 * Scelta singola tra poche opzioni: stesso aspetto e comportamento in tutta l'app
 * (tipo di giornata, seduta A/B, catalogo, misura e carico nel wizard).
 */
export function Segmented<T extends string>({ value, options, onChange, label, labelledBy, className = '' }: {
  value: T; options: SegmentedOption<T>[]; onChange: (value: T) => void
  label?: string; labelledBy?: string; className?: string
}) {
  return <div className={`segmented ${className}`} role="group" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy}>
    {options.map(option => <button key={option.value} type="button" aria-pressed={option.value === value} aria-label={option.ariaLabel} onClick={() => onChange(option.value)}>
      {option.icon && <Icon name={option.icon} size={16} />}{option.label}{option.dot && <span className="segmented-dot" aria-hidden="true" />}
    </button>)}
  </div>
}
