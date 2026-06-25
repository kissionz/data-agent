export type RetentionDataClass =
  | 'question'
  | 'analysis_ir'
  | 'sql_fingerprint'
  | 'result_summary'
  | 'raw_result'
  | 'audit_event'
  | 'sensitive_sample'

export interface RetentionPolicy {
  tenantId: string
  workspaceId: string
  days: Record<RetentionDataClass, number>
  sensitiveDataShorterThanRawResult: true
  auditLongerThanQuestion: true
}

export interface RetentionPlanItem {
  dataClass: RetentionDataClass
  retentionDays: number
  deleteBefore: string
  table: 'chatbi_runs' | 'chatbi_audit_events' | 'chatbi_result_blobs' | 'chatbi_data_samples'
  predicate: string
  reason: string
}

export interface RetentionCleanupPlan {
  tenantId: string
  workspaceId: string
  generatedAt: string
  policy: RetentionPolicy
  items: RetentionPlanItem[]
  sqlStatements: {
    statement: string
    params: Record<string, string | number>
  }[]
}

export interface CreateRetentionPlanInput {
  tenantId: string
  workspaceId: string
  now: string
  overrides?: Partial<Record<RetentionDataClass, number>>
}

export const DEFAULT_RETENTION_DAYS: Record<RetentionDataClass, number> = {
  question: 180,
  analysis_ir: 180,
  sql_fingerprint: 180,
  result_summary: 30,
  raw_result: 7,
  audit_event: 365,
  sensitive_sample: 3,
}

export function createRetentionPolicy(input: Omit<CreateRetentionPlanInput, 'now'>): RetentionPolicy {
  const days = { ...DEFAULT_RETENTION_DAYS, ...input.overrides }
  validateRetentionDays(days)
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    days,
    sensitiveDataShorterThanRawResult: true,
    auditLongerThanQuestion: true,
  }
}

export function createRetentionCleanupPlan(input: CreateRetentionPlanInput): RetentionCleanupPlan {
  const policy = createRetentionPolicy(input)
  const items: RetentionPlanItem[] = [
    item(policy, input.now, 'question', 'chatbi_runs', 'question_created_at < :delete_before', '问题文本和会话输入默认保留 180 天。'),
    item(policy, input.now, 'analysis_ir', 'chatbi_runs', 'analysis_ir_created_at < :delete_before', 'Analysis IR 与规划证据默认保留 180 天。'),
    item(policy, input.now, 'sql_fingerprint', 'chatbi_runs', 'query_fingerprint_created_at < :delete_before', '只保留 SQL 指纹，不保留原始 SQL；指纹默认保留 180 天。'),
    item(policy, input.now, 'result_summary', 'chatbi_runs', 'result_ready_at < :delete_before', '答案摘要默认保留 30 天。'),
    item(policy, input.now, 'raw_result', 'chatbi_result_blobs', 'created_at < :delete_before', '原始结果 blob 默认仅保留 7 天。'),
    item(policy, input.now, 'sensitive_sample', 'chatbi_data_samples', 'created_at < :delete_before', '敏感样本必须短于原始结果保留期。'),
    item(policy, input.now, 'audit_event', 'chatbi_audit_events', 'at < :delete_before', '审计事件默认保留 365 天，用于合规追踪。'),
  ]
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    generatedAt: input.now,
    policy,
    items,
    sqlStatements: items.map((planItem) => ({
      statement: `delete from ${planItem.table} where tenant_id = :tenant_id and workspace_id = :workspace_id and ${planItem.predicate}`,
      params: {
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId,
        delete_before: planItem.deleteBefore,
        retention_days: planItem.retentionDays,
      },
    })),
  }
}

function item(
  policy: RetentionPolicy,
  now: string,
  dataClass: RetentionDataClass,
  table: RetentionPlanItem['table'],
  predicate: string,
  reason: string,
): RetentionPlanItem {
  return {
    dataClass,
    retentionDays: policy.days[dataClass],
    deleteBefore: subtractDaysIso(now, policy.days[dataClass]),
    table,
    predicate,
    reason,
  }
}

function validateRetentionDays(days: Record<RetentionDataClass, number>) {
  for (const [dataClass, value] of Object.entries(days)) {
    if (!Number.isInteger(value) || value < 1 || value > 3650) {
      throw new Error(`Invalid retention days for ${dataClass}: ${value}`)
    }
  }
  if (days.sensitive_sample >= days.raw_result) {
    throw new Error('sensitive_sample retention must be shorter than raw_result retention.')
  }
  if (days.audit_event <= days.question) {
    throw new Error('audit_event retention must be longer than question retention.')
  }
}

function subtractDaysIso(now: string, days: number) {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString()
}
