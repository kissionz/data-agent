import type { QueryDialect, QueryDialectCapability, QueryExecutionSummary } from '../contracts'
import { stableHash } from './hash'
import { assertReadOnlySql } from './compiler'
import type { ExecuteQueryInput, QueryAdapterOutcome, QueryGatewayExecution } from './types'

const CANCELLATION_TARGETS: QueryExecutionSummary['cancellation']['propagationTargets'] = [
  'planner',
  'compiler',
  'query_adapter',
  'result_writer',
]

export function executeReadOnlyQuery(input: ExecuteQueryInput): QueryGatewayExecution {
  return createQueryExecution(input, 'executed')
}

export function createQueuedQueryExecution(input: ExecuteQueryInput): QueryGatewayExecution {
  return createQueryExecution(input, 'queued')
}

function createQueryExecution(
  input: ExecuteQueryInput,
  status: QueryGatewayExecution['summary']['status'],
): QueryGatewayExecution {
  const { plan, actor } = input
  if (plan.ir.semanticVersion !== actor.semanticVersion) throw new Error('Query semantic version does not match actor context')
  if (plan.estimatedRows > plan.budget.maxRows) throw new Error('Query row estimate exceeds budget')
  if (plan.estimatedScanBytes > plan.budget.maxScanBytes) throw new Error('Query scan estimate exceeds budget')
  assertReadOnlySql(plan.sql)
  const cacheKey = createQueryCacheKey(plan)
  const cancellation = createQueryCancellationPlan(plan)
  const summary: QueryExecutionSummary = {
    dialect: plan.dialect,
    dialectCapability: getQueryDialectCapability(plan.dialect),
    sqlFingerprint: plan.sqlFingerprint,
    cacheKey,
    cache: createCachePolicy(plan, actor),
    permissionDigest: plan.permissionDigest,
    dataVersion: plan.dataVersion,
    estimatedRows: plan.estimatedRows,
    estimatedScanBytes: plan.estimatedScanBytes,
    explain: createExplainSummary(plan),
    timeoutMs: plan.budget.timeoutMs,
    maxRows: plan.budget.maxRows,
    appliedGuards: [...plan.appliedGuards, 'cancellation_token'],
    cancellation,
    status,
  }
  return {
    summary,
    rows: [],
  }
}

export function markQueryExecutionRunning(summary: QueryExecutionSummary): QueryExecutionSummary {
  return { ...summary, status: 'running' }
}

export function applyQueryAdapterOutcome(
  summary: QueryExecutionSummary,
  outcome: QueryAdapterOutcome,
): QueryExecutionSummary {
  const completed = outcome.status === 'executed'
  return {
    ...summary,
    estimatedRows: outcome.explain.estimatedRows,
    estimatedScanBytes: outcome.explain.estimatedScanBytes,
    explain: {
      available: true,
      estimatedRows: outcome.explain.estimatedRows,
      estimatedScanBytes: outcome.explain.estimatedScanBytes,
      costUnits: outcome.explain.costUnits,
      budgetStatus: outcome.status === 'blocked' ? 'blocked' : 'within_budget',
      checkedAt: outcome.explain.checkedAt,
      redacted: true,
    },
    cancellation: completed || outcome.status === 'blocked'
      ? { ...summary.cancellation, status: 'not_required' }
      : summary.cancellation,
    status: outcome.status,
  }
}

export function listQueryDialectCapabilities(): QueryDialectCapability[] {
  return [
    {
      dialect: 'postgresql',
      status: 'local_supported',
      parameterStyle: 'numbered',
      explainSupported: true,
      cancellationSupported: true,
      notes: ['本地 compiler/gateway 可生成 numbered 参数与 public-safe EXPLAIN 预算摘要。'],
    },
    {
      dialect: 'snowflake',
      status: 'plugin_declared',
      parameterStyle: 'numbered',
      explainSupported: true,
      cancellationSupported: true,
      notes: ['Snowflake adapter 尚未接入；生产实现需提供绑定参数、warehouse cost 归一化和取消协议。'],
    },
    ...(['mysql', 'clickhouse', 'starrocks', 'trino', 'bigquery'] as QueryDialect[]).map((dialect) => ({
      dialect,
      status: 'plugin_declared' as const,
      parameterStyle: dialect === 'bigquery' ? 'named' as const : 'question_mark' as const,
      explainSupported: true,
      cancellationSupported: true,
      notes: ['插件接口已声明，生产 adapter 接入前不会作为 trusted mode 默认执行方言。'],
    })),
  ]
}

export function getQueryDialectCapability(dialect: QueryDialect): QueryDialectCapability {
  const capability = listQueryDialectCapabilities().find((item) => item.dialect === dialect)
  if (!capability) throw new Error(`Unsupported query dialect: ${dialect}`)
  return capability
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

function createExplainSummary(plan: ExecuteQueryInput['plan']): QueryExecutionSummary['explain'] {
  const costUnits = Number((plan.estimatedScanBytes / 1_000_000 + plan.estimatedRows / 1000).toFixed(2))
  return {
    available: true,
    estimatedRows: plan.estimatedRows,
    estimatedScanBytes: plan.estimatedScanBytes,
    costUnits,
    budgetStatus: plan.estimatedRows <= plan.budget.maxRows && plan.estimatedScanBytes <= plan.budget.maxScanBytes
      ? 'within_budget'
      : 'blocked',
    checkedAt: 'compile_time',
    redacted: true,
  }
}

function createCachePolicy(plan: ExecuteQueryInput['plan'], actor: ExecuteQueryInput['actor']): QueryExecutionSummary['cache'] {
  return {
    ttlSeconds: 180,
    keyIncludes: [
      'tenant',
      'workspace',
      'business_domain',
      'mode',
      'semantic_version',
      'sql_fingerprint',
      'permission_digest',
      'data_version',
      'policy_version',
    ],
    invalidation: {
      dataVersion: plan.dataVersion,
      semanticVersion: plan.ir.semanticVersion,
      permissionDigest: plan.permissionDigest,
      policyVersion: actor.policyVersion,
      reasons: ['data_version_changed', 'semantic_version_changed', 'permission_changed', 'policy_changed', 'ttl_expired'],
    },
    stale: false,
  }
}
