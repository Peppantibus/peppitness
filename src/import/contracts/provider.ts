/**
 * Interfaccia del provider di estrazione (specifica §14). Solo server: nessun componente
 * React la importa e nessuna chiave o nome di API proprietaria compare qui. Implementazione
 * nel task 16; errori HTTP/rete tipizzati fuori da questa risposta.
 */
import type { ExtractionKind, extractionSchemaIds } from './extraction.ts'
import type { NormalizedDocument } from './normalized-document.ts'

export interface ExtractionProviderCapabilities {
  structuredOutput: boolean
  images: boolean
  directPdf: boolean
}
export type ExtractionProfile = 'standard' | 'retry'

/** Una radice per richiesta: `schemaId` è vincolato al `kind`, mai una union scheda/dieta. */
export type ExtractionRequest = {
  [K in ExtractionKind]: {
    kind: K
    document: NormalizedDocument
    schemaId: typeof extractionSchemaIds[K]
    promptVersion: string
    profile: ExtractionProfile
    signal: AbortSignal
  }
}[ExtractionKind]

export type ExtractionProviderStatus = 'completed' | 'incomplete' | 'refused'
export interface ExtractionProviderResponse {
  /** Sconosciuto finché validateExtraction e le verifiche successive non lo accettano. */
  data: unknown
  providerRequestId: string | null
  model: string
  status: ExtractionProviderStatus
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
}

export interface ExtractionProvider {
  readonly capabilities: ExtractionProviderCapabilities
  extract(request: ExtractionRequest): Promise<ExtractionProviderResponse>
}
