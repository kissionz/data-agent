import type { ActorContext, AnalysisIR, QueryDialect, QueryExecutionSummary, ResultColumn } from '../contracts'
import type { SemanticCatalog } from '../semantic'

export type QueryParameter = string | number | boolean | null
export type QueryScalar = string | number | boolean | null

export interface SqlAst {
  kind: 'select'
  metricIds: string[]
  dimensionIds: string[]
  sourceTable: string
  joins: string[]
  where: string[]
  groupBy: string[]
  orderBy: string[]
  limit: number
}

export interface QueryBudget {
  timeoutMs: number
  maxRows: number
  maxScanBytes: number
  maxCostUnits?: number
}

export interface QueryOutputColumn extends ResultColumn {
  role: 'dimension' | 'metric'
}

export interface CompiledQueryPlan {
  ir: AnalysisIR
  dialect: QueryDialect
  dataSourceId: string
  outputColumns: QueryOutputColumn[]
  ast: SqlAst
  sql: string
  parameters: QueryParameter[]
  sqlFingerprint: string
  permissionDigest: string
  dataVersion: string
  estimatedRows: number
  estimatedScanBytes: number
  budget: QueryBudget
  appliedGuards: string[]
}

export interface QueryGatewayExecution {
  summary: QueryExecutionSummary
  rows: Array<Record<string, QueryScalar>>
}

export interface QueryAdapterInput {
  executionId: string
  cancellationToken: string
  dataSourceId: string
  sql: string
  parameters: readonly QueryParameter[]
  sqlFingerprint: string
  budget: QueryBudget
}

export interface QueryExplainEstimate {
  estimatedRows: number
  estimatedScanBytes: number
  costUnits: number
  checkedAt: string
}

export interface QueryAdapterField {
  name: string
  databaseType: string
}

export type QueryBudgetBlockReason = 'row_budget' | 'scan_budget' | 'cost_budget'

export interface QueryAdapterBlockedOutcome {
  status: 'blocked'
  explain: QueryExplainEstimate
  reason: QueryBudgetBlockReason
}

export interface QueryAdapterExecutedOutcome {
  status: 'executed'
  explain: QueryExplainEstimate
  fields: QueryAdapterField[]
  rows: Array<Record<string, QueryScalar>>
  rowCount: number
  truncated: boolean
}

export type QueryAdapterOutcome = QueryAdapterBlockedOutcome | QueryAdapterExecutedOutcome

/**
 * Browser-safe port for a PostgreSQL query adapter.
 *
 * Implementations must perform EXPLAIN, the budget decision and (when allowed)
 * query execution atomically in one read-only transaction. A blocked outcome
 * means that the query body was never executed. Implementations must observe
 * the supplied AbortSignal throughout connection acquisition, EXPLAIN and
 * execution, and must always release their connection.
 */
export interface QueryAdapter {
  readonly dialect: 'postgresql'
  runReadOnly(input: QueryAdapterInput, signal: AbortSignal): Promise<QueryAdapterOutcome>
}

export interface MapQueryResultInput {
  resultId: string
  plan: Pick<CompiledQueryPlan, 'ir' | 'outputColumns'>
  execution: QueryAdapterExecutedOutcome
  freshnessAt: string
}

export interface CompileQueryInput {
  ir: AnalysisIR
  actor: ActorContext
  dialect?: QueryDialect
  dataVersion?: string
  budget?: Partial<QueryBudget>
  semanticCatalog?: SemanticCatalog
}

export interface ExecuteQueryInput {
  plan: CompiledQueryPlan
  actor: ActorContext
}
