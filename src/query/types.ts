import type { ActorContext, AnalysisIR, QueryDialect, QueryExecutionSummary } from '../contracts'

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
}

export interface CompiledQueryPlan {
  ir: AnalysisIR
  dialect: QueryDialect
  ast: SqlAst
  sql: string
  parameters: Array<string | number>
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
  rows: Array<Record<string, string | number>>
}

export interface CompileQueryInput {
  ir: AnalysisIR
  actor: ActorContext
  dialect?: QueryDialect
  dataVersion?: string
  budget?: Partial<QueryBudget>
}

export interface ExecuteQueryInput {
  plan: CompiledQueryPlan
  actor: ActorContext
}

