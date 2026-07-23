import { createHash } from 'node:crypto'
import type { AuditEvent, QueryExecutionSummary, ResultColumn } from '../../../src/contracts'
import type { Conversation, RunResult } from '../../../src/domain'
import {
  projectQueryRunOutcome,
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
import type { QueryAdapter } from '../../../src/query/types'
import { applyQueryAdapterOutcome, mapQueryResultToRunResult } from '../../../src/query'

export interface TransactionalResultPage {
  columns: ResultColumn[]
  rows: RunResult['rows']
}

export interface TransactionalResultManifestMetadata {
  schemaVersion: 'chatbi_result_manifest.v1'
  pageSize: number
  columns: ResultColumn[]
  chartSpec: RunResult['chartSpec']
  completeness: RunResult['completeness']
  incompleteSteps: string[]
  warnings: string[]
  freshnessAt: string
  semanticVersion: string
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
  TransactionalResultPage,
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
  now?: () => string
}

export interface TransactionalQueryExecutionRunner {
  runOnce(runId?: string): Promise<RunWorkerCycleResult>
  abortActive(): void
}

export interface BuildTransactionalAttemptCommitInput {
  lease: RunJobLease<QueryRunJobPayload>
  outcome: RunWorkerHandlerResult<QueryRunJobPublication>
  stored: StoredRunRecord
  conversation: Conversation
  resultPageSize?: number
}

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

  return createRunWorker<QueryRunJobPayload, QueryRunJobPublication>({
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
          const result: QueryRunJobPublication = adapterOutcome.status === 'blocked'
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
          return {
            type: 'completed',
            result,
            resultFingerprint: sha256({
              runId: payload.runId,
              attempt: context.attempt,
              sqlFingerprint: payload.plan.sqlFingerprint,
              adapterStatus: adapterOutcome.status,
              explainCheckedAt: adapterOutcome.explain.checkedAt,
              result: result.type === 'executed' ? result.result : { reason: result.reason },
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
  TransactionalResultPage,
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

  const job = jobMutation(input.lease, input.outcome)
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
    ? buildResultPublication(input.lease, input.outcome.result.result, occurredAt, pageSize)
    : undefined

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

function buildResultPublication(
  lease: RunJobLease<QueryRunJobPayload>,
  result: RunResult,
  publishedAt: string,
  pageSize: number,
): ControlPlaneResultPublication<TransactionalResultPage, TransactionalResultManifestMetadata> {
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
  outcome: RunWorkerHandlerResult<QueryRunJobPublication>,
): ControlPlaneAttemptMutation<QueryRunJobPublication> {
  const identity = {
    runId: lease.runId,
    attempt: lease.attempt,
    fence: lease.fence,
    workerId: lease.workerId,
    leaseToken: lease.leaseToken,
  }
  if (outcome.type === 'completed') {
    return { type: 'complete', input: {
      ...identity,
      completedAt: outcome.at,
      resultFingerprint: outcome.resultFingerprint,
      result: outcome.result,
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

function mutationTime(outcome: RunWorkerHandlerResult<QueryRunJobPublication>) {
  return outcome.type === 'completed' ? outcome.at : outcome.failedAt
}

function classifyQueryFailure(error: unknown, aborted: boolean): RunJobFailure {
  const value = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown } : {}
  const rawCode = typeof value.code === 'string' ? value.code : undefined
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
