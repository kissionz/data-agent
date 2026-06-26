import { describe, expect, it } from 'vitest'
import { ANALYSIS_IR_VERSION, type ActorContext, type AnalysisIR } from '../contracts'
import {
  assertReadOnlySql,
  compileAnalysisQuery,
  createQueryCancellationPlan,
  executeReadOnlyQuery,
  listQueryDialectCapabilities,
  markQueryExecutionCancelled,
} from '../query'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

function ir(patch: Partial<AnalysisIR> = {}): AnalysisIR {
  return {
    schemaVersion: ANALYSIS_IR_VERSION,
    irId: 'ir_query_001',
    revision: 1,
    mode: 'trusted',
    semanticVersion: actor.semanticVersion,
    intent: 'trend',
    metricIds: ['net_revenue'],
    dimensionIds: ['order_date'],
    filters: [],
    timeRange: {
      kind: 'relative',
      expression: 'last_12_complete_months',
      timezone: 'Asia/Shanghai',
      grain: 'month',
    },
    limit: 500,
    assumptions: ['使用认证指标。'],
    safety: {
      requiresClarification: false,
      executedQuery: true,
      permissionChecked: true,
      budgetChecked: true,
    },
    ...patch,
  }
}

describe('deterministic SQL compiler and query gateway', () => {
  it('compiles Analysis IR into deterministic read-only SQL with tenant and workspace guards', () => {
    const first = compileAnalysisQuery({ ir: ir(), actor })
    const second = compileAnalysisQuery({ ir: ir(), actor })

    expect(first.sql).toContain('SELECT')
    expect(first.sql).toContain('f.tenant_id = $1')
    expect(first.sql).toContain('f.workspace_id = $2')
    expect(first.sql).toContain('f.business_domain_id = $3')
    expect(first.parameters.slice(0, 3)).toEqual(['tenant_demo', 'workspace_sales', 'sales'])
    expect(first.sqlFingerprint).toBe(second.sqlFingerprint)
    expect(first.appliedGuards).toEqual(expect.arrayContaining(['semantic_catalog', 'join_graph', 'read_only_ast', 'budget_limit']))
  })

  it('parameterizes filter values and rejects SQL control tokens', () => {
    const safe = compileAnalysisQuery({
      ir: ir({
        dimensionIds: ['region'],
        filters: [{
          dimensionId: 'region',
          operator: 'eq',
          values: ['华东'],
          source: 'user',
        }],
      }),
      actor,
    })

    expect(safe.sql).toContain('r.region_name = $5')
    expect(safe.sql).not.toContain('华东')
    expect(safe.parameters).toContain('华东')

    expect(() => compileAnalysisQuery({
      ir: ir({
        filters: [{
          dimensionId: 'region',
          operator: 'eq',
          values: ["华东'; drop table users; --"],
          source: 'user',
        }],
      }),
      actor,
    })).toThrow('unsafe SQL control tokens')
  })

  it('rejects non-read-only SQL and multiple statements at the gateway boundary', () => {
    expect(() => assertReadOnlySql('delete from orders')).toThrow('SELECT')
    expect(() => assertReadOnlySql('select * from orders; drop table orders')).toThrow('multiple SQL statements')
    expect(() => assertReadOnlySql('select * from orders where id = 1')).not.toThrow()
  })

  it('refuses untrusted semantic objects and unapproved Join Graph paths before SQL execution', () => {
    expect(() => compileAnalysisQuery({
      ir: ir({ metricIds: ['refund_rate'] }),
      actor,
    })).toThrow('not certified')

    expect(() => compileAnalysisQuery({
      ir: ir({ dimensionIds: ['product_line'] }),
      actor,
    })).toThrow('high risk')

    expect(() => compileAnalysisQuery({
      ir: ir({ semanticVersion: 'sales-semantic-2026.04.1' }),
      actor,
    })).toThrow('semantic version')
  })

  it('blocks over-budget plans and returns a public-safe execution summary for allowed plans', () => {
    const plan = compileAnalysisQuery({ ir: ir(), actor })
    const execution = executeReadOnlyQuery({ plan, actor })

    expect(execution.summary).toMatchObject({
      dialect: 'postgresql',
      dialectCapability: {
        dialect: 'postgresql',
        status: 'local_supported',
        explainSupported: true,
        cancellationSupported: true,
      },
      sqlFingerprint: plan.sqlFingerprint,
      permissionDigest: plan.permissionDigest,
      cache: {
        ttlSeconds: 180,
        stale: false,
        keyIncludes: expect.arrayContaining(['tenant', 'semantic_version', 'sql_fingerprint', 'permission_digest', 'data_version', 'policy_version']),
        invalidation: {
          dataVersion: plan.dataVersion,
          semanticVersion: actor.semanticVersion,
          permissionDigest: plan.permissionDigest,
          reasons: expect.arrayContaining(['data_version_changed', 'semantic_version_changed', 'permission_changed', 'policy_changed', 'ttl_expired']),
        },
      },
      explain: {
        available: true,
        estimatedRows: plan.estimatedRows,
        estimatedScanBytes: plan.estimatedScanBytes,
        budgetStatus: 'within_budget',
        redacted: true,
      },
      status: 'executed',
      cancellation: {
        propagationTargets: ['planner', 'compiler', 'query_adapter', 'result_writer'],
        deadlineMs: 3000,
        status: 'pending',
      },
    })
    expect(execution.summary.cacheKey).toMatch(/^qcache_/)
    expect(execution.summary.cancellation.token).toMatch(/^qcancel_/)
    expect(JSON.stringify(execution.summary)).not.toContain('SELECT')

    const overBudget = compileAnalysisQuery({
      ir: ir(),
      actor,
      budget: { maxScanBytes: 10 },
    })
    expect(() => executeReadOnlyQuery({ plan: overBudget, actor })).toThrow('scan estimate exceeds budget')
  })

  it('declares a dialect plugin matrix while only executing locally supported dialects', () => {
    const capabilities = listQueryDialectCapabilities()

    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ dialect: 'postgresql', status: 'local_supported', parameterStyle: 'numbered' }),
      expect.objectContaining({ dialect: 'snowflake', status: 'local_supported', parameterStyle: 'numbered' }),
      expect.objectContaining({ dialect: 'mysql', status: 'plugin_declared', parameterStyle: 'question_mark' }),
      expect.objectContaining({ dialect: 'clickhouse', status: 'plugin_declared' }),
      expect.objectContaining({ dialect: 'starrocks', status: 'plugin_declared' }),
      expect.objectContaining({ dialect: 'trino', status: 'plugin_declared' }),
      expect.objectContaining({ dialect: 'bigquery', status: 'plugin_declared', parameterStyle: 'named' }),
    ]))
    expect(() => compileAnalysisQuery({ ir: ir(), actor, dialect: 'bigquery' })).toThrow('not locally executable')
  })

  it('creates stable cancellation handles and marks propagation without exposing SQL', () => {
    const plan = compileAnalysisQuery({ ir: ir(), actor })
    const first = createQueryCancellationPlan(plan)
    const second = createQueryCancellationPlan(plan)
    const execution = executeReadOnlyQuery({ plan, actor })
    const cancelled = markQueryExecutionCancelled(execution.summary, '2026-06-24T10:00:00+08:00')

    expect(first).toEqual(second)
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancellation: {
        token: first.token,
        status: 'propagated',
        propagatedAt: '2026-06-24T10:00:00+08:00',
      },
    })
    expect(JSON.stringify(cancelled)).not.toContain(plan.sql)
  })
})
