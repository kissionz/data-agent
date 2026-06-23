export const METRIC_LIFECYCLES = ['draft', 'review', 'certified', 'deprecated', 'offline'] as const
export type MetricLifecycle = (typeof METRIC_LIFECYCLES)[number]

export interface SemanticMetric {
  id: string
  tenantId: string
  workspaceId: string
  businessDomainId: string
  name: string
  description: string
  formula: string
  aggregation: 'sum' | 'count' | 'count_distinct' | 'average' | 'ratio'
  supportedGrains: Array<'day' | 'week' | 'month' | 'quarter' | 'year'>
  unit: 'CNY' | 'count' | 'percentage'
  timeDimensionId: string
  owner: string
  lifecycle: MetricLifecycle
  version: string
  immutable: true
  synonyms: string[]
  freshnessAt: string
}

export function isMetricAvailableInTrustedMode(metric: SemanticMetric): boolean {
  return metric.lifecycle === 'certified'
}

export function assertCertifiedMetric(metric: SemanticMetric): void {
  if (!metric.id || !metric.name || !metric.formula || !metric.owner || !metric.version) {
    throw new Error('Certified metric fields must be complete')
  }
  if (!isMetricAvailableInTrustedMode(metric)) throw new Error('Only certified metrics are available in trusted mode')
  if (!metric.immutable) throw new Error('Semantic metric versions must be immutable')
}
