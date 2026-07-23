import { createHash } from 'node:crypto'
import type { AuditEvent, QueryExecutionSummary, ResultColumn } from '../../../src/contracts'
import type { Conversation, RunResult } from '../../../src/domain'
import {
  projectQueryRunOutcome,
  type QueryRunExecutionOutcome,
  type QueryRunJobPayload,
  type QueryRunJobPublication,
} from '../../../src/application/queryExecutionCoordinator'
import { createRunWorker, type RunWorkerCycleResult, type RunWorkerHandlerResult } from '../../../src/application/runWorker'
import type {
  CommitControlPlaneAttemptInput,
  ControlPlaneAttemptMutation,
  ControlPlaneResultPublication,
  QueryExecutionControlPlane,
} from '../../../src/persistence/controlPlanePorts'
import type { RunJobFailure, RunJobLease, RunJobQueue } from '../../../src/persistence/jobPorts'
import type { StoredRunRecord } from '../../../src/persistence/ports'
import type {
  ImmutableResultBlob,
  ImmutableResultBlobStore,
  PutImmutableResultBlobInput,
} from '../../../src/persistence/resultBlobPorts'
import { buildImmutableResultBlobKey } from '../../../src/persistence/resultBlobPorts'
import type { QueryAdapter } from '../../../src/query/types'
import { applyQueryAdapterOutcome, mapQueryResultToRunResult } from '../../../src/query'

export interface TransactionalResultPage {
  columns: ResultColumn[]
  rows: RunResult['rows']
}

export interface TransactionalResultBlobPageReference {
  schemaVersion: 'chatbi_result_page_blob_reference.v1'
  storage: 's3'
  blob: ImmutableResultBlob
}

export type TransactionalStoredResultPage =
  | TransactionalResultPage
  | TransactionalResultBlobPageReference

export interface TransactionalResultManifestMetadata {
  schemaVersion: 'chatbi_result_manifest.v1' | 'chatbi_result_manifest.v2'
  pageSize: number
  columns: ResultColumn[]
  chartSpec: RunResult['chartSpec']
  completeness: RunResult['completeness']
  incompleteSteps: string[]
  warnings: string[]
  freshnessAt: string
  semanticVersion: string
  pageStorage?: {
    type: 'inline' | 's3'
    encoding: 'canonical-json'
    contentType: 'application/vnd.insightflow.result-page+json'
  }
}

export type TransactionalQueryRunEvent = {
  schemaVersion: 'query_attempt.v1'
  type: 'query.attempt_completed' | 'query.attempt_failed' | 'query.attempt_retry_scheduled'
  runId: string
  attempt: number
  displayStatus: StoredRunRecord['run']['displayStatus']
  queryStatus?: QueryExecutionSummary['status']
  semanticVersion: string
  auditTypes: AuditEvent['type'][]
  failure?: { code: string; retryable: boolean }
}

export type TransactionalQueryExecutionControlPlane = QueryExecutionControlPlane<
  QueryRunJobPayload,
  QueryRunJobPublication,
  TransactionalQueryRunEvent,
  TransactionalStoredResultPage,
  TransactionalResultManifestMetadata
>

export interface TransactionalQueryExecutionCoordinatorOptions {
  adapter: QueryAdapter
  queue: RunJobQueue<QueryRunJobPayload, QueryRunJobPublication>
  controlPlane: TransactionalQueryExecutionControlPlane
  workerId: string
  leaseMs?: number
  heartbeatMs?: number
  resultPageSize?: number
  resultBlobStore?: ImmutableResultBlobStore
  now?: () => string
}

export interface TransactionalQueryExecutionRunner {
  runOnce(runId?: string): Promise<RunWorkerCycleResult>
  abortActive(): void
}

export interface BuildTransactionalAttemptCommitInput {
  lease: RunJobLease<QueryRunJobPayload>
  outcome: RunWorkerHandlerResult<TransactionalQueryExecutionOutcome>
  stored: StoredRunRecord
  conversation: Conversation
  resultPageSize?: number
}

type TransactionalQueryExecutionOutcome =
  | Extract<QueryRunExecutionOutcome, { type: 'blocked' }>
  | (Extract<QueryRunExecutionOutcome, { type: 'executed' }> & {
      resultPublication?: ControlPlaneResultPublication<
        TransactionalStoredResultPage,
        TransactionalResultManifestMetadata
      >
    })

/**
 * Production query worker whose queue mutation, Run/Conversation projection,
 * audit suffix, event and optional result publication share one commit.
 */
export function createTransactionalQueryExecutionCoordinator(
  options: TransactionalQueryExecutionCoordinatorOptions,
): TransactionalQueryExecutionRunner {
  const now = options.now ?? (() => new Date().toISOString())
  const leaseMs = options.leaseMs ?? 30_000
  const resultPageSize = validatePageSize(options.resultPageSize ?? 100)

  return createRunWorker<QueryRunJobPayload, QueryRunJobPublication, TransactionalQueryExecutionOutcome>({
    queue: options.queue,
    workerId: options.workerId,
    leaseMs,
    heartbeatMs: options.heartbeatMs,
    now,
    handler: {
      async execute(payload, context) {
        try {
          const adapterOutcome = await options.adapter.runReadOnly({
            executionId: `${payload.runId}:attempt:${context.attempt}`,
            cancellationToken: payload.summary.cancellation.token,
            dataSourceId: payload.plan.dataSourceId,
            sql: payload.plan.sql,
            parameters: payload.plan.parameters,
            sqlFingerprint: payload.plan.sqlFingerprint,
            budget: payload.plan.budget,
          }, context.signal)
          const completedAt = now()
          const summary = applyQueryAdapterOutcome(payload.summary, adapterOutcome)
          const result: QueryRunExecutionOutcome = adapterOutcome.status === 'blocked'
            ? { type: 'blocked', summary, reason: adapterOutcome.reason }
            : {
                type: 'executed',
                summary,
                result: mapQueryResultToRunResult({
                  resultId: payload.resultId,
                  plan: payload.plan,
                  execution: adapterOutcome,
                  freshnessAt: completedAt,
                }),
              }
          const transactionalResult: TransactionalQueryExecutionOutcome = result.type === 'executed'
            ? {
                ...result,
                resultPublication: await buildResultPublication(
                  {
                    tenantId: context.tenantId,
                    workspaceId: context.workspaceId,
                    runId: context.runId,
                    attempt: context.attempt,
                  },
                  result.result,
                  completedAt,
                  resultPageSize,
                  options.resultBlobStore,
                  context.signal,
                ),
              }
            : result
          return {
            type: 'completed',
            result: transactionalResult,
            resultFingerprint: sha256({
              runId: payload.runId,
              attempt: context.attempt,
              sqlFingerprint: payload.plan.sqlFingerprint,
              adapterStatus: adapterOutcome.status,
              explainCheckedAt: adapterOutcome.explain.checkedAt,
              result: transactionalResult.type === 'executed'
                ? transactionalResult.result
                : { reason: transactionalResult.reason },
            }),
            at: completedAt,
          }
        } catch (error) {
          const failedAt = now()
          const failure = classifyQueryFailure(error, context.signal.aborted)
          if (failure.retryable && context.attempt < context.maxAttempts) {
            return {
              type: 'retry',
              failure,
              failedAt,
              availableAt: new Date(Date.parse(failedAt) + retryDelayMs(context.attempt)).toISOString(),
            }
          }
          return { type: 'failed', failure, failedAt }
        }
      },
    },
    async commitAttempt({ lease, outcome }) {
      const scope = { tenantId: lease.tenantId, workspaceId: lease.workspaceId }
      const stored = await options.controlPlane.getRun({ ...scope, runId: lease.runId })
      if (!stored || stored.run.displayStatus !== 'querying') {
        return await inactiveAttemptMutation(options.queue, lease.runId)
      }
      const conversation = await options.controlPlane.getConversation({
        ...scope,
        conversationId: stored.run.conversationId,
      })
      if (!conversation) throw new Error('leased query Conversation no longer exists in its control-plane scope')
      if (conversation.activeRunId !== stored.run.id) {
        return await inactiveAttemptMutation(options.queue, lease.runId)
      }
      return await options.controlPlane.commitAttempt(buildTransactionalQueryAttemptCommit({
        lease,
        outcome,
        stored,
        conversation,
        resultPageSize,
      }))
    },
  })
}

export function buildTransactionalQueryAttemptCommit(
  input: BuildTransactionalAttemptCommitInput,
): CommitControlPlaneAttemptInput<
  QueryRunJobPublication,
  TransactionalQueryRunEvent,
  TransactionalStoredResultPage,
  TransactionalResultManifestMetadata
> {
  const pageSize = validatePageSize(input.resultPageSize ?? 100)
  const projected = projectQueryRunOutcome(
    input.stored,
    input.lease.payload,
    input.outcome,
    input.conversation,
  )
  if (!projected.conversation) throw new Error('transactional query commit requires its Conversation projection')

  const occurredAt = mutationTime(input.outcome)
  const event: TransactionalQueryRunEvent = {
    schemaVersion: 'query_attempt.v1',
    type: input.outcome.type === 'completed'
      ? 'query.attempt_completed'
      : input.outcome.type === 'retry'
        ? 'query.attempt_retry_scheduled'
        : 'query.attempt_failed',
    runId: input.lease.runId,
    attempt: input.lease.attempt,
    displayStatus: projected.runRecord.run.displayStatus,
    queryStatus: projected.runRecord.queryExecution?.status,
    semanticVersion: projected.runRecord.run.semanticVersion,
    auditTypes: projected.newAuditEvents.map((audit) => audit.type),
    ...(input.outcome.type === 'completed' ? {} : {
      failure: { code: input.outcome.failure.code, retryable: input.outcome.failure.retryable },
    }),
  }
  const resultPublication = input.outcome.type === 'completed' && input.outcome.result.type === 'executed'
    ? input.outcome.result.resultPublication
      ?? buildInlineResultPublication(input.lease, input.outcome.result.result, occurredAt, pageSize)
    : undefined
  const job = jobMutation(input.lease, input.outcome, resultPublication?.manifest)

  return {
    job,
    conversation: projected.conversation,
    runRecord: projected.runRecord,
    newAuditEvents: projected.newAuditEvents,
    event: {
      eventId: `evt_query_${sha256({
        tenantId: input.lease.tenantId,
        workspaceId: input.lease.workspaceId,
        fence: input.lease.fence,
        occurredAt,
        event,
      }).slice('sha256:'.length, 'sha256:'.length + 32)}`,
      event,
      occurredAt,
    },
    ...(resultPublication ? { resultPublication } : {}),
  }
}

async function buildResultPublication(
  lease: Pick<RunJobLease<QueryRunJobPayload>, 'tenantId' | 'workspaceId' | 'runId' | 'attempt'>,
  result: RunResult,
  publishedAt: string,
  pageSize: number,
  blobStore: ImmutableResultBlobStore | undefined,
  signal: AbortSignal,
): Promise<ControlPlaneResultPublication<TransactionalStoredResultPage, TransactionalResultManifestMetadata>> {
  if (!blobStore) return buildInlineResultPublication(lease, result, publishedAt, pageSize)

  const pageRows = chunk(result.rows, pageSize)
  const pages: ControlPlaneResultPublication<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >['pages'] = []
  for (let pageIndex = 0; pageIndex < pageRows.length; pageIndex += 1) {
    const rows = pageRows[pageIndex]
    const payload: TransactionalResultPage = { columns: result.columns, rows }
    const body = new TextEncoder().encode(stableStringify(payload))
    const writeInput: PutImmutableResultBlobInput = {
      tenantId: lease.tenantId,
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      attempt: lease.attempt,
      kind: 'page',
      checksum: sha256Bytes(body),
      byteLength: body.byteLength,
      contentType: 'application/vnd.insightflow.result-page+json',
      body,
      signal,
    }
    const written = await blobStore.put(writeInput)
    if (!written.ok) throw resultBlobConflict()
    assertResultBlobWrite(writeInput, written.blob)
    pages.push({
      tenantId: lease.tenantId,
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      attempt: lease.attempt,
      pageIndex,
      checksum: sha256({ runId: lease.runId, attempt: lease.attempt, pageIndex, payload }),
      rowCount: rows.length,
      payload: {
        schemaVersion: 'chatbi_result_page_blob_reference.v1',
        storage: 's3',
        blob: written.blob,
      },
      stagedAt: publishedAt,
    })
  }
  const metadata: TransactionalResultManifestMetadata = {
    schemaVersion: 'chatbi_result_manifest.v2',
    pageSize,
    columns: result.columns,
    chartSpec: result.chartSpec,
    completeness: result.completeness,
    incompleteSteps: result.incompleteSteps,
    warnings: result.warnings,
    freshnessAt: result.freshnessAt,
    semanticVersion: result.answer.semanticVersion,
    pageStorage: {
      type: 's3',
      encoding: 'canonical-json',
      contentType: 'application/vnd.insightflow.result-page+json',
    },
  }
  return assembleResultPublication(lease, result, publishedAt, pages, metadata)
}

function buildInlineResultPublication(
  lease: Pick<RunJobLease<QueryRunJobPayload>, 'tenantId' | 'workspaceId' | 'runId' | 'attempt'>,
  result: RunResult,
  publishedAt: string,
  pageSize: number,
): ControlPlaneResultPublication<TransactionalStoredResultPage, TransactionalResultManifestMetadata> {
  const pageRows = chunk(result.rows, pageSize)
  const pages = pageRows.map((rows, pageIndex) => {
    const payload: TransactionalResultPage = { columns: result.columns, rows }
    return {
      tenantId: lease.tenantId,
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      attempt: lease.attempt,
      pageIndex,
      checksum: sha256({ runId: lease.runId, attempt: lease.attempt, pageIndex, payload }),
      rowCount: rows.length,
      payload,
      stagedAt: publishedAt,
    }
  })
  const metadata: TransactionalResultManifestMetadata = {
    schemaVersion: 'chatbi_result_manifest.v1',
    pageSize,
    columns: result.columns,
    chartSpec: result.chartSpec,
    completeness: result.completeness,
    incompleteSteps: result.incompleteSteps,
    warnings: result.warnings,
    freshnessAt: result.freshnessAt,
    semanticVersion: result.answer.semanticVersion,
  }
  return assembleResultPublication(lease, result, publishedAt, pages, metadata)
}

function assembleResultPublication(
  lease: Pick<RunJobLease<QueryRunJobPayload>, 'tenantId' | 'workspaceId' | 'runId' | 'attempt'>,
  result: RunResult,
  publishedAt: string,
  pages: ControlPlaneResultPublication<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >['pages'],
  metadata: TransactionalResultManifestMetadata,
): ControlPlaneResultPublication<TransactionalStoredResultPage, TransactionalResultManifestMetadata> {
  const manifestIdentity = {
    runId: lease.runId,
    attempt: lease.attempt,
    resultId: result.id,
    pageChecksums: pages.map((page) => page.checksum),
    totalRows: result.rows.length,
    metadata,
  }
  return {
    pages,
    manifest: {
      tenantId: lease.tenantId,
      workspaceId: lease.workspaceId,
      runId: lease.runId,
      attempt: lease.attempt,
      resultId: result.id,
      manifestChecksum: sha256(manifestIdentity),
      pageChecksums: manifestIdentity.pageChecksums,
      totalRows: result.rows.length,
      metadata,
      publishedAt,
    },
  }
}

function jobMutation(
  lease: RunJobLease<QueryRunJobPayload>,
  outcome: RunWorkerHandlerResult<TransactionalQueryExecutionOutcome>,
  manifest: ControlPlaneResultPublication<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >['manifest'] | undefined,
): ControlPlaneAttemptMutation<QueryRunJobPublication> {
  const identity = {
    runId: lease.runId,
    attempt: lease.attempt,
    fence: lease.fence,
    workerId: lease.workerId,
    leaseToken: lease.leaseToken,
  }
  if (outcome.type === 'completed') {
    const result: QueryRunJobPublication = outcome.result.type === 'executed'
      ? {
          schemaVersion: 'chatbi_result_manifest_reference.v1',
          type: 'result_manifest',
          resultId: requiredManifest(manifest).resultId,
          manifestChecksum: requiredManifest(manifest).manifestChecksum,
        }
      : {
          schemaVersion: 'chatbi_no_result_reference.v1',
          type: 'no_result',
          reasonCode: 'QUERY_TOO_EXPENSIVE',
        }
    return { type: 'complete', input: {
      ...identity,
      completedAt: outcome.at,
      resultFingerprint: outcome.resultFingerprint,
      result,
    } }
  }
  if (outcome.type === 'retry') {
    return { type: 'retry', input: {
      ...identity,
      failedAt: outcome.failedAt,
      availableAt: outcome.availableAt,
      failure: outcome.failure,
    } }
  }
  return { type: 'fail', input: { ...identity, failedAt: outcome.failedAt, failure: outcome.failure } }
}

function mutationTime(outcome: RunWorkerHandlerResult<TransactionalQueryExecutionOutcome>) {
  return outcome.type === 'completed' ? outcome.at : outcome.failedAt
}

function requiredManifest(
  manifest: ControlPlaneResultPublication<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >['manifest'] | undefined,
) {
  if (!manifest) throw new Error('executed query completion requires a result manifest reference')
  return manifest
}

function classifyQueryFailure(error: unknown, aborted: boolean): RunJobFailure {
  const value = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown } : {}
  const rawCode = typeof value.code === 'string' ? value.code : undefined
  const resultStorageUnavailable = rawCode === 'TIMEOUT'
    || rawCode === 'REMOTE_UNAVAILABLE'
    || rawCode === 'CREDENTIAL_UNAVAILABLE'
  const resultStorageRejected = rawCode === 'INVALID_CONFIGURATION'
    || rawCode === 'INVALID_INPUT'
    || rawCode === 'REMOTE_REJECTED'
    || rawCode === 'REMOTE_PROTOCOL_ERROR'
    || rawCode === 'INTEGRITY_MISMATCH'
    || rawCode === 'RESULT_BLOB_CONTENT_CONFLICT'
  if (!aborted && (resultStorageUnavailable || resultStorageRejected)) {
    return {
      code: resultStorageUnavailable ? 'RESULT_STORAGE_UNAVAILABLE' : 'RESULT_STORAGE_REJECTED',
      message: resultStorageUnavailable ? '结果存储暂时不可用。' : '结果存储校验失败。',
      retryable: resultStorageUnavailable,
      debugReference: resultStorageUnavailable ? 'result_storage_unavailable' : 'result_storage_rejected',
    }
  }
  const knownCode = rawCode === 'QUERY_CANCELLED'
    || rawCode === 'QUERY_TIMEOUT'
    || rawCode === 'QUERY_UNAVAILABLE'
    || rawCode === 'QUERY_EXECUTION_FAILED'
  const code = aborted ? 'QUERY_CANCELLED' : knownCode ? rawCode : 'QUERY_EXECUTION_FAILED'
  const retryable = !aborted && knownCode
    && (value.retryable === true || code === 'QUERY_TIMEOUT' || code === 'QUERY_UNAVAILABLE')
  return {
    code,
    message: code === 'QUERY_TIMEOUT'
      ? '查询执行超时。'
      : code === 'QUERY_UNAVAILABLE'
        ? '查询数据源暂时不可用。'
        : code === 'QUERY_CANCELLED'
          ? '查询已取消。'
          : '查询执行失败。',
    retryable,
    debugReference: `query_adapter_${code.toLowerCase()}`,
  }
}

function retryDelayMs(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1))
}

async function inactiveAttemptMutation(
  queue: RunJobQueue<QueryRunJobPayload, QueryRunJobPublication>,
  runId: string,
) {
  const job = await queue.getJob(runId)
  const terminal = job?.status === 'cancelled' || job?.status === 'completed' || job?.status === 'failed'
  return {
    ok: false as const,
    reason: terminal ? 'terminal_conflict' as const : 'stale_lease' as const,
    ...(job ? { job } : {}),
  }
}

function validatePageSize(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error('resultPageSize must be an integer between 1 and 10000')
  }
  return value
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function sha256(value: unknown) {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function resultBlobConflict() {
  return Object.assign(new Error('Immutable result blob content conflict'), {
    code: 'RESULT_BLOB_CONTENT_CONFLICT',
    retryable: false,
  })
}

function assertResultBlobWrite(
  input: PutImmutableResultBlobInput,
  blob: ImmutableResultBlob,
) {
  if (
    blob.key !== buildImmutableResultBlobKey(input)
    || blob.tenantId !== input.tenantId
    || blob.workspaceId !== input.workspaceId
    || blob.runId !== input.runId
    || blob.attempt !== input.attempt
    || blob.kind !== input.kind
    || blob.checksum !== input.checksum
    || blob.byteLength !== input.byteLength
    || blob.contentType !== input.contentType
    || blob.cacheControl !== 'private, max-age=31536000, immutable'
    || !/^"[A-Za-z0-9._:+/=-]{1,160}"$/.test(blob.etag)
  ) {
    throw Object.assign(new Error('Immutable result blob integrity mismatch'), {
      code: 'INTEGRITY_MISMATCH',
      retryable: false,
    })
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
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
