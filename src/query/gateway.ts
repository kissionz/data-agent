import type { QueryExecutionSummary } from '../contracts'
import { stableHash } from './hash'
import { assertReadOnlySql } from './compiler'
import type { ExecuteQueryInput, QueryGatewayExecution } from './types'

const CANCELLATION_TARGETS: QueryExecutionSummary['cancellation']['propagationTargets'] = [
  'planner',
  'compiler',
  'query_adapter',
  'result_writer',
]

export function executeReadOnlyQuery(input: ExecuteQueryInput): QueryGatewayExecution {
  const { plan, actor } = input
  if (plan.ir.semanticVersion !== actor.semanticVersion) throw new Error('Query semantic version does not match actor context')
  if (plan.estimatedRows > plan.budget.maxRows) throw new Error('Query row estimate exceeds budget')
  if (plan.estimatedScanBytes > plan.budget.maxScanBytes) throw new Error('Query scan estimate exceeds budget')
  assertReadOnlySql(plan.sql)
  const cacheKey = createQueryCacheKey(plan)
  const cancellation = createQueryCancellationPlan(plan)
  const summary: QueryExecutionSummary = {
    dialect: plan.dialect,
    sqlFingerprint: plan.sqlFingerprint,
    cacheKey,
    permissionDigest: plan.permissionDigest,
    dataVersion: plan.dataVersion,
    estimatedRows: plan.estimatedRows,
    estimatedScanBytes: plan.estimatedScanBytes,
    timeoutMs: plan.budget.timeoutMs,
    maxRows: plan.budget.maxRows,
    appliedGuards: [...plan.appliedGuards, 'cancellation_token'],
    cancellation,
    status: 'executed',
  }
  return {
    summary,
    rows: [],
  }
}

export function createQueryCancellationPlan(plan: Pick<ExecuteQueryInput['plan'], 'ir' | 'sqlFingerprint' | 'permissionDigest' | 'budget'>): QueryExecutionSummary['cancellation'] {
  return {
    token: `qcancel_${stableHash([
      plan.ir.irId,
      plan.ir.revision,
      plan.sqlFingerprint,
      plan.permissionDigest,
      plan.budget.timeoutMs,
    ])}`,
    propagationTargets: CANCELLATION_TARGETS,
    deadlineMs: Math.min(3000, plan.budget.timeoutMs),
    status: 'pending',
  }
}

export function markQueryExecutionCancelled(summary: QueryExecutionSummary, propagatedAt: string): QueryExecutionSummary {
  return {
    ...summary,
    status: 'cancelled',
    cancellation: {
      ...summary.cancellation,
      status: 'propagated',
      propagatedAt,
    },
  }
}

export function createQueryCacheKey(plan: Pick<ExecuteQueryInput['plan'], 'ir' | 'sqlFingerprint' | 'permissionDigest' | 'dataVersion'>) {
  return `qcache_${stableHash([
    plan.ir.mode,
    plan.ir.semanticVersion,
    plan.sqlFingerprint,
    plan.permissionDigest,
    plan.dataVersion,
  ])}`
}
