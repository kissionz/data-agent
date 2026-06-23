import type { ActorContext, AnalysisIR, FilterIR } from '../contracts'

export type SemanticObjectLifecycle = 'draft' | 'review' | 'certified' | 'deprecated' | 'offline'
export type JoinRisk = 'low' | 'medium' | 'high'

export interface CatalogMetric {
  id: string
  name: string
  tenantId: string
  workspaceId: string
  businessDomainId: string
  semanticVersion: string
  lifecycle: SemanticObjectLifecycle
  expression: string
  sourceTable: string
  supportedGrains: AnalysisIR['timeRange']['grain'][]
  compatibleDimensions: string[]
}

export interface CatalogDimension {
  id: string
  name: string
  tenantId: string
  workspaceId: string
  businessDomainId: string
  semanticVersion: string
  lifecycle: SemanticObjectLifecycle
  expression: string
  groupExpression: string
  filterExpression: string
  requiresJoin?: string
}

export interface JoinEdge {
  id: string
  leftTable: string
  rightTable: string
  sql: string
  cardinality: 'one_to_one' | 'many_to_one' | 'one_to_many' | 'many_to_many'
  direction: 'left' | 'right' | 'bidirectional'
  risk: JoinRisk
  approved: boolean
}

export interface ResolvedSemanticMetric {
  id: string
  expression: string
  sourceTable: string
}

export interface ResolvedSemanticDimension {
  id: string
  expression: string
  groupExpression: string
  filterExpression: string
}

export interface ResolvedSemanticPlan {
  semanticVersion: string
  metrics: ResolvedSemanticMetric[]
  dimensions: ResolvedSemanticDimension[]
  filterDimensions: ResolvedSemanticDimension[]
  joins: string[]
}

export interface SemanticCatalog {
  version: string
  resolvePlan(ir: AnalysisIR, actor: ActorContext): ResolvedSemanticPlan
  getMetric(metricId: string, actor: ActorContext, semanticVersion: string): CatalogMetric | undefined
  getDimension(dimensionId: string, actor: ActorContext, semanticVersion: string): CatalogDimension | undefined
}

export function createLocalSemanticCatalog(): SemanticCatalog {
  return new LocalSemanticCatalog()
}

class LocalSemanticCatalog implements SemanticCatalog {
  readonly version = 'local-semantic-catalog.v0.1'

  getMetric(metricId: string, actor: ActorContext, semanticVersion: string) {
    return catalogMetrics.find((metric) => matchesBoundary(metric, actor, semanticVersion) && metric.id === metricId)
  }

  getDimension(dimensionId: string, actor: ActorContext, semanticVersion: string) {
    return catalogDimensions.find((dimension) => matchesBoundary(dimension, actor, semanticVersion) && dimension.id === dimensionId)
  }

  resolvePlan(ir: AnalysisIR, actor: ActorContext): ResolvedSemanticPlan {
    if (ir.semanticVersion !== actor.semanticVersion) throw new Error('Semantic catalog version does not match actor context')
    const metrics = ir.metricIds.map((metricId) => {
      const metric = this.getMetric(metricId, actor, ir.semanticVersion)
      if (!metric) throw new Error(`Semantic metric is not visible or does not exist: ${metricId}`)
      if (ir.mode === 'trusted' && metric.lifecycle !== 'certified') throw new Error(`Metric is not certified for trusted mode: ${metricId}`)
      if (!metric.supportedGrains.includes(ir.timeRange.grain)) throw new Error(`Metric grain is not supported: ${metricId}/${ir.timeRange.grain}`)
      return metric
    })
    const dimensions = ir.dimensionIds.map((dimensionId) => {
      const dimension = this.getDimension(dimensionId, actor, ir.semanticVersion)
      if (!dimension) throw new Error(`Semantic dimension is not visible or does not exist: ${dimensionId}`)
      if (dimension.lifecycle === 'offline') throw new Error(`Semantic dimension is offline: ${dimensionId}`)
      for (const metric of metrics) {
        if (!metric.compatibleDimensions.includes(dimensionId)) {
          throw new Error(`Metric and dimension are not compatible: ${metric.id}/${dimensionId}`)
        }
      }
      return dimension
    })
    const filterDimensions = ir.filters.flatMap((filter) => resolveFilterDimension(filter, dimensions, actor, ir.semanticVersion, this))
    const sourceTable = metrics[0]?.sourceTable
    if (!sourceTable) throw new Error('At least one governed metric is required')
    if (metrics.some((metric) => metric.sourceTable !== sourceTable)) throw new Error('Cross-source metric plans are not supported in trusted mode')
    const joins = dimensions
      .filter((dimension) => dimension.requiresJoin)
      .map((dimension) => resolveJoin(sourceTable, dimension.requiresJoin!))
    return {
      semanticVersion: ir.semanticVersion,
      metrics: metrics.map((metric) => ({
        id: metric.id,
        expression: metric.expression,
        sourceTable: metric.sourceTable,
      })),
      dimensions: dimensions.map((dimension) => ({
        id: dimension.id,
        expression: dimension.expression,
        groupExpression: dimension.groupExpression,
        filterExpression: dimension.filterExpression,
      })),
      filterDimensions: uniqueById(filterDimensions).map((dimension) => ({
        id: dimension.id,
        expression: dimension.expression,
        groupExpression: dimension.groupExpression,
        filterExpression: dimension.filterExpression,
      })),
      joins: unique(joins.map((join) => join.sql)),
    }
  }
}

function resolveFilterDimension(
  filter: FilterIR,
  resolvedDimensions: CatalogDimension[],
  actor: ActorContext,
  semanticVersion: string,
  catalog: SemanticCatalog,
) {
  if (filter.dimensionId === 'clarified_metric') return []
  const resolved = resolvedDimensions.find((dimension) => dimension.id === filter.dimensionId)
  if (resolved) return [resolved]
  const filterDimension = catalog.getDimension(filter.dimensionId, actor, semanticVersion)
  if (!filterDimension) throw new Error(`Semantic filter is not governed: ${filter.dimensionId}`)
  return [filterDimension]
}

function resolveJoin(sourceTable: string, joinId: string) {
  const candidates = joinEdges.filter((edge) => edge.id === joinId && edge.leftTable === sourceTable)
  if (candidates.length === 0) throw new Error(`Join Graph path is missing: ${joinId}`)
  if (candidates.length > 1) throw new Error(`Join Graph path is ambiguous: ${joinId}`)
  const join = candidates[0]
  if (!join.approved || join.risk === 'high' || join.cardinality === 'many_to_many') {
    throw new Error(`Join Graph path is high risk or not approved: ${joinId}`)
  }
  return join
}

function matchesBoundary(
  object: Pick<CatalogMetric | CatalogDimension, 'tenantId' | 'workspaceId' | 'businessDomainId' | 'semanticVersion'>,
  actor: ActorContext,
  semanticVersion: string,
) {
  return object.tenantId === actor.tenantId
    && object.workspaceId === actor.workspaceId
    && object.businessDomainId === actor.businessDomainId
    && object.semanticVersion === semanticVersion
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

function uniqueById<T extends { id: string }>(values: T[]) {
  const seen = new Set<string>()
  return values.filter((value) => {
    if (seen.has(value.id)) return false
    seen.add(value.id)
    return true
  })
}

export const catalogMetrics: CatalogMetric[] = [
  {
    id: 'net_revenue',
    name: '净收入',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    businessDomainId: 'sales',
    semanticVersion: 'sales-semantic-2026.06.1',
    lifecycle: 'certified',
    expression: 'SUM(f.net_revenue)',
    sourceTable: 'semantic_sales.dwd_order_settlement',
    supportedGrains: ['day', 'month', 'quarter', 'year'],
    compatibleDimensions: ['order_date', 'region', 'product_line'],
  },
  {
    id: 'completed_order_count',
    name: '已完成订单数',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    businessDomainId: 'sales',
    semanticVersion: 'sales-semantic-2026.06.1',
    lifecycle: 'certified',
    expression: 'COUNT(DISTINCT f.completed_order_id)',
    sourceTable: 'semantic_sales.dwd_order_settlement',
    supportedGrains: ['day', 'week', 'month', 'quarter', 'year'],
    compatibleDimensions: ['order_date', 'region', 'product_line'],
  },
  {
    id: 'refund_rate',
    name: '退款率',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    businessDomainId: 'sales',
    semanticVersion: 'sales-semantic-2026.06.1',
    lifecycle: 'draft',
    expression: 'SUM(f.refund_order_count)::decimal / NULLIF(SUM(f.paid_order_count), 0)',
    sourceTable: 'semantic_sales.dwd_order_settlement',
    supportedGrains: ['day', 'month'],
    compatibleDimensions: ['order_date', 'region'],
  },
]

export const catalogDimensions: CatalogDimension[] = [
  {
    id: 'order_date',
    name: '订单日期',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    businessDomainId: 'sales',
    semanticVersion: 'sales-semantic-2026.06.1',
    lifecycle: 'certified',
    expression: "DATE_TRUNC('month', f.order_date)",
    groupExpression: "DATE_TRUNC('month', f.order_date)",
    filterExpression: 'f.order_date',
  },
  {
    id: 'region',
    name: '区域',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    businessDomainId: 'sales',
    semanticVersion: 'sales-semantic-2026.06.1',
    lifecycle: 'certified',
    expression: 'r.region_name',
    groupExpression: 'r.region_name',
    filterExpression: 'r.region_name',
    requiresJoin: 'orders_region',
  },
  {
    id: 'product_line',
    name: '产品线',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    businessDomainId: 'sales',
    semanticVersion: 'sales-semantic-2026.06.1',
    lifecycle: 'review',
    expression: 'p.product_line_name',
    groupExpression: 'p.product_line_name',
    filterExpression: 'p.product_line_name',
    requiresJoin: 'orders_product_line',
  },
]

export const joinEdges: JoinEdge[] = [
  {
    id: 'orders_region',
    leftTable: 'semantic_sales.dwd_order_settlement',
    rightTable: 'semantic_sales.dim_sales_region',
    sql: 'LEFT JOIN semantic_sales.dim_sales_region r ON r.region_id = f.region_id AND r.tenant_id = f.tenant_id',
    cardinality: 'many_to_one',
    direction: 'left',
    risk: 'low',
    approved: true,
  },
  {
    id: 'orders_product_line',
    leftTable: 'semantic_sales.dwd_order_settlement',
    rightTable: 'semantic_sales.dim_product_line_bridge',
    sql: 'LEFT JOIN semantic_sales.dim_product_line_bridge p ON p.sku_id = f.sku_id AND p.tenant_id = f.tenant_id',
    cardinality: 'many_to_many',
    direction: 'left',
    risk: 'high',
    approved: false,
  },
]
