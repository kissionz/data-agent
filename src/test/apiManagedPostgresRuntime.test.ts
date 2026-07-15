import { describe, expect, it, vi } from 'vitest'
import { createApiRuntime } from '../../apps/api/src/app'
import type { PostgresQueryRuntime, PostgresQueryRuntimeReadiness } from '../../apps/api/src/postgresQueryRuntime'
import type { TransactionalQueryExecutionControlPlane } from '../../apps/api/src/transactionalQueryExecutionCoordinator'
import { createInMemoryQueryControlPlane } from '../persistence/controlPlaneMemory'
import { createInMemoryResultPageStore, createInMemoryRunEventStore } from '../persistence/resultMemory'
import type { QueryRunJobPayload } from '../application/queryExecutionCoordinator'

const actorHeaders = {
  'x-tenant-id': 'tenant_demo',
  'x-workspace-id': 'workspace_sales',
  'x-user-id': 'user_lin',
  'x-business-domain-id': 'sales',
  'x-semantic-version': 'sales-semantic-2026.06.1',
}

describe('API managed PostgreSQL runtime wiring', () => {
  it('rejects legacy adapter-only injection in staging and production', () => {
    expect(() => createApiRuntime({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    }, {
      queryAdapter: {
        dialect: 'postgresql',
        runReadOnly: async () => { throw new Error('not used') },
      },
    })).toThrow('transactional managed runtime')
  })

  it('uses one transactional runtime for durable API, readiness, worker lifecycle and shutdown', async () => {
    const memory = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const controlPlane: TransactionalQueryExecutionControlPlane = {
      ...memory,
      cancelRun: vi.fn(async () => ({ ok: false as const, reason: 'not_found' as const })),
      commitAttempt: vi.fn(async () => { throw new Error('not used') }),
    }
    let state: PostgresQueryRuntimeReadiness = {
      ok: false,
      query: 'ok',
      controlPlane: 'ok',
      worker: { running: false, draining: false, active: false },
    }
    const start = vi.fn(() => {
      state = { ...state, ok: true, worker: { ...state.worker, running: true } }
    })
    const close = vi.fn(async () => ({ drained: true, timedOut: false }))
    const postgresRuntime: PostgresQueryRuntime = {
      controlPlane,
      resultPageStore: createInMemoryResultPageStore(),
      runEventStore: createInMemoryRunEventStore(),
      start,
      runOnce: vi.fn(async () => ({ status: 'idle' })),
      checkReadiness: vi.fn(async () => state),
      readiness: () => state,
      close,
    }
    const runtime = createApiRuntime({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    }, { postgresRuntime })

    expect(runtime.readiness()).toMatchObject({
      ok: false,
      checks: { query: 'ok', controlPlane: 'ok', worker: 'stopped' },
    })
    runtime.startQueryWorker()
    expect(start).toHaveBeenCalledTimes(1)
    expect(runtime.readiness()).toMatchObject({
      ok: true,
      checks: { query: 'ok', controlPlane: 'ok', worker: 'running' },
    })

    const response = await runtime.handleAsync({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'managed-runtime-submit' },
      body: {
        conversation_id: 'conversation_managed_runtime',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })
    expect(response).toMatchObject({ status: 202, body: { ok: true, data: { displayStatus: 'querying' } } })

    await expect(runtime.runQueryWorkerOnce()).resolves.toEqual({ status: 'idle' })
    await runtime.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
