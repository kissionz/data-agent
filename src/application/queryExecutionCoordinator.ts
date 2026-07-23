import { attachRun, transitionRun, type Conversation, type RunError, type RunResult } from '../domain'
import { createInMemoryRunJobQueue } from '../persistence/jobMemory'
import type { EnqueueRunJobInput, RunJobQueue, SynchronousRunJobQueue } from '../persistence/jobPorts'
import type { ChatBiPersistence, StoredRunRecord } from '../persistence/ports'
import {
  applyQueryAdapterOutcome,
  mapQueryResultToRunResult,
  markQueryExecutionRunning,
  type CompiledQueryPlan,
  type QueryAdapter,
} from '../query'
import { stableHash } from '../query/hash'
import type { ActorContext, AuditEvent, QueryExecutionSummary } from '../contracts'
import { createRunWorker, type RunWorkerCycleResult, type RunWorkerHandlerResult } from './runWorker'

export interface QueryRunJobPayload {
  runId: string
  actor: ActorContext
  plan: CompiledQueryPlan
  summary: QueryExecutionSummary
  resultId: string
}

export type QueryRunExecutionOutcome =
  | { type: 'executed'; result: RunResult; summary: QueryExecutionSummary }
  | { type: 'blocked'; summary: QueryExecutionSummary; reason: string }

/**
 * The only result-shaped data allowed in a terminal query Job. Full answers,
 * rows, columns, facts and chart payloads live in the atomically published Run
 * and result page/manifest path, never in the queue record.
 */
export type QueryRunJobPublication =
  | {
      schemaVersion: 'chatbi_result_manifest_reference.v1'
      type: 'result_manifest'
      resultId: string
      manifestChecksum: string
    }
  | {
      schemaVersion: 'chatbi_no_result_reference.v1'
      type: 'no_result'
      reasonCode: 'QUERY_TOO_EXPENSIVE'
    }

export interface QueryRunOutcomeProjection {
  runRecord: StoredRunRecord
  conversation?: Conversation
  newAuditEvents: AuditEvent[]
}

export interface EnqueueQueryRunInput extends QueryRunJobPayload {
  enqueuedAt: string
}

export interface QueryExecutionDispatcher {
  enqueue(input: EnqueueQueryRunInput): { ok: true; created: boolean } | { ok: false; reason: string }
  cancel(runId: string, cancelledAt: string): 'cancelled' | 'already_cancelled' | 'not_found' | 'terminal_conflict'
  runOnce(runId?: string): Promise<RunWorkerCycleResult>
}

export interface DurableQueryExecutionDispatcher {
  enqueue(input: EnqueueQueryRunInput): Promise<{ ok: true; created: boolean } | { ok: false; reason: string }>
  cancel(runId: string, cancelledAt: string): Promise<'cancelled' | 'already_cancelled' | 'not_found' | 'terminal_conflict'>
  runOnce(runId?: string): Promise<RunWorkerCycleResult>
}

export interface QueryExecutionCoordinatorOptions {
  adapter: QueryAdapter
  persistence: ChatBiPersistence
  queue?: SynchronousRunJobQueue<QueryRunJobPayload, QueryRunJobPublication>
  workerId?: string
  leaseMs?: number
  now?: () => string
}

export interface DurableQueryExecutionCoordinatorOptions extends Omit<QueryExecutionCoordinatorOptions, 'queue'> {
  queue: RunJobQueue<QueryRunJobPayload, QueryRunJobPublication>
}

export function createQueryExecutionCoordinator(
  options: QueryExecutionCoordinatorOptions,
): QueryExecutionDispatcher {
  const queue = options.queue ?? createInMemoryRunJobQueue<QueryRunJobPayload, QueryRunJobPublication>()
  const now = options.now ?? (() => new Date().toISOString())
  const leaseMs = options.leaseMs ?? 30_000
  const worker = createQueryWorker(options, queue, now, leaseMs)

  return {
    enqueue(input) {
      const result = queue.enqueue(toQueryRunJobInput(input))
      return result.ok
        ? { ok: true, created: result.created }
        : { ok: false, reason: result.reason }
    },
    cancel(runId, cancelledAt) {
      const result = queue.cancel(runId, cancelledAt)
      if (!result.ok) return result.reason
      return result.applied ? 'cancelled' : 'already_cancelled'
    },
    runOnce(runId) {
      return worker.runOnce(runId)
    },
  }
}

export function createDurableQueryExecutionCoordinator(
  options: DurableQueryExecutionCoordinatorOptions,
): DurableQueryExecutionDispatcher {
  const now = options.now ?? (() => new Date().toISOString())
  const leaseMs = options.leaseMs ?? 30_000
  const worker = createQueryWorker(options, options.queue, now, leaseMs)
  return {
    async enqueue(input) {
      const result = await options.queue.enqueue(toQueryRunJobInput(input))
      return result.ok
        ? { ok: true, created: result.created }
        : { ok: false, reason: result.reason }
    },
    async cancel(runId, cancelledAt) {
      const result = await options.queue.cancel(runId, cancelledAt)
      if (!result.ok) return result.reason
      return result.applied ? 'cancelled' : 'already_cancelled'
    },
    runOnce(runId) {
      return worker.runOnce(runId)
    },
  }
}

function createQueryWorker(
  options: Omit<QueryExecutionCoordinatorOptions, 'queue'>,
  queue: RunJobQueue<QueryRunJobPayload, QueryRunJobPublication>,
  now: () => string,
  leaseMs: number,
) {
  return createRunWorker<QueryRunJobPayload, QueryRunJobPublication, QueryRunExecutionOutcome>({
    queue,
    workerId: options.workerId ?? 'query-worker-1',
    leaseMs,
    now,
    handler: {
      async execute(payload, context): Promise<RunWorkerHandlerResult<QueryRunExecutionOutcome>> {
        markRunning(options.persistence, payload, now())
        try {
          const outcome = await options.adapter.runReadOnly({
            executionId: `${payload.runId}:attempt:${context.attempt}`,
            cancellationToken: payload.summary.cancellation.token,
            dataSourceId: payload.plan.dataSourceId,
            sql: payload.plan.sql,
            parameters: payload.plan.parameters,
            sqlFingerprint: payload.plan.sqlFingerprint,
            budget: payload.plan.budget,
          }, context.signal)
          const completedAt = now()
          const summary = applyQueryAdapterOutcome(payload.summary, outcome)
          const publication: QueryRunExecutionOutcome = outcome.status === 'blocked'
            ? { type: 'blocked', summary, reason: outcome.reason }
            : {
                type: 'executed',
                summary,
                result: mapQueryResultToRunResult({
                  resultId: payload.resultId,
                  plan: payload.plan,
                  execution: outcome,
                  freshnessAt: completedAt,
                }),
              }
          return {
            type: 'completed',
            result: publication,
            resultFingerprint: `${payload.plan.sqlFingerprint}:${outcome.status}:${outcome.explain.checkedAt}`,
            at: completedAt,
          }
        } catch (error) {
          const failedAt = now()
          const failure = safeFailure(error, context.signal.aborted)
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
    serializeCompletedResult: toQueryRunJobPublication,
    onCommitted(commit) {
      publishCommittedOutcome(options.persistence, commit.lease.payload, commit.outcome)
    },
  })
}

export function toQueryRunJobInput(
  input: EnqueueQueryRunInput,
): EnqueueRunJobInput<QueryRunJobPayload> {
  return {
    runId: input.runId,
    tenantId: input.actor.tenantId,
    workspaceId: input.actor.workspaceId,
    payloadFingerprint: `${input.plan.sqlFingerprint}:${input.actor.tenantId}:${input.actor.workspaceId}`,
    payload: {
      runId: input.runId,
      actor: input.actor,
      plan: input.plan,
      summary: input.summary,
      resultId: input.resultId,
    },
    enqueuedAt: input.enqueuedAt,
  }
}

function markRunning(persistence: ChatBiPersistence, payload: QueryRunJobPayload, at: string) {
  const stored = persistence.getRun(payload.runId)
  if (!stored || stored.run.displayStatus !== 'querying') return
  persistence.saveRun({
    ...stored,
    queryExecution: markQueryExecutionRunning(stored.queryExecution ?? payload.summary),
    audit: appendAudit(stored, payload.actor, 'query.started', '真实只读查询已由 worker 开始执行。', at),
  })
}

function publishCommittedOutcome(
  persistence: ChatBiPersistence,
  payload: QueryRunJobPayload,
  outcome: RunWorkerHandlerResult<QueryRunExecutionOutcome>,
) {
  const stored = persistence.getRun(payload.runId)
  if (!stored || stored.run.displayStatus !== 'querying') return
  const projected = projectQueryRunOutcome(
    stored,
    payload,
    outcome,
    persistence.getConversation(stored.run.conversationId),
  )
  persistence.saveRun(projected.runRecord)
  if (projected.conversation) persistence.saveConversation(projected.conversation)
}

export function projectQueryRunOutcome(
  stored: StoredRunRecord,
  payload: QueryRunJobPayload,
  outcome: RunWorkerHandlerResult<QueryRunExecutionOutcome>,
  conversation?: Conversation,
): QueryRunOutcomeProjection {
  if (stored.run.id !== payload.runId || stored.run.displayStatus !== 'querying') {
    throw new Error('query outcome does not belong to an active querying Run')
  }
  let runRecord: StoredRunRecord
  if (outcome.type === 'retry') {
    runRecord = {
      ...stored,
      queryExecution: { ...(stored.queryExecution ?? payload.summary), status: 'queued' },
    }
  } else {
    const at = outcome.type === 'completed' ? outcome.at : outcome.failedAt
    if (outcome.type === 'completed' && outcome.result.type === 'executed') {
      const run = transitionRun(stored.run, { type: 'RESULT_READY', result: outcome.result.result, at })
      runRecord = {
        ...stored,
        run,
        executedQuery: true,
        queryExecution: outcome.result.summary,
        audit: appendAudit(stored, payload.actor, 'query.completed', '真实只读查询完成，结果已通过字段与引用校验。', at)
          .concat(auditEvent(stored, payload.actor, 'result.ready', '答案已从真实查询结果生成。', at, 1)),
      }
    } else {
      const blockedPublication = outcome.type === 'completed' && outcome.result.type === 'blocked'
        ? outcome.result
        : undefined
      const failure = blockedPublication
        ? {
            code: 'QUERY_TOO_EXPENSIVE' as const,
            userMessage: '真实 EXPLAIN 估算超过工作空间预算，请缩短时间或增加筛选条件',
            retryable: true,
            debugReference: `budget_${payload.runId}`,
            safeDetails: `预算门禁：${blockedPublication.reason}`,
          }
        : toRunError(outcome.type === 'failed' ? outcome.failure : undefined, payload.runId)
      const run = transitionRun(stored.run, { type: 'FAILED', error: failure, at })
      runRecord = {
        ...stored,
        run,
        executedQuery: false,
        queryExecution: blockedPublication ? blockedPublication.summary : stored.queryExecution,
        audit: appendAudit(
          stored,
          payload.actor,
          blockedPublication ? 'query.blocked' : 'query.completed',
          blockedPublication ? '真实 EXPLAIN 预算门禁已阻断查询正文。' : '查询执行失败，已返回安全错误。',
          at,
        ),
      }
    }
  }
  return {
    runRecord,
    conversation: conversation ? attachRun(conversation, runRecord.run) : undefined,
    newAuditEvents: runRecord.audit.slice(stored.audit.length),
  }
}

function toQueryRunJobPublication(result: QueryRunExecutionOutcome): QueryRunJobPublication {
  if (result.type === 'blocked') {
    return {
      schemaVersion: 'chatbi_no_result_reference.v1',
      type: 'no_result',
      reasonCode: 'QUERY_TOO_EXPENSIVE',
    }
  }
  return {
    schemaVersion: 'chatbi_result_manifest_reference.v1',
    type: 'result_manifest',
    resultId: result.result.id,
    // Fixture mode has no durable page store; retain only a deterministic
    // reference checksum while the full Run projection is committed separately.
    manifestChecksum: `fixture-fnv1a:${stableHash(result.result)}`,
  }
}

function appendAudit(
  stored: StoredRunRecord,
  actor: ActorContext,
  type: AuditEvent['type'],
  summary: string,
  at: string,
) {
  return [...stored.audit, auditEvent(stored, actor, type, summary, at)]
}

function auditEvent(
  stored: StoredRunRecord,
  actor: ActorContext,
  type: AuditEvent['type'],
  summary: string,
  at: string,
  offset = 0,
): AuditEvent {
  return {
    id: `audit_${stored.run.id}_${stored.audit.length + 1 + offset}`,
    at,
    type,
    actorUserId: actor.userId,
    tenantId: actor.tenantId,
    workspaceId: actor.workspaceId,
    runId: stored.run.id,
    summary,
  }
}

function safeFailure(error: unknown, aborted: boolean) {
  const value = error && typeof error === 'object' ? error as { code?: unknown; retryable?: unknown } : {}
  const code = aborted ? 'QUERY_CANCELLED' : typeof value.code === 'string' ? value.code : 'QUERY_EXECUTION_FAILED'
  const retryable = !aborted && (value.retryable === true || code === 'QUERY_TIMEOUT' || code === 'QUERY_UNAVAILABLE')
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

function toRunError(failure: { code: string; retryable: boolean; debugReference?: string } | undefined, runId: string): RunError {
  return {
    code: 'INTERNAL_ERROR',
    userMessage: failure?.code === 'QUERY_TIMEOUT' ? '查询超时，请缩短时间范围后重试' : '查询暂时无法完成，请稍后重试',
    retryable: failure?.retryable ?? false,
    debugReference: failure?.debugReference ?? `query_${runId}`,
  }
}

function retryDelayMs(attempt: number) {
  return Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1))
}
