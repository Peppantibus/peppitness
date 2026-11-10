import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../components/Icon'

/** Le azioni restano montate: chiudere il menu non chiude il pannello di sostituzione. */
export function ExerciseCardMenu({ id, name, actions, onHistory, onDetails, onCollapse }: {
  id: string; name: string; actions?: ReactNode; onHistory?: () => void; onDetails: () => void; onCollapse?: () => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const contentId = `exercise-options-${id}`
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || root.current?.querySelector('dialog[open]')) return
      event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [open])
  return <div ref={root} className={`exercise-card-menu${open ? ' is-open' : ''}`}>
    <button ref={trigger} type="button" className="icon-button exercise-menu-trigger" aria-label={`Opzioni per ${name}`} aria-expanded={open} aria-controls={contentId}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (event.key !== 'ArrowDown') return
        event.preventDefault(); setOpen(true)
        requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.exercise-menu-content button:not(:disabled)')?.focus())
      }}><Icon name="more" size={24} strokeWidth={2.5} /></button>
    <div id={contentId} className="exercise-menu-content" role={open ? 'group' : undefined} aria-label={open ? `Azioni per ${name}` : undefined}
      onClickCapture={event => {
        if (!(event.target instanceof Element) || event.target.closest('dialog') || !event.target.closest('button')) return
        setOpen(false); trigger.current?.focus({ preventScroll: true })
      }} onKeyDown={event => {
        if (event.target instanceof Element && event.target.closest('dialog')) return
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key)) return
        if (event.key === 'Tab') { setOpen(false); return }
        event.preventDefault()
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('.exercise-menu-content button:not(:disabled)') ?? [])]
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[index]?.focus()
      }}>
      {actions}
      <div className="exercise-menu-static">
        {onHistory && <button type="button" className="text-button history-peek" onClick={onHistory}><Icon name="history" size={20} />Storico</button>}
        <button type="button" className="text-button exercise-details" onClick={onDetails}><Icon name="info" size={20} />Dettagli</button>
        {onCollapse && <button type="button" className="text-button set-collapse" onClick={onCollapse}><Icon name="chevronDown" size={20} />Riduci</button>}
      </div>
    </div>
  </div>
}
