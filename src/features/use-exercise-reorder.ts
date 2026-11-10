import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type { HTMLAttributes } from 'react'
import type { ExercisePrescription } from '../domain/types'

type Gesture = {
  id: string; ids: string[]; pointerId?: number; x: number; y: number; moved: boolean
  card: HTMLElement; touch: boolean
}

export type ReorderCardProps = HTMLAttributes<HTMLElement> & { 'data-reorder-active'?: boolean }
const controls = 'input, textarea, select, label, a, button:not(.set-summary), .exercise-card-menu, dialog, [role="dialog"], [contenteditable]:not([contenteditable="false"]), [role="button"]'

/** La cattura sulla lista resta stabile anche quando cambiano posizione e altezza delle card. */
export function useExerciseReorder(exercises: ExercisePrescription[], onCommit: (ids: string[]) => void, enabled: boolean) {
  const container = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const pending = useRef<{ timer: number; pointerId: number; x: number; y: number } | null>(null)
  const frame = useRef(0)
  const lastFrame = useRef(0)
  const suppressClick = useRef(false)
  const [draft, setDraft] = useState<string[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [minHeight, setMinHeight] = useState<number>()
  const items = draft ? draft.flatMap(id => exercises.filter(exercise => exercise.id === id)) : exercises

  const cancelPending = () => {
    if (pending.current) window.clearTimeout(pending.current.timer)
    pending.current = null
  }
  const finish = (commit: boolean, restoreFocus = true) => {
    cancelPending()
    cancelAnimationFrame(frame.current)
    const current = gesture.current
    if (!current) return
    gesture.current = null
    if (commit) onCommit(current.ids)
    setAnnouncement(commit ? 'Ordine della seduta salvato.' : 'Spostamento annullato.')
    setDraft(null); setActiveId(null); setMinHeight(undefined)
    if (current.pointerId !== undefined) suppressClick.current = true
    // Dopo l'espansione l'esercizio resta raggiungibile, senza salti al vecchio posto.
    if (restoreFocus) requestAnimationFrame(() => {
      if (!current.card.isConnected) return
      current.card.focus({ preventScroll: true })
      const heading = current.card.querySelector('.set-card-heading, .set-summary') ?? current.card
      heading.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    })
  }
  const place = (index: number) => {
    const current = gesture.current
    if (!current) return
    const ids = current.ids.filter(id => id !== current.id)
    ids.splice(Math.max(0, Math.min(index, ids.length)), 0, current.id)
    if (ids.every((id, i) => id === current.ids[i])) return
    current.ids = ids
    setDraft(ids)
    const name = exercises.find(exercise => exercise.id === current.id)?.name
    setAnnouncement(`${name}, posizione ${ids.indexOf(current.id) + 1} di ${ids.length}.`)
  }
  const track = () => {
    const current = gesture.current
    if (!current || !current.moved || current.pointerId === undefined || !container.current) return
    const rows = [...container.current.querySelectorAll<HTMLElement>('[data-reorder-id]')].filter(row => row.dataset.reorderId !== current.id)
    const index = rows.findIndex(row => { const rect = row.getBoundingClientRect(); return current.y < rect.top + rect.height / 2 })
    place(index < 0 ? rows.length : index)
  }
  const step = useEffectEvent((time: number) => {
    const current = gesture.current
    if (!current || current.pointerId === undefined) return
    // Lascia spazio alla navigazione e al timer fisso, e non scorre oltre la lista compatta.
    const rows = container.current?.querySelectorAll<HTMLElement>('[data-reorder-id]')
    if (current.moved && rows?.length) {
      const top = rows[0]!.getBoundingClientRect().top
      const bottom = rows[rows.length - 1]!.getBoundingClientRect().bottom
      const edge = 100, lower = window.innerHeight - 140
      const speed = current.y < edge && top < edge ? -Math.min(12, (edge - current.y) / 5)
        : current.y > lower && bottom > lower ? Math.min(12, (current.y - lower) / 5) : 0
      const elapsed = Math.min(32, time - lastFrame.current || 16)
      if (speed) { window.scrollBy(0, speed * elapsed / 16); track() }
    }
    lastFrame.current = time
  })
  const begin = (id: string, card: HTMLElement, point?: { pointerId: number; x: number; y: number; touch: boolean }) => {
    if (!enabled || gesture.current) return
    cancelPending()
    const ids = exercises.map(exercise => exercise.id)
    gesture.current = { id, ids, card, moved: false, x: point?.x ?? 0, y: point?.y ?? 0, pointerId: point?.pointerId, touch: point?.touch ?? false }
    setMinHeight(container.current?.getBoundingClientRect().height)
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur()
    card.focus({ preventScroll: true })
    if (point) { container.current?.setPointerCapture(point.pointerId); suppressClick.current = true }
    setDraft(ids); setActiveId(id)
    setAnnouncement(`${exercises.find(exercise => exercise.id === id)?.name} selezionato. Usa le frecce per spostare, Invio per confermare, Escape per annullare.`)
  }
  useLayoutEffect(() => {
    const current = gesture.current
    if (!activeId || !current) return
    // Compattare molte card non deve far sparire l'esercizio da sotto il dito.
    const rect = current.card.getBoundingClientRect()
    if (current.pointerId !== undefined) {
      window.scrollBy(0, rect.top + rect.height / 2 - current.y)
      lastFrame.current = 0
      const tick = (time: number) => {
        step(time)
        if (gesture.current?.pointerId !== undefined) frame.current = requestAnimationFrame(tick)
      }
      frame.current = requestAnimationFrame(tick)
    } else current.card.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }, [activeId])

  const movePointer = useEffectEvent((event: PointerEvent) => {
    const waiting = pending.current
    if (waiting?.pointerId === event.pointerId && Math.hypot(event.clientX - waiting.x, event.clientY - waiting.y) > 10) cancelPending()
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 3) current.moved = true
    current.x = event.clientX; current.y = event.clientY
    track()
  })
  const endPointer = useEffectEvent((event: PointerEvent) => {
    if (pending.current?.pointerId === event.pointerId) cancelPending()
    if (gesture.current?.pointerId === event.pointerId) finish(event.type === 'pointerup')
  })
  const cancel = useEffectEvent(() => finish(false))
  // touch-action viene deciso all'inizio del gesto: il touchmove nativo permette di lasciare
  // scorrere la pagina prima della pressione lunga e bloccarla soltanto durante il riordino.
  const moveTouch = useEffectEvent((event: TouchEvent) => {
    if (!gesture.current?.touch) return
    if (event.touches.length !== 1) { finish(false); return }
    if (event.cancelable) event.preventDefault()
  })
  useEffect(() => {
    const move = (event: PointerEvent) => movePointer(event)
    const end = (event: PointerEvent) => endPointer(event)
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); cancel() } }
    const hide = () => { if (document.hidden) cancel() }
    const touchMove = (event: TouchEvent) => moveTouch(event)
    const touchStart = (event: TouchEvent) => { if (event.touches.length > 1) cancel() }
    const pointerDown = () => { suppressClick.current = false }
    const click = (event: MouseEvent) => {
      if (!suppressClick.current || event.detail === 0) return
      suppressClick.current = false
      event.preventDefault(); event.stopPropagation()
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    const lost = (event: PointerEvent) => { if (gesture.current?.pointerId === event.pointerId || pending.current?.pointerId === event.pointerId) cancel() }
    window.addEventListener('lostpointercapture', lost)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', key)
    document.addEventListener('visibilitychange', hide)
    window.addEventListener('touchmove', touchMove, { passive: false, capture: true })
    window.addEventListener('touchstart', touchStart, { passive: true })
    window.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('click', click, true)
    return () => {
      cancelPending(); cancelAnimationFrame(frame.current)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('lostpointercapture', lost)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', key)
      document.removeEventListener('visibilitychange', hide)
      window.removeEventListener('touchmove', touchMove, true)
      window.removeEventListener('touchstart', touchStart)
      window.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('click', click, true)
    }
  }, [])

  const cardProps = (exercise: ExercisePrescription): ReorderCardProps => ({
    tabIndex: 0,
    'aria-label': `${exercise.name}, posizione ${items.findIndex(item => item.id === exercise.id) + 1} di ${items.length}`,
    'aria-describedby': 'session-reorder-help', 'data-reorder-active': activeId === exercise.id,
    onContextMenu: event => { if (!(event.target instanceof Element && event.target.closest(controls))) event.preventDefault() },
    onDragStart: event => event.preventDefault(),
    onPointerDown: event => {
      if (!enabled || !event.isPrimary || event.button !== 0 || gesture.current || pending.current) return
      if (event.target instanceof Element && event.target.closest(controls)) return
      const card = event.currentTarget
      const point = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, touch: event.pointerType === 'touch' }
      pending.current = { ...point, timer: window.setTimeout(() => begin(exercise.id, card, point), event.pointerType === 'mouse' ? 120 : 320) }
    },
    onClick: event => {
      // Click sintetico di tecnologie assistive, senza un pointerdown precedente.
      if (event.detail === 0 && event.target === event.currentTarget) { if (gesture.current) finish(true); else begin(exercise.id, event.currentTarget) }
    },
    onKeyDown: event => {
      if (event.target !== event.currentTarget) return
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        if (event.repeat) return
        if (gesture.current) finish(true); else begin(exercise.id, event.currentTarget)
      } else if (gesture.current && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const current = gesture.current
        const index = current.ids.indexOf(current.id)
        place(event.key === 'Home' ? 0 : event.key === 'End' ? current.ids.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1))
        requestAnimationFrame(() => current.card.scrollIntoView({ block: 'nearest', behavior: 'instant' }))
      } else if (gesture.current && event.key === 'Tab') finish(true, false)
    },
  })
  return { container, items, activeId, cardProps, announcement, minHeight }
}
