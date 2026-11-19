import { Icon } from '../components/Icon'
import { SubpageHeader } from '../components/SubpageHeader'

export function ProgramStartChoice({ previousTitle }: { previousTitle?: string }) {
  return <>
    <SubpageHeader back="#/scheda" backLabel="Torna alla scheda" title="Crea un nuovo programma" subtitle="Scegli da dove partire." />
    <div className="program-start-choices">
      <a className="panel program-start-choice" href="#/scheda/programmi/nuovo">
        <Icon name="plus" size={24} />
        <span><strong>Parti da zero</strong><small>Imposta giorni ed esercizi per il prossimo ciclo.</small></span>
        <Icon name="chevron" size={20} />
      </a>
      {previousTitle && <a className="panel program-start-choice" href="#/scheda/programmi/rinnova">
        <Icon name="copy" size={24} />
        <span><strong>Riusa il programma precedente</strong><small>Copia giorni, esercizi e serie di {previousTitle}.</small></span>
        <Icon name="chevron" size={20} />
      </a>}
    </div>
  </>
}
