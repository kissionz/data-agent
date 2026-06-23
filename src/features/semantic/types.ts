export type MetricStatus = 'draft' | 'review' | 'certified' | 'deprecated' | 'retired'

export type MetricValueType = 'currency' | 'number' | 'percentage' | 'duration'

export interface SemanticDimension {
  id: string
  name: string
  description?: string
  dataType: 'string' | 'number' | 'date' | 'datetime' | 'boolean'
  hierarchy?: string
}

export interface MetricDependency {
  id: string
  name: string
  type: 'metric' | 'dataset' | 'model'
  status?: MetricStatus
}

export interface MetricVersion {
  version: string
  status: MetricStatus
  changedAt: string
  changedBy: string
  summary: string
}

export interface SemanticMetric {
  id: string
  name: string
  code: string
  description: string
  status: MetricStatus
  formula: string
  valueType: MetricValueType
  unit?: string
  aggregation: 'sum' | 'count' | 'count_distinct' | 'avg' | 'min' | 'max' | 'derived'
  owner: string
  domain: string
  currentVersion: string
  updatedAt: string
  dimensions: string[]
  dependencies: MetricDependency[]
  versions: MetricVersion[]
  deprecationNote?: string
}

export interface MetricDraft {
  name: string
  description: string
  formula: string
  valueType: MetricValueType
  unit: string
  aggregation: SemanticMetric['aggregation']
  owner: string
  dimensionIds: string[]
}

export interface ApprovalRequest {
  metricId: string
  action: 'submit_review' | 'certify' | 'deprecate'
  note: string
}

export interface SemanticGovernanceProps {
  metrics: SemanticMetric[]
  dimensions: SemanticDimension[]
  selectedMetricId?: string
  canEdit?: boolean
  canApprove?: boolean
  isSaving?: boolean
  onSelectMetric?: (metricId: string) => void
  onSaveMetric?: (metricId: string, draft: MetricDraft) => void | Promise<void>
  onRequestApproval?: (request: ApprovalRequest) => void | Promise<void>
  onCreateMetric?: () => void
}
