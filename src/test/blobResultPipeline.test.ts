import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createBlobBackedResultPageResolver } from '../../apps/api/src/adapters/blobBackedResultPageResolver'
import { createDurableQueryReadService } from '../../apps/api/src/durableQueryReadService'
import {
  createTransactionalQueryExecutionCoordinator,
  type TransactionalQueryExecutionControlPlane,
  type TransactionalQueryRunEvent,
  type TransactionalResultManifestMetadata,
  type TransactionalStoredResultPage,
} from '../../apps/api/src/transactionalQueryExecutionCoordinator'
import {
  prepareQuerySubmission,
  toQueryRunJobInput,
  type QueryRunJobPayload,
  type QueryRunJobPublication,
} from '../application'
import type { ActorContext, ResultColumn } from '../contracts'
import type { Conversation } from '../domain'
import type { CommitControlPlaneAttemptInput } from '../persistence/controlPlanePorts'
import { createInMemoryRunJobQueue } from '../persistence/jobMemory'
import type { StoredRunRecord } from '../persistence/ports'
import {
  buildImmutableResultBlobKey,
  type GetImmutableResultBlobInput,
  type ImmutableResultBlob,
  type ImmutableResultBlobStore,
  type PutImmutableResultBlobInput,
} from '../persistence/resultBlobPorts'
import { createInMemoryResultPageStore, createInMemoryRunEventStore } from '../persistence/resultMemory'
import type { QueryAdapter, QueryScalar } from '../query'

const at = '2026-07-23T12:00:00.000Z'
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
  TransactionalQueryRunEvent,
  TransactionalStoredResultPage,
  TransactionalResultManifestMetadata
>

function prepare() {
  const submission = prepareQuerySubmission({
    idempotencyKey: 'blob-result-pipeline',
    conversationId: 'conversation_blob_result_pipeline',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
  }, { now: () => at })
  if (!submission.ok || !submission.job) throw new Error('expected querying submission')
  return { submission, job: toQueryRunJobInput(submission.job) }
}

function scalar(column: ResultColumn, rowIndex: number): QueryScalar {
  if (column.type === 'date') return `2026-${String(rowIndex + 1).padStart(2, '0')}-01T00:00:00.000Z`
  if (column.type === 'boolean') return rowIndex % 2 === 0
  if (column.type === 'number' || column.type === 'currency' || column.type === 'percentage') {
    return 128_000 + rowIndex
  }
  return `华东-${rowIndex + 1}`
}

function executedAdapter(payload: QueryRunJobPayload, rowCount = 3): QueryAdapter {
  return {
    dialect: 'postgresql',
    async runReadOnly() {
      return {
        status: 'executed',
        explain: {
          estimatedRows: rowCount,
          estimatedScanBytes: 1_024,
          costUnits: 1,
          checkedAt: at,
        },
        fields: payload.plan.outputColumns.map((column) => ({
          name: column.id,
          databaseType: 'text',
        })),
        rows: Array.from({ length: rowCount }, (_, rowIndex) => Object.fromEntries(
          payload.plan.outputColumns.map((column) => [column.id, scalar(column, rowIndex)]),
        )),
        rowCount,
        truncated: false,
      }
    },
  }
}

function createFakeImmutableBlobStore() {
  const objects = new Map<string, { blob: ImmutableResultBlob; body: Uint8Array }>()
  const putResults: Array<{ key: string; applied: boolean }> = []
  const getInputs: GetImmutableResultBlobInput[] = []
  const store: ImmutableResultBlobStore = {
    put: vi.fn(async (input: PutImmutableResultBlobInput) => {
      const key = buildImmutableResultBlobKey(input)
      const existing = objects.get(key)
      if (existing) {
        const same = descriptorMatches(existing.blob, input)
          && Buffer.from(existing.body).equals(Buffer.from(input.body))
        if (!same) return { ok: false as const, reason: 'content_conflict' as const }
        putResults.push({ key, applied: false })
        return { ok: true as const, applied: false, blob: structuredClone(existing.blob) }
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
        etag: `"${createHash('sha256').update(input.body).digest('hex')}"`,
        cacheControl: 'private, max-age=31536000, immutable',
      }
      objects.set(key, { blob, body: Uint8Array.from(input.body) })
      putResults.push({ key, applied: true })
      return { ok: true as const, applied: true, blob: structuredClone(blob) }
    }),
    stat: vi.fn(async (input: GetImmutableResultBlobInput) => {
      const stored = objects.get(buildImmutableResultBlobKey(input))
      return stored && descriptorMatches(stored.blob, input)
        ? structuredClone(stored.blob)
        : undefined
    }),
    get: vi.fn(async (input: GetImmutableResultBlobInput) => {
      getInputs.push({ ...input })
      const stored = objects.get(buildImmutableResultBlobKey(input))
      return stored && descriptorMatches(stored.blob, input)
        ? { blob: { ...stored.blob }, body: Uint8Array.from(stored.body) }
        : undefined
    }),
  }
  return { store, objects, putResults, getInputs }
}

function descriptorMatches(
  blob: ImmutableResultBlob,
  input: GetImmutableResultBlobInput | PutImmutableResultBlobInput,
) {
  return blob.tenantId === input.tenantId
    && blob.workspaceId === input.workspaceId
    && blob.runId === input.runId
    && blob.attempt === input.attempt
    && blob.kind === input.kind
    && blob.checksum === input.checksum
    && blob.byteLength === input.byteLength
    && blob.contentType === input.contentType
}

function createPipeline(options: {
  blobStore: ImmutableResultBlobStore
  failCommit?: boolean
  prepared?: ReturnType<typeof prepare>
}) {
  const prepared = options.prepared ?? prepare()
  const { submission, job } = prepared
  const queue = createInMemoryRunJobQueue<QueryRunJobPayload, QueryRunJobPublication>()
  queue.enqueue(job)
  const resultPageStore = createInMemoryResultPageStore<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >()
  const runEventStore = createInMemoryRunEventStore<TransactionalQueryRunEvent>()
  let stored: StoredRunRecord = structuredClone(submission.record)
  let conversation: Conversation = structuredClone(submission.conversation)
  const commits: AttemptCommit[] = []
  const prePublishVisibility: Array<{ manifest: boolean; page: boolean }> = []

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
      return { ok: false, reason: 'run_identity_conflict' }
    },
    async cancelRun() {
      return { ok: false, reason: 'terminal_conflict' }
    },
    async commitAttempt(input) {
      commits.push(structuredClone(input))
      const publication = input.resultPublication
      if (publication) {
        for (const page of publication.pages) {
          const staged = resultPageStore.stagePage(page)
          if (!staged.ok) throw new Error(`unexpected page stage conflict: ${staged.reason}`)
        }
        prePublishVisibility.push({
          manifest: Boolean(resultPageStore.getManifest({
            tenantId: input.runRecord.run.tenantId,
            workspaceId: input.runRecord.run.workspaceId,
            runId: input.runRecord.run.id,
          })),
          page: Boolean(resultPageStore.getPage({
            tenantId: input.runRecord.run.tenantId,
            workspaceId: input.runRecord.run.workspaceId,
            runId: input.runRecord.run.id,
            pageIndex: 0,
          })),
        })
      }
      if (options.failCommit) throw new Error('injected commitAttempt transaction failure')

      const mutation = input.job.type === 'complete'
        ? queue.complete(input.job.input)
        : input.job.type === 'retry'
          ? queue.retry(input.job.input)
          : queue.fail(input.job.input)
      if (!mutation.ok) return mutation
      if (publication) {
        const published = resultPageStore.publishManifest(publication.manifest)
        if (!published.ok) throw new Error(`unexpected manifest conflict: ${published.reason}`)
      }
      const event = runEventStore.append({
        tenantId: input.runRecord.run.tenantId,
        workspaceId: input.runRecord.run.workspaceId,
        runId: input.runRecord.run.id,
        eventId: input.event.eventId,
        expectedSequence: runEventStore.currentSequence({
          tenantId: input.runRecord.run.tenantId,
          workspaceId: input.runRecord.run.workspaceId,
          runId: input.runRecord.run.id,
        }),
        event: input.event.event,
        occurredAt: input.event.occurredAt,
      })
      if (!event.ok) throw new Error(`unexpected event conflict: ${event.reason}`)
      stored = structuredClone(input.runRecord)
      conversation = structuredClone(input.conversation)
      return mutation
    },
  }
  const runner = createTransactionalQueryExecutionCoordinator({
    adapter: executedAdapter(job.payload),
    queue,
    controlPlane,
    workerId: 'worker_blob_pipeline',
    resultPageSize: 2,
    resultBlobStore: options.blobStore,
    now: () => at,
  })
  const resolver = createBlobBackedResultPageResolver({
    resultPageStore,
    blobStore: options.blobStore,
  })
  const readService = createDurableQueryReadService({
    controlPlane,
    resultPageStore,
    publishedPageResolver: resolver,
    runEventStore,
  })
  return {
    runner,
    queue,
    resultPageStore,
    runEventStore,
    controlPlane,
    resolver,
    readService,
    commits,
    prePublishVisibility,
    submission,
    prepared,
    getStored: () => structuredClone(stored),
  }
}

async function readNdjson(body: AsyncIterable<string>) {
  const records: Array<Record<string, unknown>> = []
  for await (const chunk of body) {
    for (const line of chunk.trim().split('\n').filter(Boolean)) {
      records.push(JSON.parse(line) as Record<string, unknown>)
    }
  }
  return records
}

describe('blob result pipeline composition', () => {
  it('publishes only DB references and reads identical rows through paging and NDJSON', async () => {
    const blobs = createFakeImmutableBlobStore()
    const test = createPipeline({ blobStore: blobs.store })
    const scope = {
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      runId: test.submission.record.run.id,
    }

    expect(test.resultPageStore.getManifest(scope)).toBeUndefined()
    expect(test.resultPageStore.getPage({ ...scope, pageIndex: 0 })).toBeUndefined()
    await expect(test.runner.runOnce()).resolves.toMatchObject({ status: 'completed', attempt: 1 })

    expect(test.prePublishVisibility).toEqual([{ manifest: false, page: false }])
    const manifest = test.resultPageStore.getManifest(scope)
    expect(manifest).toMatchObject({
      pageCount: 2,
      totalRows: 3,
      metadata: {
        schemaVersion: 'chatbi_result_manifest.v2',
        pageStorage: { type: 's3' },
      },
    })
    const publishedPage = test.resultPageStore.getPage({ ...scope, pageIndex: 0 })
    expect(publishedPage?.payload).toMatchObject({
      schemaVersion: 'chatbi_result_page_blob_reference.v1',
      storage: 's3',
    })
    expect(JSON.stringify(publishedPage?.payload)).not.toMatch(/"rows"|"columns"/)
    const blobReference = publishedPage?.payload && 'blob' in publishedPage.payload
      ? publishedPage.payload.blob
      : undefined
    const storedBlob = blobReference ? blobs.objects.get(blobReference.key) : undefined
    expect(storedBlob?.blob).toEqual(blobReference)
    expect(storedBlob?.body).toBeInstanceOf(Uint8Array)
    expect(storedBlob?.body.byteLength).toBe(blobReference?.byteLength)

    const expectedRows = test.getStored().run.result?.rows
    if (!expectedRows) throw new Error('expected committed result rows')
    const paged = await test.readService.getResultPage({
      runId: scope.runId,
      conversationId: test.submission.conversation.id,
      actor,
      cursor: 'offset:1',
      limit: 2,
    })
    expect(paged).toMatchObject({
      ok: true,
      data: { rows: expectedRows.slice(1, 3) },
    })

    const opened = await test.readService.openResultStream({
      runId: scope.runId,
      conversationId: test.submission.conversation.id,
      actor,
    })
    if (!opened.ok) throw new Error('expected published result stream')
    const records = await readNdjson(opened.data.body)
    expect(records.filter((record) => record.type === 'row').map((record) => record.row))
      .toEqual(expectedRows)
    expect(records.at(-1)).toMatchObject({ type: 'complete', rowCount: expectedRows.length })

    const blobGetsBeforeCrossScope = blobs.getInputs.length
    await expect(test.readService.getResultPage({
      runId: scope.runId,
      conversationId: test.submission.conversation.id,
      actor: { ...actor, tenantId: 'tenant_other' },
      limit: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'SEMANTIC_NOT_FOUND' } })
    expect(blobs.getInputs).toHaveLength(blobGetsBeforeCrossScope)
  })

  it('leaves safe blob orphans after commit failure and reuses identical content idempotently', async () => {
    const blobs = createFakeImmutableBlobStore()
    const failed = createPipeline({ blobStore: blobs.store, failCommit: true })
    const scope = {
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      runId: failed.submission.record.run.id,
    }

    await expect(failed.runner.runOnce()).rejects.toMatchObject({
      code: 'RUN_WORKER_COMMIT_FAILED',
    })
    expect(blobs.objects.size).toBe(2)
    expect(blobs.putResults.map((result) => result.applied)).toEqual([true, true])
    expect(failed.prePublishVisibility).toEqual([{ manifest: false, page: false }])
    expect(failed.resultPageStore.getManifest(scope)).toBeUndefined()
    expect(failed.resultPageStore.getPage({ ...scope, pageIndex: 0 })).toBeUndefined()

    const getsBeforeRead = blobs.getInputs.length
    await expect(failed.readService.getResultPage({
      runId: scope.runId,
      conversationId: failed.submission.conversation.id,
      actor,
      limit: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: 'SEMANTIC_NOT_FOUND' } })
    expect(blobs.getInputs).toHaveLength(getsBeforeRead)

    const replayed = createPipeline({ blobStore: blobs.store, prepared: failed.prepared })
    expect(replayed.submission.record.run.id).toBe(scope.runId)
    await expect(replayed.runner.runOnce()).resolves.toMatchObject({ status: 'completed', attempt: 1 })
    expect(blobs.objects.size).toBe(2)
    expect(blobs.putResults.map((result) => result.applied))
      .toEqual([true, true, false, false])
    expect(blobs.putResults.slice(0, 2).map((result) => result.key))
      .toEqual(blobs.putResults.slice(2).map((result) => result.key))

    const expectedRows = replayed.getStored().run.result?.rows
    const response = await replayed.readService.getResultPage({
      runId: scope.runId,
      conversationId: replayed.submission.conversation.id,
      actor,
      limit: 3,
    })
    expect(response).toMatchObject({ ok: true, data: { rows: expectedRows } })
  })
})
