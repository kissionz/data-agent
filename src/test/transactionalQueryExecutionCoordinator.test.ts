import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  buildTransactionalQueryAttemptCommit,
  createTransactionalQueryExecutionCoordinator,
  type TransactionalQueryExecutionControlPlane,
} from '../../apps/api/src/transactionalQueryExecutionCoordinator'
import { prepareQuerySubmission, toQueryRunJobInput, type QueryRunJobPayload, type QueryRunJobPublication } from '../application'
import type { ActorContext, ResultColumn } from '../contracts'
import { attachRun, transitionRun, type Conversation } from '../domain'
import { createInMemoryRunJobQueue } from '../persistence/jobMemory'
import { createInMemoryResultPageStore } from '../persistence/resultMemory'
import type {
  RunJobLease,
  RunJobQueue,
} from '../persistence/jobPorts'
import type { CommitControlPlaneAttemptInput } from '../persistence/controlPlanePorts'
import type { StoredRunRecord } from '../persistence/ports'
import {
  buildImmutableResultBlobKey,
  type ImmutableResultBlob,
  type ImmutableResultBlobStore,
  type PutImmutableResultBlobInput,
  type PutImmutableResultBlobResult,
} from '../persistence/resultBlobPorts'
import type { QueryAdapter, QueryScalar } from '../query'

const at = '2026-07-15T14:00:00.000Z'
const secret = 'postgresql://admin:super-secret@internal-db/private_table'
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

type AttemptCommit = CommitControlPlaneAttemptInput<
  QueryRunJobPublication,
  Parameters<TransactionalQueryExecutionControlPlane['commitAttempt']>[0]['event']['event'],
  NonNullable<Parameters<TransactionalQueryExecutionControlPlane['commitAttempt']>[0]['resultPublication']>['pages'][number]['payload'],
  NonNullable<Parameters<TransactionalQueryExecutionControlPlane['commitAttempt']>[0]['resultPublication']>['manifest']['metadata']
>

function prepare() {
  const submission = prepareQuerySubmission({
    idempotencyKey: 'transactional-worker',
    conversationId: 'conversation_transactional_worker',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
  }, { now: () => at })
  if (!submission.ok || !submission.job) throw new Error('expected querying submission')
  return { submission, job: toQueryRunJobInput(submission.job) }
}

function scalar(column: ResultColumn): QueryScalar {
  if (column.type === 'date') return '2026-06-01T00:00:00.000Z'
  if (column.type === 'boolean') return true
  if (column.type === 'number' || column.type === 'currency' || column.type === 'percentage') return 128_000
  return '华东'
}

function executedOutcome(payload: QueryRunJobPayload, rows = 1) {
  const row = Object.fromEntries(payload.plan.outputColumns.map((column) => [column.id, scalar(column)]))
  return {
    status: 'executed' as const,
    explain: {
      estimatedRows: rows,
      estimatedScanBytes: 1_024,
      costUnits: 1,
      checkedAt: at,
    },
    fields: payload.plan.outputColumns.map((column) => ({ name: column.id, databaseType: 'text' })),
    rows: Array.from({ length: rows }, () => ({ ...row })),
    rowCount: rows,
    truncated: false,
  }
}

function executedAdapter(payload: QueryRunJobPayload, rows = 1): QueryAdapter {
  return {
    dialect: 'postgresql',
    async runReadOnly() {
      return executedOutcome(payload, rows)
    },
  }
}

function failingAdapter(code: string, retryable: boolean): QueryAdapter {
  return {
    dialect: 'postgresql',
    async runReadOnly() {
      throw Object.assign(new Error(secret), { code, retryable })
    },
  }
}

function blockedAdapter(): QueryAdapter {
  return {
    dialect: 'postgresql',
    async runReadOnly() {
      return {
        status: 'blocked',
        reason: 'scan_budget',
        explain: {
          estimatedRows: 50_000,
          estimatedScanBytes: 900_000_000,
          costUnits: 220,
          checkedAt: at,
        },
      }
    },
  }
}

function harness(
  adapterFactory: (payload: QueryRunJobPayload) => QueryAdapter,
  options: {
    resultBlobStore?: ImmutableResultBlobStore
    operationOrder?: string[]
  } = {},
) {
  const { submission, job } = prepare()
  const rawQueue = createInMemoryRunJobQueue<QueryRunJobPayload, QueryRunJobPublication>()
  rawQueue.enqueue(job)
  let stored: StoredRunRecord = structuredClone(submission.record)
  let conversation: Conversation = structuredClone(submission.conversation)
  const initialStored = structuredClone(stored)
  const initialConversation = structuredClone(conversation)
  let lease: RunJobLease<QueryRunJobPayload> | undefined
  const commits: AttemptCommit[] = []
  const directComplete = vi.fn(() => { throw new Error('worker bypassed the atomic control plane') })
  const directFail = vi.fn(() => { throw new Error('worker bypassed the atomic control plane') })
  const directRetry = vi.fn(() => { throw new Error('worker bypassed the atomic control plane') })
  const queue: RunJobQueue<QueryRunJobPayload, QueryRunJobPublication> = {
    ...rawQueue,
    claimNext(input) {
      lease = rawQueue.claimNext(input)
      return lease
    },
    complete: directComplete,
    fail: directFail,
    retry: directRetry,
  }
  const controlPlane: TransactionalQueryExecutionControlPlane = {
    async getConversation(input) {
      return input.tenantId === conversation.tenantId
        && input.workspaceId === conversation.workspaceId
        && input.conversationId === conversation.id
        ? structuredClone(conversation)
        : undefined
    },
    async getRun(input) {
      return input.tenantId === stored.run.tenantId
        && input.workspaceId === stored.run.workspaceId
        && input.runId === stored.run.id
        ? structuredClone(stored)
        : undefined
    },
    async getRunByIdempotency() {
      return { status: 'not_found' }
    },
    async submitAndEnqueue() {
      throw new Error('not used by worker')
    },
    async cancelRun() {
      return { ok: false, reason: 'terminal_conflict' }
    },
    async commitAttempt(input) {
      options.operationOrder?.push('commit')
      commits.push(structuredClone(input))
      const mutation = input.job.type === 'complete'
        ? rawQueue.complete(input.job.input)
        : input.job.type === 'retry'
          ? rawQueue.retry(input.job.input)
          : rawQueue.fail(input.job.input)
      if (mutation.ok && mutation.applied) {
        stored = structuredClone(input.runRecord)
        conversation = structuredClone(input.conversation)
      }
      return mutation
    },
  }
  const runner = createTransactionalQueryExecutionCoordinator({
    adapter: adapterFactory(job.payload),
    queue,
    controlPlane,
    workerId: 'worker_transactional',
    resultPageSize: 1,
    resultBlobStore: options.resultBlobStore,
    now: () => at,
  })
  return {
    runner,
    rawQueue,
    commits,
    directComplete,
    directFail,
    directRetry,
    getLease: () => lease,
    getStored: () => stored,
    getConversation: () => conversation,
    initialStored,
    initialConversation,
    cancel() {
      rawQueue.cancel(job.runId, at)
      stored = { ...stored, run: transitionRun(stored.run, { type: 'CANCELLED', at }) }
      conversation = attachRun(conversation, stored.run)
    },
  }
}

function recordingBlobStore(operationOrder: string[] = []) {
  const objects = new Map<string, ImmutableResultBlob>()
  const calls: PutImmutableResultBlobInput[] = []
  const applied: boolean[] = []
  const store: ImmutableResultBlobStore = {
    put: vi.fn(async (input): Promise<PutImmutableResultBlobResult> => {
      const snapshot = { ...input, body: Uint8Array.from(input.body) }
      calls.push(snapshot)
      operationOrder.push(`put:${calls.length - 1}`)
      const key = buildImmutableResultBlobKey(input)
      const existing = objects.get(key)
      if (existing) {
        applied.push(false)
        return { ok: true, applied: false, blob: existing }
      }
      const blob: ImmutableResultBlob = {
        key,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        attempt: input.attempt,
        kind: input.kind,
        checksum: input.checksum,
        byteLength: input.byteLength,
        contentType: input.contentType,
        etag: `"${input.checksum.slice('sha256:'.length, 'sha256:'.length + 32)}"`,
        cacheControl: 'private, max-age=31536000, immutable',
      }
      objects.set(key, blob)
      applied.push(true)
      return { ok: true, applied: true, blob }
    }),
    stat: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
  }
  return { store, calls, applied }
}

function oneShotBlobStore(
  put: (input: PutImmutableResultBlobInput) => PutImmutableResultBlobResult | Promise<PutImmutableResultBlobResult>,
): ImmutableResultBlobStore {
  return {
    put: vi.fn(put),
    stat: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
  }
}

function canonicalSha256(value: unknown) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex')}`
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]))
  }
  return value
}

describe('transactional query execution coordinator', () => {
  it('commits an executed result, public projection, audit and SHA-256 publication through one boundary', async () => {
    const test = harness(executedAdapter)

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'completed', attempt: 1 })

    expect(test.commits).toHaveLength(1)
    const commit = test.commits[0]
    expect(commit.job.type).toBe('complete')
    expect(commit.runRecord).toMatchObject({ run: { displayStatus: 'completed' }, executedQuery: true })
    expect(commit.conversation.activeRunId).toBeUndefined()
    expect(commit.newAuditEvents.map((event) => event.type)).toEqual(['query.completed', 'result.ready'])
    expect(commit.resultPublication?.pages).toHaveLength(1)
    expect(commit.resultPublication?.pages[0]).toMatchObject({ pageIndex: 0, rowCount: 1, stagedAt: at })
    expect(commit.resultPublication?.manifest).toMatchObject({
      totalRows: 1,
      publishedAt: at,
      metadata: { schemaVersion: 'chatbi_result_manifest.v1', pageSize: 1 },
    })
    expect(commit.resultPublication?.manifest.metadata.pageStorage).toBeUndefined()
    expect(commit.resultPublication?.pages[0].payload).toMatchObject({
      columns: commit.runRecord.run.result?.columns,
      rows: commit.runRecord.run.result?.rows,
    })
    expect(commit.resultPublication?.pages[0].checksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(commit.resultPublication?.manifest.manifestChecksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(commit.job.type === 'complete' && commit.job.input.resultFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(commit.event.eventId).toMatch(/^evt_query_[a-f0-9]{32}$/)
    if (commit.job.type !== 'complete' || !commit.resultPublication) throw new Error('expected completed publication')
    expect(commit.job.input.result).toEqual({
      schemaVersion: 'chatbi_result_manifest_reference.v1',
      type: 'result_manifest',
      resultId: commit.resultPublication.manifest.resultId,
      manifestChecksum: commit.resultPublication.manifest.manifestChecksum,
    })
    const serializedJobResult = JSON.stringify(commit.job.input.result)
    for (const forbidden of ['answer', 'rows', 'columns', 'chartSpec', 'summary', '128000', '华东']) {
      expect(serializedJobResult).not.toContain(forbidden)
    }
    expect(test.rawQueue.getJob(commit.runRecord.run.id)?.result).toEqual(commit.job.input.result)

    const serializedEvent = JSON.stringify(commit.event)
    expect(serializedEvent).not.toContain('SELECT')
    expect(serializedEvent).not.toContain('128000')
    expect(serializedEvent).not.toContain('leaseToken')
    expect(serializedEvent).not.toContain(secret)
    expect(test.directComplete).not.toHaveBeenCalled()
    expect(test.directFail).not.toHaveBeenCalled()
    expect(test.directRetry).not.toHaveBeenCalled()

    const capturedLease = test.getLease()
    if (!capturedLease || !commit.runRecord.run.result || !commit.runRecord.queryExecution) {
      throw new Error('expected completed lease and Run result')
    }
    const rebuilt = buildTransactionalQueryAttemptCommit({
      lease: capturedLease,
      outcome: {
        type: 'completed',
        result: {
          type: 'executed',
          result: commit.runRecord.run.result,
          summary: commit.runRecord.queryExecution,
        },
        resultFingerprint: commit.job.input.resultFingerprint,
        at: commit.job.input.completedAt,
      },
      stored: test.initialStored,
      conversation: test.initialConversation,
      resultPageSize: 1,
    })
    expect(rebuilt.event.eventId).toBe(commit.event.eventId)
    expect(rebuilt.resultPublication?.manifest.manifestChecksum)
      .toBe(commit.resultPublication?.manifest.manifestChecksum)
  })

  it('writes every immutable S3 page before committing only v2 blob references', async () => {
    const operationOrder: string[] = []
    const blobs = recordingBlobStore(operationOrder)
    const test = harness(
      (payload) => executedAdapter(payload, 3),
      { resultBlobStore: blobs.store, operationOrder },
    )

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'completed', attempt: 1 })

    expect(operationOrder).toEqual(['put:0', 'put:1', 'put:2', 'commit'])
    expect(blobs.calls).toHaveLength(3)
    const commit = test.commits[0]
    const publication = commit.resultPublication
    if (!publication) throw new Error('expected S3 result publication')
    expect(publication.manifest).toMatchObject({
      attempt: 1,
      totalRows: 3,
      metadata: {
        schemaVersion: 'chatbi_result_manifest.v2',
        pageSize: 1,
        pageStorage: {
          type: 's3',
          encoding: 'canonical-json',
          contentType: 'application/vnd.insightflow.result-page+json',
        },
      },
    })

    publication.pages.forEach((page, pageIndex) => {
      const write = blobs.calls[pageIndex]
      const decoded = JSON.parse(new TextDecoder().decode(write.body)) as {
        columns: ResultColumn[]
        rows: unknown[]
      }
      const bodyDigest = `sha256:${createHash('sha256').update(write.body).digest('hex')}`
      expect(write).toMatchObject({
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        runId: commit.runRecord.run.id,
        attempt: 1,
        kind: 'page',
        checksum: bodyDigest,
        byteLength: write.body.byteLength,
        contentType: 'application/vnd.insightflow.result-page+json',
      })
      expect(decoded.columns).toEqual(commit.runRecord.run.result?.columns)
      expect(decoded.rows).toHaveLength(1)
      expect(page.checksum).toBe(canonicalSha256({
        runId: commit.runRecord.run.id,
        attempt: 1,
        pageIndex,
        payload: decoded,
      }))
      expect(page.payload).toEqual({
        schemaVersion: 'chatbi_result_page_blob_reference.v1',
        storage: 's3',
        blob: expect.objectContaining({
          key: buildImmutableResultBlobKey(write),
          checksum: bodyDigest,
          byteLength: write.body.byteLength,
        }),
      })
      const serializedReference = JSON.stringify(page.payload)
      for (const forbidden of ['"rows"', '"columns"', '"answer"', '"facts"']) {
        expect(serializedReference).not.toContain(forbidden)
      }
    })
    expect(publication.manifest.pageChecksums).toEqual(
      publication.pages.map((page) => page.checksum),
    )
    expect(commit.job).toMatchObject({
      type: 'complete',
      input: {
        result: {
          schemaVersion: 'chatbi_result_manifest_reference.v1',
          type: 'result_manifest',
          resultId: publication.manifest.resultId,
          manifestChecksum: publication.manifest.manifestChecksum,
        },
      },
    })
  })

  it('accepts an idempotent repeated-attempt blob PUT without changing the manifest', async () => {
    let repeatedInput: PutImmutableResultBlobInput | undefined
    const store = oneShotBlobStore(async (input) => {
      repeatedInput = input
      return {
        ok: true,
        applied: false,
        blob: {
          key: buildImmutableResultBlobKey(input),
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          attempt: input.attempt,
          kind: input.kind,
          checksum: input.checksum,
          byteLength: input.byteLength,
          contentType: input.contentType,
          etag: `"${input.checksum.slice('sha256:'.length, 'sha256:'.length + 32)}"`,
          cacheControl: 'private, max-age=31536000, immutable',
        },
      }
    })
    const test = harness(executedAdapter, { resultBlobStore: store })

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'completed', attempt: 1 })

    expect(store.put).toHaveBeenCalledTimes(1)
    expect(repeatedInput).toMatchObject({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      attempt: 1,
      kind: 'page',
    })
    expect(test.commits).toHaveLength(1)
    expect(test.commits[0].job.type).toBe('complete')
    expect(test.commits[0].resultPublication?.pages[0].payload).toMatchObject({
      schemaVersion: 'chatbi_result_page_blob_reference.v1',
      storage: 's3',
      blob: {
        key: repeatedInput ? buildImmutableResultBlobKey(repeatedInput) : '',
        checksum: repeatedInput?.checksum,
      },
    })
  })

  it('schedules a retry without publishing a DB result when S3 is unavailable', async () => {
    const remoteSecret = 'https://access:secret@objects.internal/private'
    const store = oneShotBlobStore(async () => {
      throw Object.assign(new Error(remoteSecret), {
        code: 'REMOTE_UNAVAILABLE',
        retryable: true,
      })
    })
    const test = harness(executedAdapter, { resultBlobStore: store })

    await expect(test.runner.runOnce()).resolves.toMatchObject({
      status: 'retry_scheduled',
      attempt: 1,
    })

    expect(store.put).toHaveBeenCalledTimes(1)
    expect(test.commits).toHaveLength(1)
    expect(test.commits[0]).toMatchObject({
      job: {
        type: 'retry',
        input: {
          failure: { code: 'RESULT_STORAGE_UNAVAILABLE', retryable: true },
        },
      },
      runRecord: { run: { displayStatus: 'querying' } },
    })
    expect(test.commits[0].resultPublication).toBeUndefined()
    expect(test.rawQueue.getJob(test.commits[0].runRecord.run.id)?.result).toBeUndefined()
    expect(JSON.stringify(test.commits[0])).not.toContain(remoteSecret)
  })

  it('fails closed without a result publication on immutable blob content conflict', async () => {
    const store = oneShotBlobStore(async () => ({
      ok: false,
      reason: 'content_conflict',
    }))
    const test = harness(executedAdapter, { resultBlobStore: store })

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'failed', attempt: 1 })

    expect(test.commits[0]).toMatchObject({
      job: {
        type: 'fail',
        input: {
          failure: { code: 'RESULT_STORAGE_REJECTED', retryable: false },
        },
      },
      runRecord: { run: { displayStatus: 'failed' } },
    })
    expect(test.commits[0].resultPublication).toBeUndefined()
    expect(test.rawQueue.getJob(test.commits[0].runRecord.run.id)?.result).toBeUndefined()
  })

  it('fails closed when a successful blob write returns mismatched integrity metadata', async () => {
    const store = oneShotBlobStore(async (input) => ({
      ok: true,
      applied: true,
      blob: {
        key: buildImmutableResultBlobKey(input),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        attempt: input.attempt,
        kind: input.kind,
        checksum: `sha256:${'0'.repeat(64)}`,
        byteLength: input.byteLength,
        contentType: input.contentType,
        etag: '"untrusted"',
        cacheControl: 'private, max-age=31536000, immutable',
      },
    }))
    const test = harness(executedAdapter, { resultBlobStore: store })

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'failed', attempt: 1 })

    expect(test.commits[0]).toMatchObject({
      job: {
        type: 'fail',
        input: {
          failure: { code: 'RESULT_STORAGE_REJECTED', retryable: false },
        },
      },
    })
    expect(test.commits[0].resultPublication).toBeUndefined()
    expect(JSON.stringify(test.commits[0])).not.toContain('0000000000000000')
  })

  it('atomically schedules retry with only a safe failure code in the event', async () => {
    const test = harness(() => failingAdapter('QUERY_UNAVAILABLE', true))

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'retry_scheduled', attempt: 1 })

    const commit = test.commits[0]
    expect(commit.job.type).toBe('retry')
    expect(commit.runRecord.run.displayStatus).toBe('querying')
    expect(commit.conversation.activeRunId).toBe(commit.runRecord.run.id)
    expect(commit.newAuditEvents).toEqual([])
    expect(commit.resultPublication).toBeUndefined()
    expect(commit.event.event).toMatchObject({
      type: 'query.attempt_retry_scheduled',
      failure: { code: 'QUERY_UNAVAILABLE', retryable: true },
    })
    expect(JSON.stringify(commit)).not.toContain(secret)
    expect(test.rawQueue.getJob(commit.runRecord.run.id)?.status).toBe('retry_wait')
  })

  it('stores only a versioned no-result marker when the budget gate blocks execution', async () => {
    const test = harness(() => blockedAdapter())

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'completed', attempt: 1 })

    const commit = test.commits[0]
    expect(commit.job).toMatchObject({
      type: 'complete',
      input: {
        result: {
          schemaVersion: 'chatbi_no_result_reference.v1',
          type: 'no_result',
          reasonCode: 'QUERY_TOO_EXPENSIVE',
        },
      },
    })
    expect(commit.runRecord).toMatchObject({
      run: { displayStatus: 'failed', error: { code: 'QUERY_TOO_EXPENSIVE' } },
      queryExecution: { status: 'blocked' },
    })
    expect(commit.resultPublication).toBeUndefined()
    const serialized = JSON.stringify(commit.job.type === 'complete' ? commit.job.input.result : {})
    expect(serialized).not.toContain('scan_budget')
    expect(serialized).not.toContain('summary')
    expect(serialized).not.toContain('reason:')
  })

  it('atomically fails the Run without leaking an adapter error or credentials', async () => {
    const test = harness(() => failingAdapter('DATABASE_INTERNAL', false))

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'failed', attempt: 1 })

    const commit = test.commits[0]
    expect(commit.job.type).toBe('fail')
    expect(commit.runRecord).toMatchObject({
      run: { displayStatus: 'failed', error: { code: 'INTERNAL_ERROR' } },
      executedQuery: false,
    })
    expect(commit.conversation.activeRunId).toBeUndefined()
    expect(commit.resultPublication).toBeUndefined()
    expect(commit.event.event).toMatchObject({
      type: 'query.attempt_failed',
      failure: { code: 'QUERY_EXECUTION_FAILED', retryable: false },
    })
    expect(JSON.stringify(commit)).not.toContain(secret)
    expect(JSON.stringify(commit)).not.toContain('super-secret')
    expect(test.rawQueue.getJob(commit.runRecord.run.id)?.status).toBe('failed')
  })

  it('returns cancelled instead of throwing when cancellation wins after execution started', async () => {
    let resolveAdapter!: (value: ReturnType<typeof executedOutcome>) => void
    let payload!: QueryRunJobPayload
    const test = harness((capturedPayload) => {
      payload = capturedPayload
      return {
        dialect: 'postgresql',
        runReadOnly: () => new Promise((resolve) => { resolveAdapter = resolve }),
      }
    })

    const cycle = test.runner.runOnce()
    await vi.waitFor(() => {
      expect(test.getLease()).toBeDefined()
      expect(resolveAdapter).toBeTypeOf('function')
    })
    test.cancel()
    resolveAdapter(executedOutcome(payload))

    await expect(cycle).resolves.toMatchObject({ status: 'cancelled', attempt: 1 })
    expect(test.commits).toHaveLength(0)
    expect(test.rawQueue.getJob(payload.runId)?.status).toBe('cancelled')
  })

  it('publishes an empty result as a zero-page manifest with no readable page zero', async () => {
    const test = harness((payload) => executedAdapter(payload, 0))

    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'completed' })

    const publication = test.commits[0].resultPublication
    if (!publication) throw new Error('expected result publication')
    expect(publication.pages).toEqual([])
    expect(publication.manifest).toMatchObject({
      pageChecksums: [],
      totalRows: 0,
      metadata: { pageSize: 1 },
    })

    const store = createInMemoryResultPageStore()
    expect(store.publishManifest(publication.manifest)).toMatchObject({ ok: true, applied: true })
    expect(store.getManifest(publication.manifest)).toMatchObject({ pageCount: 0, totalRows: 0 })
    expect(store.getPage({ ...publication.manifest, pageIndex: 0 })).toBeUndefined()
  })
})
