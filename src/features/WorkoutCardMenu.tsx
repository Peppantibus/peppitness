import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'

/** Le alternative all'avvio restano distinte e raccolte in un solo punto. */
export function WorkoutCardMenu({ onMove, onChoose }: { onMove?: () => void; onChoose?: () => void }) {
  const [open, setOpen] = useState(false)
  if (!onMove && !onChoose) return null
  return <>
    <button type="button" className="icon-button workout-card-menu-button" aria-label="Opzioni dell’allenamento" aria-haspopup="dialog" onClick={() => setOpen(true)}><Icon name="more" size={24} /></button>
    {open && <Modal label="Opzioni dell’allenamento" variant="sheet" onClose={() => setOpen(false)}>
      <div className="workout-card-menu"><h2>Opzioni dell’allenamento</h2>
        {onMove && <button type="button" aria-label="Sposta allenamento" onClick={() => { setOpen(false); onMove() }}><Icon name="calendar" size={20} /><span><strong>Sposta allenamento</strong><small>Scambia due giornate solo per questa settimana.</small></span><Icon name="chevron" size={20} /></button>}
        {onChoose && <button type="button" aria-label="Scegli un’altra seduta" onClick={() => { setOpen(false); onChoose() }}><Icon name="swap" size={20} /><span><strong>Scegli un’altra seduta</strong><small>Vale per questa data. La programmazione non cambia.</small></span><Icon name="chevron" size={20} /></button>}
      </div>
    </Modal>}
  </>
}
