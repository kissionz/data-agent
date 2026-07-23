import { createHash } from 'node:crypto'
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

function sha256(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(stableValue(value)), 'utf8').digest('hex')}`
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]))
  }
  return value
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
  const checksums = pages.map((payload, pageIndex) => sha256({
    runId: record.run.id,
    attempt: 1,
    pageIndex,
    payload,
  }))
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
  const manifestIdentity = {
    runId: test.record.run.id,
    attempt: 1,
    resultId: trendResult.id,
    pageChecksums: test.checksums,
    totalRows: trendResult.rows.length,
    metadata: test.metadata,
  }
  return test.resultPageStore.publishManifest({
    ...test.scope,
    attempt: 1,
    resultId: trendResult.id,
    manifestChecksum: sha256(manifestIdentity),
    pageChecksums: test.checksums,
    totalRows: trendResult.rows.length,
    metadata: test.metadata,
    publishedAt: at,
  })
}

async function ndjsonRecords(body: AsyncIterable<string>) {
  let text = ''
  for await (const chunk of body) text += chunk
  return {
    text,
    records: text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
  }
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
    expect(getPage).toHaveBeenCalledWith(expect.objectContaining({ ...test.scope, pageIndex: 0 }))
  })

  it('streams a verified published result as lazy NDJSON through an authorized resolver', async () => {
    const test = fixture()
    expect(publish(test)).toMatchObject({ ok: true })
    const resolve = vi.fn(async (input) => await test.resultPageStore.getPage(input))
    const service = createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: { resolve },
    })

    const opened = await service.openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
    })
    expect(opened).toMatchObject({
      ok: true,
      data: {
        schemaVersion: 'chatbi_result_stream.v1',
        runId: test.record.run.id,
        resultId: trendResult.id,
        totalRows: trendResult.rows.length,
      },
    })
    if (!opened.ok) throw new Error('expected stream')
    expect(resolve).not.toHaveBeenCalled()

    const iterator = opened.data.body[Symbol.asyncIterator]()
    const manifestLine = await iterator.next()
    expect(JSON.parse(String(manifestLine.value))).toMatchObject({
      type: 'manifest',
      schemaVersion: 'chatbi_result_stream.v1',
      attempt: 1,
      totalRows: trendResult.rows.length,
    })
    expect(resolve).not.toHaveBeenCalled()
    const firstRowLine = await iterator.next()
    expect(JSON.parse(String(firstRowLine.value))).toMatchObject({
      type: 'row',
      index: 0,
      row: trendResult.rows[0],
    })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      ...test.scope,
      pageIndex: 0,
      manifest: expect.objectContaining({ resultId: trendResult.id }),
      signal: expect.any(AbortSignal),
      timeoutMs: expect.any(Number),
    }))

    const remaining: string[] = []
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      remaining.push(next.value)
    }
    const records = remaining.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(records.filter((record) => record.type === 'row')).toHaveLength(trendResult.rows.length - 1)
    expect(records.at(-1)).toMatchObject({ type: 'complete', rowCount: trendResult.rows.length })
    expect(resolve).toHaveBeenCalledTimes(test.checksums.length)
  })

  it('accepts a v2 S3 manifest only when its storage contract is complete', async () => {
    const test = fixture()
    test.metadata.schemaVersion = 'chatbi_result_manifest.v2'
    test.metadata.pageStorage = {
      type: 's3',
      encoding: 'canonical-json',
      contentType: 'application/vnd.insightflow.result-page+json',
    }
    expect(publish(test)).toMatchObject({ ok: true })
    const resolve = vi.fn(async (input) => await test.resultPageStore.getPage(input))
    const response = await createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: { resolve },
    }).getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      limit: 1,
    })

    expect(response).toMatchObject({ ok: true, data: { rows: trendResult.rows.slice(0, 1) } })
    expect(resolve).toHaveBeenCalledOnce()
  })

  it.each([
    ['v2 without pageStorage', (metadata: TransactionalResultManifestMetadata) => {
      metadata.schemaVersion = 'chatbi_result_manifest.v2'
      metadata.pageStorage = undefined
    }],
    ['v2 with inline storage', (metadata: TransactionalResultManifestMetadata) => {
      metadata.schemaVersion = 'chatbi_result_manifest.v2'
      metadata.pageStorage = {
        type: 'inline',
        encoding: 'canonical-json',
        contentType: 'application/vnd.insightflow.result-page+json',
      }
    }],
    ['v1 with external storage', (metadata: TransactionalResultManifestMetadata) => {
      metadata.schemaVersion = 'chatbi_result_manifest.v1'
      metadata.pageStorage = {
        type: 's3',
        encoding: 'canonical-json',
        contentType: 'application/vnd.insightflow.result-page+json',
      }
    }],
  ])('rejects %s before resolving a page', async (_label, mutateMetadata) => {
    const test = fixture()
    mutateMetadata(test.metadata)
    expect(publish(test)).toMatchObject({ ok: true })
    const resolve = vi.fn()
    const response = await createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: { resolve },
    }).getResultPage({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      limit: 1,
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('never resolves a payload before publication and scope authorization', async () => {
    const unpublished = fixture()
    const resolveUnpublished = vi.fn()
    const unpublishedResponse = await createDurableQueryReadService({
      ...unpublished.options,
      publishedPageResolver: { resolve: resolveUnpublished },
    }).openResultStream({
      runId: unpublished.record.run.id,
      conversationId: unpublished.conversation.id,
      actor,
    })
    expect(unpublishedResponse).toMatchObject({ ok: false, error: { code: 'SEMANTIC_NOT_FOUND' } })
    expect(resolveUnpublished).not.toHaveBeenCalled()

    const scoped = fixture()
    publish(scoped)
    const resolveScoped = vi.fn()
    const crossScope = await createDurableQueryReadService({
      ...scoped.options,
      publishedPageResolver: { resolve: resolveScoped },
    }).openResultStream({
      runId: scoped.record.run.id,
      conversationId: scoped.conversation.id,
      actor: { ...actor, tenantId: 'tenant_other' },
    })
    expect(crossScope).toMatchObject({ ok: false, error: { code: 'SEMANTIC_NOT_FOUND' } })
    expect(resolveScoped).not.toHaveBeenCalled()
  })

  it('enforces row and byte budgets without exposing internal failures', async () => {
    const test = fixture()
    test.metadata.warnings = ['budget-fixture-'.repeat(200)]
    publish(test)
    const resolve = vi.fn(async (input) => await test.resultPageStore.getPage(input))
    const service = createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: { resolve },
    })
    await expect(service.openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      maxRows: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'QUERY_TOO_EXPENSIVE' } })
    expect(resolve).not.toHaveBeenCalled()

    const byteLimited = await service.openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      maxBytes: 1_024,
    })
    if (!byteLimited.ok) throw new Error('expected byte-limited stream')
    const streamed = await ndjsonRecords(byteLimited.data.body)
    expect(new TextEncoder().encode(streamed.text).byteLength).toBeLessThanOrEqual(1_024)
    expect(streamed.records.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'RESULT_STREAM_BYTE_BUDGET_EXCEEDED' },
    })

    const leaking = createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: {
        async resolve() {
          throw new Error('postgresql://admin:secret@private-db/chatbi result_pages')
        },
      },
    })
    const opened = await leaking.openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
    })
    if (!opened.ok) throw new Error('expected stream')
    const failed = await ndjsonRecords(opened.data.body)
    expect(failed.records.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'RESULT_STREAM_UNAVAILABLE' },
    })
    expect(failed.text).not.toMatch(/postgresql|admin|secret|private-db|result_pages/i)
  })

  it.each([
    ['checksum', (page: NonNullable<ReturnType<ReturnType<typeof fixture>['resultPageStore']['getPage']>>) => ({
      ...page,
      checksum: `sha256:${'0'.repeat(64)}`,
    })],
    ['attempt', (page: NonNullable<ReturnType<ReturnType<typeof fixture>['resultPageStore']['getPage']>>) => ({
      ...page,
      attempt: page.attempt + 1,
    })],
    ['schema', (page: NonNullable<ReturnType<ReturnType<typeof fixture>['resultPageStore']['getPage']>>) => ({
      ...page,
      payload: { ...page.payload, columns: [] },
    })],
  ] as const)('terminates before rows when a published page has a bad %s', async (_name, corrupt) => {
    const test = fixture()
    publish(test)
    const opened = await createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: {
        resolve(input) {
          const page = test.resultPageStore.getPage(input)
          return page ? corrupt(page) : undefined
        },
      },
    }).openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
    })
    if (!opened.ok) throw new Error('expected stream')
    const streamed = await ndjsonRecords(opened.data.body)
    expect(streamed.records.filter((record) => record.type === 'row')).toHaveLength(0)
    expect(streamed.records.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'RESULT_STREAM_INTEGRITY_FAILED', retryable: false },
    })
  })

  it('propagates disconnect and total timeout cancellation into page resolution', async () => {
    const test = fixture()
    publish(test)
    const signals: AbortSignal[] = []
    const timeouts: number[] = []
    const blockingResolver = {
      resolve(input: { signal?: AbortSignal; timeoutMs?: number }) {
        if (input.signal) signals.push(input.signal)
        if (input.timeoutMs) timeouts.push(input.timeoutMs)
        return new Promise<never>((_resolve, reject) => {
          const abort = () => reject(Object.assign(new Error('private storage wait'), { name: 'AbortError' }))
          input.signal?.addEventListener('abort', abort, { once: true })
          if (input.signal?.aborted) abort()
        })
      },
    }

    const controller = new AbortController()
    const disconnected = await createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: blockingResolver,
    }).openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      signal: controller.signal,
      timeoutMs: 1_000,
    })
    if (!disconnected.ok) throw new Error('expected stream')
    const disconnectedIterator = disconnected.data.body[Symbol.asyncIterator]()
    await disconnectedIterator.next()
    const pending = disconnectedIterator.next()
    controller.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(signals[0]?.aborted).toBe(true)

    const timed = await createDurableQueryReadService({
      ...test.options,
      publishedPageResolver: blockingResolver,
    }).openResultStream({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      timeoutMs: 100,
    })
    if (!timed.ok) throw new Error('expected stream')
    const timedResult = await ndjsonRecords(timed.data.body)
    expect(timedResult.records.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'RESULT_STREAM_TIMEOUT' },
    })
    expect(signals.at(-1)?.aborted).toBe(true)
    expect(timeouts.at(-1)).toBeLessThanOrEqual(100)
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
    await expect(service.getRunEvents({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      limit: 1001,
      waitMs: 25_001,
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

    const controller = new AbortController()
    const waiting = createDurableQueryReadService({ ...test.options, eventPollIntervalMs: 5 }).getRunEvents({
      runId: test.record.run.id,
      conversationId: test.conversation.id,
      actor,
      waitMs: 1000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(waiting).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUN_CANCELLED', debugReference: `event_stream_aborted_${test.record.run.id}` },
    })
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

    const streamPageRead = vi.spyOn(test.resultPageStore, 'getPage')
    await expect(runtime.handleAsync({
      method: 'GET',
      path: `/v1/results/${test.record.run.id}/stream`,
      query: { conversation_id: test.conversation.id },
    })).resolves.toMatchObject({ status: 401 })
    expect(streamPageRead).not.toHaveBeenCalled()

    await expect(runtime.handleAsync({
      method: 'GET',
      path: `/v1/results/${test.record.run.id}`,
      headers,
      query: { conversation_id: test.conversation.id, cursor: 'offset:1', limit: '1' },
    })).resolves.toMatchObject({
      status: 200,
      body: { ok: true, data: { rows: trendResult.rows.slice(1, 2), page: { nextCursor: 'offset:2' } } },
    })

    const resultStream = await runtime.handleAsync({
      method: 'GET',
      path: `/v1/results/${test.record.run.id}/stream`,
      headers,
      query: { conversation_id: test.conversation.id },
    })
    expect(resultStream).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'x-stream-mode': 'published-result',
        'x-result-total-rows': String(trendResult.rows.length),
      },
    })
    const resultStreamBody = await ndjsonRecords(resultStream.body as AsyncIterable<string>)
    expect(resultStreamBody.records.filter((record) => record.type === 'row').map((record) => record.row))
      .toEqual(trendResult.rows)
    expect(resultStreamBody.records.at(-1)).toMatchObject({ type: 'complete' })

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

    const heartbeat = await runtime.handleAsync({
      method: 'GET',
      path: `/v1/runs/${test.record.run.id}/events`,
      headers: { ...headers, 'last-event-id': '2' },
      query: { conversation_id: test.conversation.id, wait_ms: '0', limit: '10' },
    })
    expect(heartbeat).toMatchObject({
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'x-stream-mode': 'finite-long-poll',
        'x-event-sequence': '2',
      },
    })
    expect(heartbeat.body).toBe('retry: 1000\n: heartbeat\n\n')
    await runtime.close()
  })
})
