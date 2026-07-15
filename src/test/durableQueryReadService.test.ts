import { describe, expect, it, vi } from 'vitest'
import {
  createDurableQueryReadService,
  type DurableQueryReadServiceOptions,
} from '../../apps/api/src/durableQueryReadService'
import { createApiRuntime } from '../../apps/api/src'
import type {
  TransactionalQueryRunEvent,
  TransactionalResultManifestMetadata,
  TransactionalResultPage,
} from '../../apps/api/src/transactionalQueryExecutionCoordinator'
import { prepareQuerySubmission, type DurableQueryControlPlane } from '../application'
import type { ActorContext } from '../contracts'
import { transitionRun } from '../domain'
import { trendResult } from '../mocks'
import { createInMemoryResultPageStore, createInMemoryRunEventStore } from '../persistence/resultMemory'

const at = '2026-07-15T17:00:00.000Z'
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

function fixture() {
  const prepared = prepareQuerySubmission({
    idempotencyKey: 'durable_read',
    conversationId: 'conversation_durable_read',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
  }, { now: () => at })
  if (!prepared.ok) throw new Error('expected prepared submission')
  const record = {
    ...prepared.record,
    run: transitionRun(prepared.record.run, { type: 'RESULT_READY', result: trendResult, at }),
    executedQuery: true,
  }
  const conversation = { ...prepared.conversation, activeRunId: undefined, updatedAt: at }
  const controlPlane: DurableQueryControlPlane = {
    async getConversation(input) {
      return input.tenantId === actor.tenantId
        && input.workspaceId === actor.workspaceId
        && input.conversationId === conversation.id
        ? structuredClone(conversation)
        : undefined
    },
    async getRun(input) {
      return input.tenantId === actor.tenantId
        && input.workspaceId === actor.workspaceId
        && input.runId === record.run.id
        ? structuredClone(record)
        : undefined
    },
    async getRunByIdempotency() { return { status: 'not_found' } },
    async submitAndEnqueue() { return { ok: false, reason: 'run_identity_conflict' } },
    async cancelRun() { return { ok: false, reason: 'not_found' } },
  }
  const resultPageStore = createInMemoryResultPageStore<TransactionalResultPage, TransactionalResultManifestMetadata>()
  const runEventStore = createInMemoryRunEventStore<TransactionalQueryRunEvent>()
  const scope = { tenantId: actor.tenantId, workspaceId: actor.workspaceId, runId: record.run.id }
  const pageSize = 2
  const pages: TransactionalResultPage[] = []
  for (let offset = 0; offset < trendResult.rows.length; offset += pageSize) {
    pages.push({ columns: trendResult.columns, rows: trendResult.rows.slice(offset, offset + pageSize) })
  }
  const checksums = pages.map((_, pageIndex) => `checksum_${pageIndex}`)
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    resultPageStore.stagePage({
      ...scope,
      attempt: 1,
      pageIndex,
      checksum: checksums[pageIndex],
      rowCount: pages[pageIndex].rows.length,
      payload: pages[pageIndex],
      stagedAt: at,
    })
  }
  const metadata: TransactionalResultManifestMetadata = {
    schemaVersion: 'chatbi_result_manifest.v1',
    pageSize,
    columns: trendResult.columns,
    chartSpec: trendResult.chartSpec,
    completeness: trendResult.completeness,
    incompleteSteps: trendResult.incompleteSteps,
    warnings: trendResult.warnings,
    freshnessAt: trendResult.freshnessAt,
    semanticVersion: record.run.semanticVersion,
  }
  const options: DurableQueryReadServiceOptions<TransactionalQueryRunEvent> = {
    controlPlane,
    resultPageStore,
    runEventStore,
  }
  return { record, conversation, controlPlane, resultPageStore, runEventStore, scope, checksums, metadata, options }
}

function publish(test: ReturnType<typeof fixture>) {
  return test.resultPageStore.publishManifest({
    ...test.scope,
    attempt: 1,
    resultId: trendResult.id,
    manifestChecksum: 'manifest_checksum',
    pageChecksums: test.checksums,
    totalRows: trendResult.rows.length,
    metadata: test.metadata,
    publishedAt: at,
  })
}

describe('durable query read service', () => {
  it('reconstructs the existing ResultPageView cursor contract across published storage pages', async () => {
    const test = fixture()
    expect(publish(test)).toMatchObject({ ok: true })
    const service = createDurableQueryReadService(test.options)
    const getPage = vi.spyOn(test.resultPageStore, 'getPage')

    const response = await service.getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      cursor: 'offset:1',
      limit: 3,
    })

    expect(response).toMatchObject({
      ok: true,
      data: {
        runId: test.record.run.id,
        resultId: trendResult.id,
        columns: trendResult.columns,
        rows: trendResult.rows.slice(1, 4),
        page: {
          cursor: 'offset:1',
          limit: 3,
          nextCursor: undefined,
          hasMore: false,
          totalRows: trendResult.rows.length,
        },
        rawSqlExposed: false,
        rawDatabaseCredentialsExposed: false,
      },
    })
    expect(getPage).toHaveBeenCalledTimes(2)
    expect(getPage.mock.calls.map(([input]) => input.pageIndex)).toEqual([0, 1])

    getPage.mockClear()
    await service.getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      cursor: 'offset:0',
      limit: 1,
    })
    expect(getPage).toHaveBeenCalledTimes(1)
    expect(getPage).toHaveBeenCalledWith({ ...test.scope, pageIndex: 0 })
  })

  it('does not expose staged pages before their manifest is published', async () => {
    const test = fixture()
    const getPage = vi.spyOn(test.resultPageStore, 'getPage')
    const response = await createDurableQueryReadService(test.options).getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      limit: 50,
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'SEMANTIC_NOT_FOUND' } })
    expect(getPage).not.toHaveBeenCalled()
  })

  it('rechecks conversation and business-domain authorization before reading a manifest', async () => {
    const test = fixture()
    publish(test)
    const getManifest = vi.spyOn(test.resultPageStore, 'getManifest')
    const response = await createDurableQueryReadService(test.options).getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor: { ...actor, businessDomainId: 'finance' },
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
    expect(getManifest).not.toHaveBeenCalled()
  })

  it('lists durable events strictly after the numeric sequence cursor', async () => {
    const test = fixture()
    const first: TransactionalQueryRunEvent = {
      schemaVersion: 'query_attempt.v1',
      type: 'query.attempt_retry_scheduled',
      runId: test.record.run.id,
      attempt: 1,
      displayStatus: 'querying',
      semanticVersion: test.record.run.semanticVersion,
      auditTypes: [],
    }
    const second: TransactionalQueryRunEvent = {
      schemaVersion: 'query_attempt.v1',
      type: 'query.attempt_completed',
      runId: test.record.run.id,
      attempt: 2,
      displayStatus: 'completed',
      semanticVersion: test.record.run.semanticVersion,
      auditTypes: ['query.completed'],
    }
    test.runEventStore.append({ ...test.scope, eventId: 'evt_1', expectedSequence: 0, event: first, occurredAt: at })
    test.runEventStore.append({ ...test.scope, eventId: 'evt_2', expectedSequence: 1, event: second, occurredAt: at })

    const response = await createDurableQueryReadService(test.options).getRunEvents({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      afterSequence: '1',
    })

    expect(response).toMatchObject({
      ok: true,
      data: { events: [{ sequence: 2, eventId: 'evt_2', event: second }] },
    })
  })

  it('rejects malformed cursors and hides durable store failures', async () => {
    const test = fixture()
    const service = createDurableQueryReadService(test.options)
    await expect(service.getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      cursor: 'page:1',
    })).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    await expect(service.getRunEvents({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      afterSequence: 'evt_1',
    })).resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })

    const failed = createDurableQueryReadService({
      ...test.options,
      runEventStore: {
        ...test.runEventStore,
        async listAfter() { throw new Error('postgresql://admin:secret@db/chatbi chatbi_run_events') },
      },
    })
    const response = await failed.getRunEvents({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', retryable: true } })
    expect(JSON.stringify(response)).not.toContain('postgresql')
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(JSON.stringify(response)).not.toContain('chatbi_run_events')
  })

  it('serves published result pages and sequence-resumable SSE through ApiRuntime without memory fallback', async () => {
    const test = fixture()
    publish(test)
    const firstEvent: TransactionalQueryRunEvent = {
      schemaVersion: 'query_attempt.v1',
      type: 'query.attempt_retry_scheduled',
      runId: test.record.run.id,
      attempt: 1,
      displayStatus: 'querying',
      semanticVersion: test.record.run.semanticVersion,
      auditTypes: [],
    }
    const secondEvent: TransactionalQueryRunEvent = {
      schemaVersion: 'query_attempt.v1',
      type: 'query.attempt_completed',
      runId: test.record.run.id,
      attempt: 2,
      displayStatus: 'completed',
      semanticVersion: test.record.run.semanticVersion,
      auditTypes: ['result.ready'],
    }
    test.runEventStore.append({ ...test.scope, eventId: 'runtime_evt_1', expectedSequence: 0, event: firstEvent, occurredAt: at })
    test.runEventStore.append({ ...test.scope, eventId: 'runtime_evt_2', expectedSequence: 1, event: secondEvent, occurredAt: at })
    const runtime = createApiRuntime({ environment: 'production' }, {
      queryControlPlane: test.controlPlane,
      resultPageStore: test.resultPageStore,
      runEventStore: test.runEventStore,
    })
    const headers = {
      'x-tenant-id': actor.tenantId,
      'x-workspace-id': actor.workspaceId,
      'x-user-id': actor.userId,
      'x-business-domain-id': actor.businessDomainId,
      'x-semantic-version': actor.semanticVersion,
    }

    await expect(runtime.handleAsync({
      method: 'GET',
      path: `/v1/results/${test.record.run.id}`,
      headers,
      query: { conversation_id: test.conversation.id, cursor: 'offset:1', limit: '1' },
    })).resolves.toMatchObject({
      status: 200,
      body: { ok: true, data: { rows: trendResult.rows.slice(1, 2), page: { nextCursor: 'offset:2' } } },
    })

    const events = await runtime.handleAsync({
      method: 'GET',
      path: `/v1/runs/${test.record.run.id}/events`,
      headers: { ...headers, 'last-event-id': '1' },
      query: { conversation_id: test.conversation.id },
    })
    expect(events).toMatchObject({
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    })
    expect(events.body).toContain('id: 2\nevent: query.attempt_completed')
    expect(events.body).not.toContain('id: 1\n')
    await runtime.close()
  })
})
