import {
  FACT_TRANSFORM_REGISTRY_VERSION,
  evaluateDeterministicFactTransform,
  type DeterministicFactTransform,
  type ResultCellReference as FactResultCellReference,
} from './factTransform'

export type ResultCellReference = FactResultCellReference

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

export interface DeterministicFact {
  id: string
  label: string
  value: string | number | boolean
  formattedValue: string
  references: ResultCellReference[]
  transform?: DeterministicFactTransform
}

export interface DeterministicAnswer {
  headline: string
  summary: string
  facts: DeterministicFact[]
  semanticVersion: string
  generatedFrom: 'fixture_result' | 'query_result'
}

export interface ResultColumn {
  id: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'date' | 'currency' | 'percentage'
  unit?: string
}

export interface ResultRow {
  key: string
  values: Record<string, string | number | boolean | null>
}

export type ResultChartType = 'line' | 'bar' | 'table'

export const CHART_VALIDATION_REPORT_VERSION = 'chatbi_chart_validation.v1' as const

export type ResultChartValidationDecision = 'allow' | 'fallback_table' | 'reject'

export const CHART_VALIDATION_RULE_CODES = [
  'CHART_TYPE_ALLOWED',
  'COLUMN_IDS_UNIQUE',
  'AXIS_FIELDS_EXIST',
  'AXIS_FIELDS_UNIQUE',
  'ROW_COUNT_WITHIN_HARD_LIMIT',
  'RESULT_NON_EMPTY',
  'AXIS_TYPES_COMPATIBLE',
  'TIME_AXIS_STRICTLY_ASCENDING',
  'NUMERIC_VALUES_FINITE',
  'PERCENTAGE_VALUES_REASONABLE',
  'Y_AXIS_UNITS_COMPATIBLE',
] as const

export type ResultChartValidationRuleCode = (typeof CHART_VALIDATION_RULE_CODES)[number]

export interface ResultChartValidationCheck {
  code: ResultChartValidationRuleCode
  status: 'pass' | 'fail' | 'not_applicable'
}

export interface ResultChartValidationReport {
  schemaVersion: typeof CHART_VALIDATION_REPORT_VERSION
  decision: ResultChartValidationDecision
  requestedChartType: ResultChartType | 'unsupported'
  publishedChartType?: ResultChartType
  evaluatedRowCount: number
  rowHardLimit: number
  checks: ResultChartValidationCheck[]
}

export interface ResultChartSpec {
  id: string
  title: string
  description: string
  type: ResultChartType
  xAxisColumnId?: string
  yAxisColumnIds: string[]
  source: 'validated_result_spec'
  safety: {
    grounded: boolean
    warnings: string[]
    validationReport?: ResultChartValidationReport
  }
}

export interface RunResult {
  id: string
  columns: ResultColumn[]
  rows: ResultRow[]
  chartSpec: ResultChartSpec
  completeness: ResultCompleteness
  incompleteSteps: string[]
  warnings: string[]
  answer: DeterministicAnswer
  freshnessAt: string
}

export type RecommendedVisualization = 'line' | 'bar' | 'table'

export interface ResultGroundingReport {
  grounded: boolean
  checkedFacts: number
  checkedReferences: number
  checkedTransforms: number
  transformRegistryVersion: typeof FACT_TRANSFORM_REGISTRY_VERSION
  mismatches: string[]
  chartSafety: {
    safe: boolean
    recommendedVisualization: RecommendedVisualization
    warnings: string[]
  }
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
  assertChartSpecIntegrity(result)
  const grounding = validateResultGrounding(result)
  if (!grounding.grounded) {
    throw new Error(grounding.mismatches[0] ?? 'Result answer is not grounded in the result set')
  }
}

export function assertChartSpecIntegrity(result: RunResult): void {
  const columnsById = new Map(result.columns.map((column) => [column.id, column]))
  const spec = result.chartSpec

  if (spec.source !== 'validated_result_spec') throw new Error('Chart spec must be produced by the validator')
  if (!spec.safety.grounded) throw new Error('Published chart spec must be grounded')

  const report = spec.safety.validationReport
  if (report) {
    if (report.schemaVersion !== CHART_VALIDATION_REPORT_VERSION) {
      throw new Error('Chart validation report uses an unsupported schema version')
    }
    if (
      report.decision !== 'allow'
      && report.decision !== 'fallback_table'
      && report.decision !== 'reject'
    ) {
      throw new Error('Chart validation report uses an unsupported decision')
    }
    if (
      report.requestedChartType !== 'line'
      && report.requestedChartType !== 'bar'
      && report.requestedChartType !== 'table'
      && report.requestedChartType !== 'unsupported'
    ) {
      throw new Error('Chart validation report uses an unsupported requested chart type')
    }
    if (report.decision === 'reject') throw new Error('A rejected chart decision cannot be published')
    if (report.requestedChartType === 'unsupported') {
      throw new Error('An unsupported chart type cannot be published')
    }
    if (report.publishedChartType !== spec.type) {
      throw new Error('Chart validation report does not match the published chart type')
    }
    if (report.evaluatedRowCount !== result.rows.length) {
      throw new Error('Chart validation report row count does not match the result')
    }
    if (!Number.isSafeInteger(report.rowHardLimit) || report.rowHardLimit <= 0) {
      throw new Error('Chart validation report has an invalid row hard limit')
    }
    if (
      report.checks.length !== CHART_VALIDATION_RULE_CODES.length
      || report.checks.some((check, index) => (
        check.code !== CHART_VALIDATION_RULE_CODES[index]
        || (check.status !== 'pass' && check.status !== 'fail' && check.status !== 'not_applicable')
      ))
    ) {
      throw new Error('Chart validation report checks are incomplete or out of order')
    }
    if (report.decision === 'fallback_table' && spec.type !== 'table') {
      throw new Error('A chart safety fallback must publish a table')
    }
    if (report.decision === 'allow' && report.checks.some((check) => check.status === 'fail')) {
      throw new Error('An allowed chart decision cannot contain failed checks')
    }
    if (report.decision === 'fallback_table' && !report.checks.some((check) => check.status === 'fail')) {
      throw new Error('A chart safety fallback must identify a failed check')
    }
  }

  if (spec.type === 'table') {
    if (spec.xAxisColumnId) throw new Error('Table chart spec cannot define an x-axis column')
    if (spec.yAxisColumnIds.length > 0) throw new Error('Table chart spec cannot define y-axis columns')
    return
  }

  if (!spec.xAxisColumnId || !columnsById.has(spec.xAxisColumnId)) {
    throw new Error('Chart spec references a missing x-axis column')
  }

  if (spec.yAxisColumnIds.length === 0) throw new Error('Chart spec requires at least one y-axis column')

  for (const columnId of spec.yAxisColumnIds) {
    const column = columnsById.get(columnId)
    if (!column) throw new Error('Chart spec references a missing y-axis column')
    if (column.type !== 'number' && column.type !== 'currency' && column.type !== 'percentage') {
      throw new Error('Chart spec y-axis column must be numeric')
    }
  }

  if (spec.type === 'line') {
    const xAxisColumn = columnsById.get(spec.xAxisColumnId)
    if (xAxisColumn?.type !== 'date') throw new Error('Line chart spec requires a date x-axis')
  }
}

export function validateResultGrounding(result: RunResult): ResultGroundingReport {
  const mismatches: string[] = []
  let checkedReferences = 0
  let checkedTransforms = 0

  const rowsByKey = new Map(result.rows.map((row) => [row.key, row]))

  for (const fact of result.answer.facts) {
    const rawFact = fact as unknown as Record<string, unknown>
    if (Object.keys(rawFact).some((key) => /sql|query|statement/i.test(key))) {
      mismatches.push(`Fact ${fact.id} contains a forbidden public field`)
      continue
    }
    if (!Array.isArray(rawFact.references) || !rawFact.references.every(isResultCellReference)) {
      mismatches.push(`Fact ${fact.id} has an invalid result reference`)
      continue
    }
    if (
      'transform' in rawFact
      && rawFact.transform !== undefined
      && (!rawFact.transform || typeof rawFact.transform !== 'object' || Array.isArray(rawFact.transform))
    ) {
      mismatches.push(`Fact ${fact.id} has an invalid transform`)
      continue
    }
    if (fact.transform) {
      checkedTransforms += 1
      const transform = fact.transform as DeterministicFactTransform
      const rawInputs = (transform as unknown as { inputs?: unknown }).inputs
      if (!Array.isArray(rawInputs) || rawInputs.length === 0) {
        mismatches.push(`Fact ${fact.id} transform has no inputs`)
        continue
      }
      if (!rawInputs.every(isResultCellReference)) {
        mismatches.push(`Fact ${fact.id} transform has an invalid input reference`)
        continue
      }
      const inputs = rawInputs as ResultCellReference[]
      if (!referenceListsMatch(fact.references, inputs)) {
        mismatches.push(`Fact ${fact.id} transform inputs do not match its result references`)
        continue
      }

      const inputValues: Array<string | number | boolean | null> = []
      let inputsValid = true
      for (const reference of inputs) {
        checkedReferences += 1
        if (reference.transformId !== undefined) {
          mismatches.push(`Fact ${fact.id} uses an unsupported legacy transform marker`)
          inputsValid = false
          continue
        }
        if (reference.resultId !== result.id) {
          mismatches.push(`Fact ${fact.id} transform references another result`)
          inputsValid = false
          continue
        }
        const row = rowsByKey.get(reference.rowKey)
        if (!row || !(reference.columnId in row.values)) {
          mismatches.push(`Fact ${fact.id} transform has an invalid input cell reference`)
          inputsValid = false
          continue
        }
        inputValues.push(row.values[reference.columnId])
      }
      if (!inputsValid) continue

      const evaluation = evaluateDeterministicFactTransform(transform, inputValues)
      if (!evaluation.ok) {
        mismatches.push(`Fact ${fact.id} transform rejected: ${evaluation.code}`)
        continue
      }
      if (
        typeof fact.value !== 'number'
        || !Number.isFinite(fact.value)
        || !Object.is(Object.is(fact.value, -0) ? 0 : fact.value, evaluation.value)
      ) {
        mismatches.push(`Fact ${fact.id} value does not match its recomputed transform result`)
      }
      continue
    }

    if (fact.references.length === 0) {
      mismatches.push(`Fact ${fact.id} has no result reference`)
      continue
    }

    const directlyReferencedValues: Array<string | number | boolean | null> = []
    for (const reference of fact.references) {
      checkedReferences += 1
      if (reference.resultId !== result.id) {
        mismatches.push(`Fact ${fact.id} references another result`)
        continue
      }

      const row = rowsByKey.get(reference.rowKey)
      if (!row || !(reference.columnId in row.values)) {
        mismatches.push(`Fact ${fact.id} has an invalid cell reference`)
        continue
      }

      if (reference.transformId !== undefined) {
        mismatches.push(`Fact ${fact.id} uses an unsupported legacy transform marker`)
        continue
      }
      directlyReferencedValues.push(row.values[reference.columnId])
    }

    if (directlyReferencedValues.length > 0) {
      const matchesFactValue = directlyReferencedValues.some((value) => cellValueMatchesFactValue(value, fact.value))
      if (!matchesFactValue) {
        mismatches.push(`Fact ${fact.id} value does not match any referenced cell`)
      }
    }
  }

  const chartSafety = evaluateChartSafety(result)

  return {
    grounded: mismatches.length === 0,
    checkedFacts: result.answer.facts.length,
    checkedReferences,
    checkedTransforms,
    transformRegistryVersion: FACT_TRANSFORM_REGISTRY_VERSION,
    mismatches,
    chartSafety,
  }
}

const RESULT_CELL_REFERENCE_FIELDS = new Set(['resultId', 'rowKey', 'columnId', 'transformId'])

function isResultCellReference(value: unknown): value is ResultCellReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Record<string, unknown>
  return Object.keys(reference).every((key) => RESULT_CELL_REFERENCE_FIELDS.has(key))
    && typeof reference.resultId === 'string'
    && reference.resultId.length > 0
    && typeof reference.rowKey === 'string'
    && reference.rowKey.length > 0
    && typeof reference.columnId === 'string'
    && reference.columnId.length > 0
    && (reference.transformId === undefined || typeof reference.transformId === 'string')
}

function referenceListsMatch(references: ResultCellReference[], inputs: ResultCellReference[]) {
  return references.length === inputs.length && references.every((reference, index) => {
    const input = inputs[index]
    return reference.resultId === input.resultId
      && reference.rowKey === input.rowKey
      && reference.columnId === input.columnId
      && reference.transformId === input.transformId
  })
}

function cellValueMatchesFactValue(
  cellValue: string | number | boolean | null,
  factValue: string | number | boolean,
): boolean {
  if (cellValue === null) return false
  if (typeof cellValue === 'number' && typeof factValue === 'number') return Object.is(cellValue, factValue)
  return String(cellValue).trim() === String(factValue).trim()
}

function evaluateChartSafety(result: RunResult): ResultGroundingReport['chartSafety'] {
  const validationReport = result.chartSpec.safety.validationReport
  if (validationReport) {
    return {
      safe: validationReport.decision !== 'reject',
      recommendedVisualization: result.chartSpec.type,
      warnings: [...result.chartSpec.safety.warnings],
    }
  }

  const warnings: string[] = []
  const dateColumn = result.columns.find((column) => column.type === 'date')
  const numericColumns = result.columns.filter((column) => (
    column.type === 'number' || column.type === 'currency' || column.type === 'percentage'
  ))

  if (result.rows.length === 0 || numericColumns.length === 0) {
    return {
      safe: true,
      recommendedVisualization: 'table',
      warnings: result.rows.length === 0 ? ['Empty result should be presented as a table or empty state, not a chart.'] : [],
    }
  }

  if (dateColumn) {
    const values = result.rows
      .map((row) => row.values[dateColumn.id])
      .filter((value): value is string | number | boolean => value !== null)
    const sorted = values.every((value, index) => index === 0 || String(values[index - 1]) <= String(value))
    if (!sorted) warnings.push(`Date axis ${dateColumn.id} is not sorted ascending before charting.`)
    return {
      safe: warnings.length === 0,
      recommendedVisualization: 'line',
      warnings,
    }
  }

  return {
    safe: true,
    recommendedVisualization: 'bar',
    warnings,
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
