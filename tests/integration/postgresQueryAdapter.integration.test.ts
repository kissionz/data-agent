import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  PostgresQueryAdapterError,
  createPostgresPool,
  createPostgresQueryAdapter,
  type PostgresQueryAdapter,
} from '../../apps/api/src/adapters/postgresQueryAdapter'
import { ANALYSIS_IR_VERSION, type ActorContext, type AnalysisIR } from '../../src/contracts'
import { compileAnalysisQuery } from '../../src/query/compiler'
import type { QueryAdapterInput } from '../../src/query/types'

const readerUrl = process.env.CHATBI_TEST_POSTGRES_URL
  ?? 'postgresql://chatbi_reader:chatbi_reader@127.0.0.1:55432/chatbi_test'
const adminUrl = process.env.CHATBI_TEST_POSTGRES_ADMIN_URL
  ?? 'postgresql://chatbi_admin:chatbi_admin@127.0.0.1:55432/chatbi_test'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'integration_reader',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

function analysisIr(patch: Partial<AnalysisIR> = {}): AnalysisIR {
  return {
    schemaVersion: ANALYSIS_IR_VERSION,
    irId: 'ir_postgres_integration',
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
      timezone: actor.timezone,
      grain: 'month',
    },
    limit: 500,
    assumptions: ['integration fixture'],
    safety: {
      requiresClarification: false,
      executedQuery: true,
      permissionChecked: true,
      budgetChecked: true,
    },
    ...patch,
  }
}

function adapterInput(ir: AnalysisIR = analysisIr(), patch: Partial<QueryAdapterInput> = {}): QueryAdapterInput {
  const plan = compileAnalysisQuery({ ir, actor })
  return {
    executionId: 'exec_postgres_integration',
    cancellationToken: 'cancel_postgres_integration',
    dataSourceId: plan.dataSourceId,
    sql: plan.sql,
    parameters: plan.parameters,
    sqlFingerprint: plan.sqlFingerprint,
    budget: plan.budget,
    ...patch,
  }
}

describe('PostgreSQL QueryAdapter real integration', () => {
  let adapter: PostgresQueryAdapter
  let adminPool: Pool

  beforeAll(async () => {
    const pool = createPostgresPool({
      connectionString: readerUrl,
      max: 4,
      connectionTimeoutMillis: 2_000,
    })
    adapter = createPostgresQueryAdapter({ pool, maxStatementTimeoutMs: 15_000 })
    adminPool = new Pool({ connectionString: adminUrl, max: 2, connectionTimeoutMillis: 2_000 })
    await adapter.readiness()
    await adminPool.query('select 1')
  })

  afterAll(async () => {
    await adapter?.close()
    await adminPool?.end()
  })

  it('executes compiled SQL against PostgreSQL and isolates tenant/workspace/domain rows', async () => {
    const outcome = await adapter.runReadOnly(adapterInput(), new AbortController().signal)

    expect(outcome.status).toBe('executed')
    if (outcome.status !== 'executed') throw new Error('expected executed outcome')
    expect(outcome.rowCount).toBe(3)
    expect(outcome.rows.map((row) => row.net_revenue)).toEqual(['1184000.00', '1268000.00', '1326000.00'])
    expect(outcome.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ net_revenue: '7000000.00' }),
      expect.objectContaining({ net_revenue: '9000000.00' }),
      expect.objectContaining({ net_revenue: '8000000.00' }),
    ]))
    expect(outcome.explain).toMatchObject({
      estimatedRows: expect.any(Number),
      estimatedScanBytes: expect.any(Number),
      costUnits: expect.any(Number),
    })
    expect(outcome.fields.map((field) => field.name)).toEqual(['order_date', 'net_revenue'])
  })

  it('binds adversarial filter text as a value instead of changing SQL semantics', async () => {
    const maliciousValue = "华东' OR '1'='1"
    const ir = analysisIr({
      intent: 'breakdown',
      dimensionIds: ['region'],
      filters: [{ dimensionId: 'region', operator: 'eq', values: [maliciousValue], source: 'user' }],
    })
    const request = adapterInput(ir)
    expect(request.sql).not.toContain(maliciousValue)

    const outcome = await adapter.runReadOnly(request, new AbortController().signal)

    expect(outcome).toMatchObject({ status: 'executed', rowCount: 0, rows: [] })
    const table = await adminPool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'semantic_sales' and table_name = 'dwd_order_settlement'",
    )
    expect(table.rows).toEqual([{ table_name: 'dwd_order_settlement' }])
  })

  it('uses the real JSON plan to block a scan budget before body execution', async () => {
    const outcome = await adapter.runReadOnly(
      adapterInput(analysisIr(), {
        budget: { timeoutMs: 2_000, maxRows: 500, maxScanBytes: 1 },
      }),
      new AbortController().signal,
    )

    expect(outcome).toMatchObject({
      status: 'blocked',
      reason: 'scan_budget',
      explain: { estimatedScanBytes: expect.any(Number) },
    })
  })

  it('enforces database-level read-only access independently of the SQL validator', async () => {
    const reader = new Pool({ connectionString: readerUrl, max: 1 })
    try {
      const error = await reader.query(
        "insert into semantic_sales.dwd_order_settlement (tenant_id, workspace_id, business_domain_id, order_date, completed_order_id, net_revenue, region_id, sku_id) values ('x', 'x', 'x', current_date, 'x', 1, 'east', 'x')",
      ).catch((caught: unknown) => caught)
      expect(error).toMatchObject({ code: expect.stringMatching(/^(25006|42501)$/) })
    } finally {
      await reader.end()
    }
  })

  it('propagates AbortSignal through pg_cancel_backend in less than three seconds', async () => {
    const locker = await adminPool.connect()
    const controller = new AbortController()
    try {
      await locker.query('begin')
      await locker.query('lock table semantic_sales.dwd_order_settlement in access exclusive mode')
      const startedAt = Date.now()
      const execution = adapter.runReadOnly(adapterInput(), controller.signal)
      await new Promise((resolve) => setTimeout(resolve, 150))

      controller.abort()

      const error = await execution.catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(PostgresQueryAdapterError)
      expect(error).toMatchObject({ code: 'QUERY_CANCELLED', message: '查询已取消。' })
      expect(Date.now() - startedAt).toBeLessThan(3_000)
    } finally {
      await locker.query('rollback')
      locker.release()
    }
  })

  it('maps PostgreSQL statement_timeout to a public-safe timeout error', async () => {
    const locker = await adminPool.connect()
    try {
      await locker.query('begin')
      await locker.query('lock table semantic_sales.dwd_order_settlement in access exclusive mode')
      const request = adapterInput(analysisIr(), {
        budget: { timeoutMs: 200, maxRows: 500, maxScanBytes: 100_000_000 },
      })

      const error = await adapter.runReadOnly(request, new AbortController().signal).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(PostgresQueryAdapterError)
      expect(error).toMatchObject({ code: 'QUERY_TIMEOUT', message: '查询超过执行时限。', retryable: true })
      expect(JSON.stringify(error)).not.toMatch(/postgres:\/\/|semantic_sales|dwd_order_settlement|select\s/i)
    } finally {
      await locker.query('rollback')
      locker.release()
    }
  })
})
