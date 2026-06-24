export const RUN_DISPLAY_STATUSES = [
  'waiting_input',
  'understanding',
  'querying',
  'completed',
  'needs_clarification',
  'failed',
] as const

export type RunDisplayStatus = (typeof RUN_DISPLAY_STATUSES)[number]
export type RunMode = 'trusted' | 'exploration' | 'expert'
export type ResultCompleteness = 'full' | 'partial'

export type PublicErrorCode =
  | 'AMBIGUOUS_QUERY'
  | 'SEMANTIC_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'QUERY_TOO_EXPENSIVE'
  | 'DATA_STALE'
  | 'PARTIAL_RESULT'
  | 'MODEL_UNAVAILABLE'
  | 'RUN_ALREADY_ACTIVE'
  | 'RUN_CANCELLED'
  | 'VALIDATION_FAILED'
  | 'INTERNAL_ERROR'

export interface ResultCellReference {
  resultId: string
  rowKey: string
  columnId: string
  transformId?: string
}

export interface DeterministicFact {
  id: string
  label: string
  value: string | number
  formattedValue: string
  references: ResultCellReference[]
}

export interface DeterministicAnswer {
  headline: string
  summary: string
  facts: DeterministicFact[]
  semanticVersion: string
  generatedFrom: 'fixture_result'
}

export interface ResultColumn {
  id: string
  label: string
  type: 'string' | 'number' | 'date' | 'currency' | 'percentage'
  unit?: string
}

export interface ResultRow {
  key: string
  values: Record<string, string | number | null>
}

export interface RunResult {
  id: string
  columns: ResultColumn[]
  rows: ResultRow[]
  completeness: ResultCompleteness
  incompleteSteps: string[]
  warnings: string[]
  answer: DeterministicAnswer
  freshnessAt: string
}

export interface ClarificationCandidate {
  id: string
  label: string
  description: string
  semanticObjectId: string
  candidateVersion: string
}

export interface Clarification {
  reasonCode: 'metric_ambiguity' | 'member_ambiguity' | 'time_ambiguity'
  prompt: string
  candidates: ClarificationCandidate[]
  irRevision: number
  expiresAt: string
}
