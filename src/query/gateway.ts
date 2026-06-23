import type { QueryExecutionSummary } from '../contracts'
import { stableHash } from './hash'
import { assertReadOnlySql } from './compiler'
import type { ExecuteQueryInput, QueryGatewayExecution } from './types'

export function executeReadOnlyQuery(input: ExecuteQueryInput): QueryGatewayExecution {
  const { plan, actor } = input
  if (plan.ir.semanticVersion !== actor.semanticVersion) throw new Error('Query semantic version does not match actor context')
  if (plan.estimatedRows > plan.budget.maxRows) throw new Error('Query row estimate exceeds budget')
  if (plan.estimatedScanBytes > plan.budget.maxScanBytes) throw new Error('Query scan estimate exceeds budget')
  assertReadOnlySql(plan.sql)
  const cacheKey = createQueryCacheKey(plan)
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
    appliedGuards: plan.appliedGuards,
    status: 'executed',
  }
  return {
    summary,
    rows: [],
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

