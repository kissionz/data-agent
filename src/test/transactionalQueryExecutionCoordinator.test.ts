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
    rows: rows === 0 ? [] : [row],
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

function harness(adapterFactory: (payload: QueryRunJobPayload) => QueryAdapter) {
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
      metadata: { pageSize: 1 },
    })
    expect(commit.resultPublication?.pages[0].checksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(commit.resultPublication?.manifest.manifestChecksum).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(commit.job.type === 'complete' && commit.job.input.resultFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(commit.event.eventId).toMatch(/^evt_query_[a-f0-9]{32}$/)

    const serializedEvent = JSON.stringify(commit.event)
    expect(serializedEvent).not.toContain('SELECT')
    expect(serializedEvent).not.toContain('128000')
    expect(serializedEvent).not.toContain('leaseToken')
    expect(serializedEvent).not.toContain(secret)
    expect(test.directComplete).not.toHaveBeenCalled()
    expect(test.directFail).not.toHaveBeenCalled()
    expect(test.directRetry).not.toHaveBeenCalled()

    const capturedLease = test.getLease()
    if (!capturedLease || commit.job.type !== 'complete') throw new Error('expected completed lease')
    const rebuilt = buildTransactionalQueryAttemptCommit({
      lease: capturedLease,
      outcome: {
        type: 'completed',
        result: commit.job.input.result,
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
