import { describe, expect, it, vi } from 'vitest'
import { createChatBiApplicationService, createQueryExecutionCoordinator } from '../application'
import type { ActorContext } from '../contracts'
import { createInMemoryChatBiPersistence } from '../persistence'
import type { QueryAdapter, QueryAdapterOutcome } from '../query'

const at = '2026-07-15T12:00:00.000Z'
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

function createHarness(adapter: QueryAdapter) {
  const persistence = createInMemoryChatBiPersistence()
  const dispatcher = createQueryExecutionCoordinator({ adapter, persistence, now: () => at })
  const service = createChatBiApplicationService({ persistence, queryDispatcher: dispatcher, now: () => at })
  return { persistence, dispatcher, service }
}

function submit(service: ReturnType<typeof createHarness>['service'], suffix: string) {
  return service.submitQuestion({
    idempotencyKey: `query_worker_${suffix}`,
    conversationId: `conversation_query_worker_${suffix}`,
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
  })
}

function executedOutcome(): QueryAdapterOutcome {
  return {
    status: 'executed',
    explain: {
      estimatedRows: 12,
      estimatedScanBytes: 2048,
      costUnits: 4.2,
      checkedAt: at,
    },
    fields: [
      { name: 'order_date', databaseType: 'timestamptz' },
      { name: 'net_revenue', databaseType: 'numeric' },
    ],
    rows: [
      { order_date: '2026-06-01T00:00:00.000Z', net_revenue: 128000 },
    ],
    rowCount: 1,
    truncated: false,
  }
}

describe('queued PostgreSQL query execution coordinator', () => {
  it('returns querying first and publishes a grounded real-query result after the worker wins its lease', async () => {
    const runReadOnly = vi.fn(async () => executedOutcome())
    const { service, dispatcher } = createHarness({ dialect: 'postgresql', runReadOnly })

    const created = submit(service, 'success')
    expect(created).toMatchObject({
      ok: true,
      data: {
        displayStatus: 'querying',
        executedQuery: false,
        queryExecution: { status: 'queued' },
      },
    })
    if (!created.ok) throw new Error('expected queued run')

    await expect(dispatcher.runOnce(created.data.runId)).resolves.toMatchObject({ status: 'completed' })
    const completed = service.getRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })
    expect(completed).toMatchObject({
      ok: true,
      data: {
        displayStatus: 'completed',
        executedQuery: true,
        queryExecution: {
          status: 'executed',
          estimatedRows: 12,
          explain: { checkedAt: at },
        },
        result: {
          answer: { generatedFrom: 'query_result' },
          rows: [{ values: { net_revenue: 128000 } }],
        },
      },
    })
    expect(runReadOnly).toHaveBeenCalledWith(expect.objectContaining({
      dataSourceId: 'warehouse_sales',
      parameters: ['tenant_demo', 'workspace_sales', 'sales', 365],
    }), expect.any(AbortSignal))
  })

  it('fails closed when real EXPLAIN exceeds the scan budget', async () => {
    const { service, dispatcher } = createHarness({
      dialect: 'postgresql',
      runReadOnly: async () => ({
        status: 'blocked',
        reason: 'scan_budget',
        explain: {
          estimatedRows: 900,
          estimatedScanBytes: 900_000_000,
          costUnits: 220,
          checkedAt: at,
        },
      }),
    })

    const created = submit(service, 'blocked')
    if (!created.ok) throw new Error('expected queued run')
    await dispatcher.runOnce(created.data.runId)
    const failed = service.getRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })
    expect(failed).toMatchObject({
      ok: true,
      data: {
        displayStatus: 'failed',
        executedQuery: false,
        error: { code: 'QUERY_TOO_EXPENSIVE' },
        queryExecution: {
          status: 'blocked',
          explain: { budgetStatus: 'blocked', checkedAt: at },
        },
      },
    })
  })

  it('propagates idempotent cancellation to the active adapter and never publishes late rows', async () => {
    let observedSignal: AbortSignal | undefined
    const { service, dispatcher } = createHarness({
      dialect: 'postgresql',
      runReadOnly: (_input, signal) => new Promise((_resolve, reject) => {
        observedSignal = signal
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), {
          code: 'QUERY_CANCELLED',
          retryable: false,
        })), { once: true })
      }),
    })

    const created = submit(service, 'cancel')
    if (!created.ok) throw new Error('expected queued run')
    const cycle = dispatcher.runOnce(created.data.runId)
    await Promise.resolve()
    const first = service.cancelRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })
    const second = service.cancelRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })

    expect(observedSignal?.aborted).toBe(true)
    expect(first).toMatchObject({ ok: true, data: { displayStatus: 'waiting_input', executedQuery: false } })
    expect(second).toMatchObject({ ok: true, data: { displayStatus: 'waiting_input', executedQuery: false } })
    await expect(cycle).resolves.toMatchObject({ status: 'cancelled' })
    expect(service.getRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })).toMatchObject({
      ok: true,
      data: {
        displayStatus: 'waiting_input',
        result: undefined,
        queryExecution: { status: 'cancelled', cancellation: { status: 'propagated' } },
      },
    })
  })
})
