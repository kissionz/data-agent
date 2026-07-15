import { describe, expect, it } from 'vitest'
import {
  PostgresQueryAdapterError,
  createPostgresQueryAdapter,
  type PostgresPoolClientLike,
  type PostgresPoolLike,
} from '../../apps/api/src/adapters/postgresQueryAdapter'
import type { QueryAdapterInput } from '../../src/query/types'

interface QueryCall {
  text: string
  values?: readonly unknown[]
}

const explainRow = (rows = 3, width = 24, cost = 12.5) => ({
  'QUERY PLAN': [{
    Plan: {
      'Node Type': 'Aggregate',
      'Plan Rows': rows,
      'Plan Width': width,
      'Total Cost': cost,
      Plans: [{
        'Node Type': 'Seq Scan',
        'Plan Rows': rows,
        'Plan Width': width,
        'Total Cost': cost - 1,
      }],
    },
  }],
})

function input(patch: Partial<QueryAdapterInput> = {}): QueryAdapterInput {
  return {
    executionId: 'exec_001',
    cancellationToken: 'cancel_001',
    dataSourceId: 'warehouse_sales',
    sql: 'SELECT order_date, net_revenue FROM semantic_sales.dwd_order_settlement WHERE tenant_id = $1 LIMIT 10',
    parameters: ['tenant_demo'],
    sqlFingerprint: 'sql_fp_001',
    budget: { timeoutMs: 2_000, maxRows: 10, maxScanBytes: 10_000 },
    ...patch,
  }
}

class FakeClient implements PostgresPoolClientLike {
  readonly calls: QueryCall[] = []
  released = false
  releaseError: Error | boolean | undefined

  constructor(
    private readonly execute: (text: string, values?: readonly unknown[]) => Promise<{
      rows: Array<Record<string, unknown>>
      rowCount: number | null
      fields?: Array<{ name: string; dataTypeID: number }>
    }>,
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) {
    this.calls.push({ text, values })
    return await this.execute(text, values) as {
      rows: Row[]
      rowCount: number | null
      fields?: Array<{ name: string; dataTypeID: number }>
    }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseError = error
  }
}

class FakePool implements PostgresPoolLike {
  readonly cancellationCalls: QueryCall[] = []
  connectCount = 0

  constructor(
    readonly client: FakeClient,
    private readonly cancel: (values?: readonly unknown[]) => Promise<boolean> = async () => true,
  ) {}

  async connect() {
    this.connectCount += 1
    return this.client
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ) {
    this.cancellationCalls.push({ text, values })
    if (text === 'select 1 as ready') {
      return { rows: [{ ready: 1 }] as Row[], rowCount: 1 }
    }
    const cancelled = await this.cancel(values)
    return { rows: [{ cancelled }] as Row[], rowCount: 1 }
  }
}

function successClient() {
  return new FakeClient(async (text) => {
    if (text === 'select pg_backend_pid() as backend_pid') return { rows: [{ backend_pid: 4242 }], rowCount: 1 }
    if (text.startsWith('EXPLAIN ')) return { rows: [explainRow()], rowCount: 1 }
    if (text.startsWith('SELECT order_date')) {
      return {
        rows: [{ order_date: new Date('2026-05-01T00:00:00.000Z'), net_revenue: '1326000.00' }],
        rowCount: 1,
        fields: [
          { name: 'order_date', dataTypeID: 1082 },
          { name: 'net_revenue', dataTypeID: 1700 },
        ],
      }
    }
    return { rows: [], rowCount: 0 }
  })
}

describe('PostgreSQL QueryAdapter unit boundary', () => {
  it('runs EXPLAIN and the parameterized body in one read-only transaction', async () => {
    const client = successClient()
    const pool = new FakePool(client)
    const adapter = createPostgresQueryAdapter({ pool, now: () => new Date('2026-07-15T10:00:00.000Z') })
    const request = input()

    const outcome = await adapter.runReadOnly(request, new AbortController().signal)

    expect(outcome).toEqual({
      status: 'executed',
      explain: {
        estimatedRows: 3,
        estimatedScanBytes: 72,
        costUnits: 12.5,
        checkedAt: '2026-07-15T10:00:00.000Z',
      },
      fields: [
        { name: 'order_date', databaseType: '1082' },
        { name: 'net_revenue', databaseType: '1700' },
      ],
      rows: [{ order_date: '2026-05-01T00:00:00.000Z', net_revenue: '1326000.00' }],
      rowCount: 1,
      truncated: false,
    })
    expect(client.calls.map((call) => call.text)).toEqual([
      'BEGIN READ ONLY',
      "select set_config('statement_timeout', $1, true)",
      "select set_config('idle_in_transaction_session_timeout', $1, true)",
      'select pg_backend_pid() as backend_pid',
      `EXPLAIN (FORMAT JSON, COSTS TRUE) ${request.sql}`,
      request.sql,
      'COMMIT',
    ])
    expect(client.calls[4].values).toBe(request.parameters)
    expect(client.calls[5].values).toBe(request.parameters)
    expect(client.released).toBe(true)
  })

  it('fails closed on the real EXPLAIN scan budget and never executes the query body', async () => {
    const client = new FakeClient(async (text) => {
      if (text === 'select pg_backend_pid() as backend_pid') return { rows: [{ backend_pid: 4242 }], rowCount: 1 }
      if (text.startsWith('EXPLAIN ')) return { rows: [explainRow(1_000, 100)], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const adapter = createPostgresQueryAdapter({ pool: new FakePool(client) })
    const request = input({ budget: { timeoutMs: 2_000, maxRows: 2_000, maxScanBytes: 10_000 } })

    await expect(adapter.runReadOnly(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'scan_budget',
      explain: { estimatedRows: 1_000, estimatedScanBytes: 100_000 },
    })
    expect(client.calls.some((call) => call.text === request.sql)).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('uses the configured EXPLAIN cost ceiling as a fail-closed budget', async () => {
    const client = new FakeClient(async (text) => {
      if (text === 'select pg_backend_pid() as backend_pid') return { rows: [{ backend_pid: 4242 }], rowCount: 1 }
      if (text.startsWith('EXPLAIN ')) return { rows: [explainRow(3, 24, 12.5)], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const adapter = createPostgresQueryAdapter({ pool: new FakePool(client) })
    const request = input({
      budget: { timeoutMs: 2_000, maxRows: 10, maxScanBytes: 10_000, maxCostUnits: 12 },
    })

    await expect(adapter.runReadOnly(request, new AbortController().signal)).resolves.toMatchObject({
      status: 'blocked',
      reason: 'cost_budget',
      explain: { costUnits: 12.5 },
    })
    expect(client.calls.some((call) => call.text === request.sql)).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('fails closed when EXPLAIN is malformed', async () => {
    const client = new FakeClient(async (text) => {
      if (text === 'select pg_backend_pid() as backend_pid') return { rows: [{ backend_pid: 4242 }], rowCount: 1 }
      if (text.startsWith('EXPLAIN ')) return { rows: [{ 'QUERY PLAN': [] }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    const adapter = createPostgresQueryAdapter({ pool: new FakePool(client) })

    await expect(adapter.runReadOnly(input(), new AbortController().signal)).rejects.toMatchObject({ code: 'QUERY_BLOCKED' })
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('maps statement timeout to a public-safe error and rolls back without leaking driver details', async () => {
    const secret = 'postgres://reader:secret@example.internal/private'
    const client = new FakeClient(async (text) => {
      if (text === 'select pg_backend_pid() as backend_pid') return { rows: [{ backend_pid: 4242 }], rowCount: 1 }
      if (text.startsWith('EXPLAIN ')) return { rows: [explainRow()], rowCount: 1 }
      if (text.startsWith('SELECT order_date')) throw Object.assign(new Error(secret), { code: '57014' })
      return { rows: [], rowCount: 0 }
    })
    const adapter = createPostgresQueryAdapter({ pool: new FakePool(client) })

    const error = await adapter.runReadOnly(input(), new AbortController().signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PostgresQueryAdapterError)
    expect(error).toMatchObject({ code: 'QUERY_TIMEOUT', message: '查询超过执行时限。', retryable: true })
    expect(JSON.stringify(error)).not.toContain(secret)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('uses pg_cancel_backend for AbortSignal cancellation and releases after rollback', async () => {
    let rejectBody: ((error: unknown) => void) | undefined
    let bodyStarted!: () => void
    const started = new Promise<void>((resolve) => { bodyStarted = resolve })
    const client = new FakeClient(async (text) => {
      if (text === 'select pg_backend_pid() as backend_pid') return { rows: [{ backend_pid: 4242 }], rowCount: 1 }
      if (text.startsWith('EXPLAIN ')) return { rows: [explainRow()], rowCount: 1 }
      if (text.startsWith('SELECT order_date')) {
        bodyStarted()
        return await new Promise((_, reject) => { rejectBody = reject })
      }
      return { rows: [], rowCount: 0 }
    })
    const pool = new FakePool(client, async () => {
      rejectBody?.(Object.assign(new Error('raw cancellation detail'), { code: '57014' }))
      return true
    })
    const adapter = createPostgresQueryAdapter({ pool })
    const controller = new AbortController()
    const execution = adapter.runReadOnly(input(), controller.signal)
    await started

    controller.abort()

    await expect(execution).rejects.toMatchObject({ code: 'QUERY_CANCELLED', message: '查询已取消。' })
    expect(pool.cancellationCalls).toContainEqual({
      text: 'select pg_cancel_backend($1) as cancelled',
      values: [4242],
    })
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('observes AbortSignal while waiting for a pool connection and releases a late client', async () => {
    const client = successClient()
    let resolveConnect!: (client: PostgresPoolClientLike) => void
    const pool: PostgresPoolLike = {
      connect: () => new Promise((resolve) => { resolveConnect = resolve }),
      query: async () => ({ rows: [], rowCount: 0 }),
    }
    const adapter = createPostgresQueryAdapter({ pool })
    const controller = new AbortController()
    const execution = adapter.runReadOnly(input(), controller.signal)

    controller.abort()

    await expect(execution).rejects.toMatchObject({ code: 'QUERY_CANCELLED' })
    resolveConnect(client)
    await Promise.resolve()
    expect(client.released).toBe(true)
  })

  it('rejects comments, mismatched sources, placeholder gaps and invalid budgets before acquiring a connection', async () => {
    const client = successClient()
    const pool = new FakePool(client)
    const adapter = createPostgresQueryAdapter({ pool })

    await expect(adapter.runReadOnly(input({ sql: 'SELECT 1 -- bypass' }), new AbortController().signal))
      .rejects.toMatchObject({ code: 'QUERY_BLOCKED' })
    await expect(adapter.runReadOnly(input({ dataSourceId: 'warehouse_other' }), new AbortController().signal))
      .rejects.toMatchObject({ code: 'QUERY_BLOCKED' })
    await expect(adapter.runReadOnly(input({
      sql: 'SELECT order_date FROM semantic_sales.dwd_order_settlement WHERE tenant_id = $2',
      parameters: ['tenant_demo'],
    }), new AbortController().signal)).rejects.toMatchObject({ code: 'QUERY_BLOCKED' })
    await expect(adapter.runReadOnly(input({ budget: { timeoutMs: 0, maxRows: 10, maxScanBytes: 10 } }), new AbortController().signal))
      .rejects.toMatchObject({ code: 'QUERY_BLOCKED' })
    expect(pool.connectCount).toBe(0)
  })
})
