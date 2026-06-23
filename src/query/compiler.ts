import type { ActorContext, AnalysisIR, FilterIR, QueryDialect } from '../contracts'
import { assertAnalysisIR } from '../contracts'
import type { CompileQueryInput, CompiledQueryPlan, QueryBudget, SqlAst } from './types'
import { stableHash } from './hash'

interface MetricDefinition {
  id: string
  expression: string
  sourceTable: string
}

interface DimensionDefinition {
  id: string
  expression: string
  groupExpression: string
}

const metrics: Record<string, MetricDefinition> = {
  net_revenue: {
    id: 'net_revenue',
    expression: 'SUM(f.net_revenue)',
    sourceTable: 'semantic_sales.dwd_order_settlement',
  },
  completed_order_count: {
    id: 'completed_order_count',
    expression: 'COUNT(DISTINCT f.completed_order_id)',
    sourceTable: 'semantic_sales.dwd_order_settlement',
  },
}

const dimensions: Record<string, DimensionDefinition> = {
  order_date: {
    id: 'order_date',
    expression: "DATE_TRUNC('month', f.order_date)",
    groupExpression: "DATE_TRUNC('month', f.order_date)",
  },
  region: {
    id: 'region',
    expression: 'r.region_name',
    groupExpression: 'r.region_name',
  },
}

const defaultBudget: QueryBudget = {
  timeoutMs: 15_000,
  maxRows: 1000,
  maxScanBytes: 100_000_000,
}

export function compileAnalysisQuery(input: CompileQueryInput): CompiledQueryPlan {
  const dialect = input.dialect ?? 'postgresql'
  const dataVersion = input.dataVersion ?? 'sales_warehouse_2026_06_23_0800'
  const budget = { ...defaultBudget, ...input.budget }
  const ir = input.ir
  assertAnalysisIR(ir)
  assertExecutableIr(ir, input.actor)

  const metricDefinitions = ir.metricIds.map((id) => {
    const metric = metrics[id]
    if (!metric) throw new Error(`Unsupported governed metric: ${id}`)
    return metric
  })
  const dimensionDefinitions = ir.dimensionIds.map((id) => {
    const dimension = dimensions[id]
    if (!dimension) throw new Error(`Unsupported governed dimension: ${id}`)
    return dimension
  })
  const sourceTable = metricDefinitions[0].sourceTable
  if (metricDefinitions.some((metric) => metric.sourceTable !== sourceTable)) {
    throw new Error('Cross-source metric plans are not supported in trusted mode')
  }

  const parameters: Array<string | number> = [
    input.actor.tenantId,
    input.actor.workspaceId,
    input.actor.businessDomainId,
  ]
  const where = [
    'f.tenant_id = $1',
    'f.workspace_id = $2',
    'f.business_domain_id = $3',
    compileTimeRange(ir, parameters),
    ...ir.filters.map((filter) => compileFilter(filter, parameters)),
  ]
  const joins = ir.dimensionIds.includes('region')
    ? ['LEFT JOIN semantic_sales.dim_sales_region r ON r.region_id = f.region_id AND r.tenant_id = f.tenant_id']
    : []
  const selectExpressions = [
    ...dimensionDefinitions.map((dimension) => `${dimension.expression} AS ${quoteIdentifier(dimension.id, dialect)}`),
    ...metricDefinitions.map((metric) => `${metric.expression} AS ${quoteIdentifier(metric.id, dialect)}`),
  ]
  const groupBy = dimensionDefinitions.map((dimension) => dimension.groupExpression)
  const orderBy = groupBy.length > 0 ? [`${groupBy[0]} ASC`] : [`${quoteIdentifier(metricDefinitions[0].id, dialect)} DESC`]
  const limit = Math.min(ir.limit, budget.maxRows)
  const ast: SqlAst = {
    kind: 'select',
    metricIds: ir.metricIds,
    dimensionIds: ir.dimensionIds,
    sourceTable,
    joins,
    where,
    groupBy,
    orderBy,
    limit,
  }
  const sql = [
    `SELECT ${selectExpressions.join(', ')}`,
    `FROM ${sourceTable} f`,
    ...joins,
    `WHERE ${where.join(' AND ')}`,
    groupBy.length ? `GROUP BY ${groupBy.join(', ')}` : '',
    `ORDER BY ${orderBy.join(', ')}`,
    `LIMIT ${limit}`,
  ].filter(Boolean).join('\n')
  assertReadOnlySql(sql)
  const sqlFingerprint = stableHash([dialect, sql, parameters, ir.semanticVersion])
  const permissionDigest = stableHash([input.actor.tenantId, input.actor.workspaceId, input.actor.businessDomainId, [...input.actor.roles].sort()])
  return {
    ir,
    dialect,
    ast,
    sql,
    parameters,
    sqlFingerprint,
    permissionDigest,
    dataVersion,
    estimatedRows: limit,
    estimatedScanBytes: estimateScanBytes(ir),
    budget,
    appliedGuards: [
      'tenant_scope',
      'workspace_scope',
      'business_domain_scope',
      'read_only_ast',
      'budget_limit',
    ],
  }
}

function assertExecutableIr(ir: AnalysisIR, actor: ActorContext) {
  if (ir.safety.requiresClarification) throw new Error('Cannot compile a query while clarification is required')
  if (!ir.safety.permissionChecked || !ir.safety.budgetChecked) throw new Error('Analysis IR must pass permission and budget checks before compilation')
  if (ir.semanticVersion !== actor.semanticVersion) throw new Error('Actor semantic version does not match Analysis IR')
  if (ir.mode !== 'trusted') throw new Error('Only trusted mode compilation is available in the local gateway')
  if (ir.intent === 'clarification') throw new Error('Clarification IR is not executable')
}

function compileTimeRange(ir: AnalysisIR, parameters: Array<string | number>) {
  if (ir.timeRange.kind !== 'relative') throw new Error('Only relative time ranges are available in the local compiler')
  const days = ir.timeRange.expression === 'last_30_complete_days' ? 30 : 365
  parameters.push(days)
  return `f.order_date >= CURRENT_DATE - ($${parameters.length}::int * INTERVAL '1 day')`
}

function compileFilter(filter: FilterIR, parameters: Array<string | number>) {
  if (!dimensions[filter.dimensionId] && filter.dimensionId !== 'clarified_metric') {
    throw new Error(`Unsupported governed filter: ${filter.dimensionId}`)
  }
  if (filter.values.some((value) => /;|--|\/\*|\*\/|\b(drop|delete|insert|update|alter|grant|copy)\b/i.test(value))) {
    throw new Error('Filter value contains unsafe SQL control tokens')
  }
  if (filter.operator === 'eq') {
    parameters.push(filter.values[0] ?? '')
    return `${filterColumn(filter.dimensionId)} = $${parameters.length}`
  }
  if (filter.operator === 'in') {
    const placeholders = filter.values.map((value) => {
      parameters.push(value)
      return `$${parameters.length}`
    })
    return `${filterColumn(filter.dimensionId)} IN (${placeholders.join(', ')})`
  }
  throw new Error(`Unsupported filter operator: ${filter.operator}`)
}

function filterColumn(dimensionId: string) {
  if (dimensionId === 'region') return 'r.region_name'
  if (dimensionId === 'order_date') return 'f.order_date'
  if (dimensionId === 'clarified_metric') return 'f.certified_metric_id'
  return `f.${dimensionId}`
}

function quoteIdentifier(identifier: string, dialect: QueryDialect) {
  const quote = dialect === 'snowflake' ? '"' : '"'
  return `${quote}${identifier.replaceAll('"', '')}${quote}`
}

export function assertReadOnlySql(sql: string) {
  const normalized = sql.trim().replace(/;+\s*$/, '')
  if (!/^select\b/i.test(normalized)) throw new Error('Query Gateway only accepts SELECT statements')
  if (/;/.test(normalized)) throw new Error('Query Gateway rejects multiple SQL statements')
  if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke|copy|merge|call|create)\b/i.test(normalized)) {
    throw new Error('Query Gateway rejects non-read-only SQL')
  }
}

function estimateScanBytes(ir: AnalysisIR) {
  const timeFactor = ir.timeRange.expression === 'last_30_complete_days' ? 8_000_000 : 42_000_000
  const dimensionFactor = Math.max(1, ir.dimensionIds.length)
  const filterReduction = Math.max(1, 4 - ir.filters.length)
  return Math.round((timeFactor * dimensionFactor) / filterReduction)
}
