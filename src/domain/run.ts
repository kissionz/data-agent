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

export interface RunError {
  code: PublicErrorCode
  userMessage: string
  retryable: boolean
  debugReference: string
  /** Must never contain resource names, candidate values, SQL, or policy internals. */
  safeDetails?: string
}

export type RunInternalStatus =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'awaiting_clarification'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface Run {
  id: string
  tenantId: string
  workspaceId: string
  conversationId: string
  question: string
  mode: RunMode
  semanticVersion: string
  displayStatus: RunDisplayStatus
  internalStatus: RunInternalStatus
  version: number
  result?: RunResult
  clarification?: Clarification
  error?: RunError
  terminationReason?: 'cancelled_by_user'
  createdAt: string
  updatedAt: string
}

export type RunEvent =
  | { type: 'QUESTION_SUBMITTED'; at: string }
  | { type: 'QUERY_STARTED'; at: string }
  | { type: 'CLARIFICATION_REQUIRED'; clarification: Clarification; at: string }
  | { type: 'CLARIFICATION_RESOLVED'; candidateId: string; candidateVersion: string; at: string }
  | { type: 'RESULT_READY'; result: RunResult; at: string }
  | { type: 'FAILED'; error: RunError; at: string }
  | { type: 'CANCELLED'; at: string }
  | { type: 'RETRIED'; at: string }

export class InvalidRunTransitionError extends Error {
  constructor(status: RunDisplayStatus, event: RunEvent['type']) {
    super(`Cannot apply ${event} while run is ${status}`)
    this.name = 'InvalidRunTransitionError'
  }
}

const ACTIVE_STATUSES = new Set<RunDisplayStatus>([
  'understanding',
  'querying',
  'needs_clarification',
])

export function isRunActive(run: Run): boolean {
  return ACTIVE_STATUSES.has(run.displayStatus)
}

export function createWaitingRun(
  input: Omit<Run, 'displayStatus' | 'internalStatus' | 'version' | 'updatedAt'>,
): Run {
  return {
    ...input,
    displayStatus: 'waiting_input',
    internalStatus: 'idle',
    version: 0,
    updatedAt: input.createdAt,
  }
}

function next(run: Run, patch: Partial<Run>, at: string): Run {
  const candidate: Run = {
    ...run,
    ...patch,
    version: run.version + 1,
    updatedAt: at,
  }
  assertRunInvariant(candidate)
  return candidate
}

export function transitionRun(run: Run, event: RunEvent): Run {
  switch (event.type) {
    case 'QUESTION_SUBMITTED':
      if (run.displayStatus !== 'waiting_input') throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, {
        displayStatus: 'understanding',
        internalStatus: 'planning',
        terminationReason: undefined,
        result: undefined,
        error: undefined,
        clarification: undefined,
      }, event.at)

    case 'QUERY_STARTED':
      if (run.displayStatus !== 'understanding') throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, { displayStatus: 'querying', internalStatus: 'executing' }, event.at)

    case 'CLARIFICATION_REQUIRED':
      if (run.displayStatus !== 'understanding') throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, {
        displayStatus: 'needs_clarification',
        internalStatus: 'awaiting_clarification',
        clarification: event.clarification,
      }, event.at)

    case 'CLARIFICATION_RESOLVED': {
      if (run.displayStatus !== 'needs_clarification' || !run.clarification) {
        throw new InvalidRunTransitionError(run.displayStatus, event.type)
      }
      const candidate = run.clarification.candidates.find((item) => item.id === event.candidateId)
      if (!candidate || candidate.candidateVersion !== event.candidateVersion) {
        throw new Error('Clarification candidate is missing, stale, or unauthorized')
      }
      return next(run, {
        displayStatus: 'understanding',
        internalStatus: 'planning',
        clarification: undefined,
      }, event.at)
    }

    case 'RESULT_READY':
      if (run.displayStatus !== 'querying') throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, {
        displayStatus: 'completed',
        internalStatus: 'succeeded',
        result: event.result,
        error: undefined,
      }, event.at)

    case 'FAILED':
      if (!ACTIVE_STATUSES.has(run.displayStatus)) throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, {
        displayStatus: 'failed',
        internalStatus: 'failed',
        error: sanitizeRunError(event.error),
        clarification: undefined,
        result: undefined,
      }, event.at)

    case 'CANCELLED':
      if (!ACTIVE_STATUSES.has(run.displayStatus)) throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, {
        displayStatus: 'waiting_input',
        internalStatus: 'cancelled',
        terminationReason: 'cancelled_by_user',
        clarification: undefined,
        result: undefined,
        error: undefined,
      }, event.at)

    case 'RETRIED':
      if (run.displayStatus !== 'failed') throw new InvalidRunTransitionError(run.displayStatus, event.type)
      return next(run, {
        displayStatus: 'understanding',
        internalStatus: 'planning',
        error: undefined,
      }, event.at)
  }
}

export function assertRunInvariant(run: Run): void {
  if (run.displayStatus === 'completed') {
    if (!run.result) throw new Error('A completed run requires a result')
    assertResultIntegrity(run.result)
  } else if (run.result) {
    throw new Error('Only a completed run may expose a result')
  }

  if (run.displayStatus === 'needs_clarification') {
    const count = run.clarification?.candidates.length ?? 0
    if (count < 1 || count > 3) throw new Error('Clarification requires between one and three candidates')
  } else if (run.clarification) {
    throw new Error('Clarification data is only allowed in needs_clarification')
  }

  if (run.displayStatus === 'failed' && !run.error) throw new Error('A failed run requires an error')
  if (run.displayStatus !== 'failed' && run.error) throw new Error('Only a failed run may expose an error')
  if (run.mode === 'trusted' && run.result && run.result.answer.semanticVersion !== run.semanticVersion) {
    throw new Error('Trusted results must use the run semantic version')
  }
}

export function assertResultIntegrity(result: RunResult): void {
  if (result.completeness === 'full' && result.incompleteSteps.length > 0) {
    throw new Error('A full result cannot contain incomplete steps')
  }
  if (result.completeness === 'partial' && result.incompleteSteps.length === 0) {
    throw new Error('A partial result must identify incomplete steps')
  }
  if (result.completeness === 'partial' && result.warnings.length === 0) {
    throw new Error('A partial result must explain its incomplete state')
  }
  for (const fact of result.answer.facts) {
    if (fact.references.length === 0) throw new Error(`Fact ${fact.id} has no result reference`)
    for (const reference of fact.references) {
      if (reference.resultId !== result.id) throw new Error(`Fact ${fact.id} references another result`)
      const row = result.rows.find((item) => item.key === reference.rowKey)
      if (!row || !(reference.columnId in row.values)) throw new Error(`Fact ${fact.id} has an invalid cell reference`)
    }
  }
}

const FORBIDDEN_ERROR_DETAIL = /\b(select|from|where|policy|table|column|手机号|客户|事业部)\b/i

export function sanitizeRunError(error: RunError): RunError {
  if (error.code !== 'PERMISSION_DENIED') return error
  const safeDetails = error.safeDetails && !FORBIDDEN_ERROR_DETAIL.test(error.safeDetails)
    ? error.safeDetails
    : undefined
  return {
    ...error,
    userMessage: '无权访问该内容',
    retryable: false,
    safeDetails,
  }
}
