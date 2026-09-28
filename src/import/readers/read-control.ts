/**
 * Controllo condiviso di una lettura: annullamento, tempo massimo e pause cooperative.
 * Le pause lasciano girare il ciclo di eventi del worker, così un messaggio `cancel`
 * viene ricevuto anche durante decompressione e parsing.
 */
import { DocumentReaderError, throwIfCancelled } from '../contracts/reader.ts'

export interface ReadControlOptions {
  /** Tempo massimo complessivo della lettura, pause comprese. */
  maxMilliseconds: number
  /** Ogni quanto lavoro ininterrotto cedere il controllo al ciclo di eventi. */
  yieldEveryMilliseconds?: number
  /** Orologio iniettabile nei test; di norma `performance.now`. */
  now?: () => number
}

const macrotask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

export class ReadControl {
  readonly signal: AbortSignal
  readonly maxMilliseconds: number
  private readonly now: () => number
  private readonly started: number
  private readonly yieldEvery: number
  private lastYield: number

  constructor(signal: AbortSignal, options: ReadControlOptions) {
    this.signal = signal
    this.maxMilliseconds = options.maxMilliseconds
    this.now = options.now ?? (() => performance.now())
    this.yieldEvery = options.yieldEveryMilliseconds ?? 25
    this.started = this.now()
    this.lastYield = this.started
  }

  /** Annullamento prima del tempo: una lettura annullata non diventa mai un errore di limite. */
  check(): void {
    throwIfCancelled(this.signal)
    const elapsed = this.now() - this.started
    if (elapsed > this.maxMilliseconds) {
      throw new DocumentReaderError('limit_exceeded', 'Lettura interrotta: tempo massimo superato.', { limit: 'readMilliseconds', max: this.maxMilliseconds, actual: Math.round(elapsed) })
    }
  }

  /** Punto di controllo nei cicli lunghi: cede il controllo solo se è passato abbastanza tempo. */
  async pause(): Promise<void> {
    this.check()
    if (this.now() - this.lastYield < this.yieldEvery) return
    await macrotask()
    this.lastYield = this.now()
    this.check()
  }
}
