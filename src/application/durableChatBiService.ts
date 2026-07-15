import {
  validateActor,
  type ApiEnvelope,
  type CancelRunRequest,
  type GetRunRequest,
  type PublicErrorCode,
  type PublicRunView,
  type SubmitQuestionRequest,
} from '../contracts'
import type {
  QueryControlPlane,
  QueryExecutionControlPlane,
  SubmitAndEnqueueConflictReason,
} from '../persistence/controlPlanePorts'
import type { QueryRunJobPayload } from './queryExecutionCoordinator'
import { storedRunRecordToEnvelope } from './chatbiService'
import { prepareQuerySubmission } from './querySubmissionPlanner'
import { toQueryRunJobInput } from './queryExecutionCoordinator'

export interface DurableChatBiApplicationService {
  submitQuestion(request: SubmitQuestionRequest): Promise<ApiEnvelope<PublicRunView>>
  cancelRun(request: CancelRunRequest): Promise<ApiEnvelope<PublicRunView>>
  getRun(request: GetRunRequest): Promise<ApiEnvelope<PublicRunView>>
}

export type DurableQueryControlPlane = QueryControlPlane<QueryRunJobPayload>
  & Pick<QueryExecutionControlPlane<QueryRunJobPayload>, 'cancelRun'>

export interface DurableChatBiApplicationOptions {
  controlPlane: DurableQueryControlPlane
  now?: () => string
}

/**
 * Production submission/read boundary. Planning stays deterministic and local;
 * the returned unit-of-work is made visible only by the control-plane's single
 * PostgreSQL transaction.
 */
export function createDurableChatBiApplicationService(
  options: DurableChatBiApplicationOptions,
): DurableChatBiApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  const instanceId = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 16)
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  let sequence = 0

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${instanceId}_${String(sequence).padStart(6, '0')}`
  }

  async function submitQuestion(request: SubmitQuestionRequest): Promise<ApiEnvelope<PublicRunView>> {
    // The preflight produces validation errors without touching durable state.
    const preflight = prepareQuerySubmission(request, { now })
    if (!preflight.ok) return preflight.envelope

    const scope = { tenantId: request.actor.tenantId, workspaceId: request.actor.workspaceId }
    try {
      const replay = await options.controlPlane.getRunByIdempotency({
        ...scope,
        conversationId: request.conversationId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: preflight.requestFingerprint,
      })
      if (replay.status === 'match') return storedRunRecordToEnvelope(replay.runRecord)
      if (replay.status === 'conflict') {
        return failure(
          preflight.record.requestId,
          preflight.record.traceId,
          'VALIDATION_FAILED',
          '同一幂等键不能用于不同的问题或访问上下文',
          `idempotency_${replay.existingRunId}`,
        )
      }

      const existingConversation = await options.controlPlane.getConversation({
        ...scope,
        conversationId: request.conversationId,
      })
      const prepared = existingConversation
        ? prepareQuerySubmission(request, { now, existingConversation })
        : preflight
      if (!prepared.ok) return prepared.envelope

      const committed = await options.controlPlane.submitAndEnqueue({
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: prepared.requestFingerprint,
        conversation: prepared.conversation,
        runRecord: prepared.record,
        ...(prepared.job ? { job: toQueryRunJobInput(prepared.job) } : {}),
      })
      if (committed.ok) return storedRunRecordToEnvelope(committed.runRecord)
      return conflictEnvelope(prepared.record.requestId, prepared.record.traceId, committed)
    } catch {
      return failure(
        preflight.record.requestId,
        preflight.record.traceId,
        'INTERNAL_ERROR',
        '查询提交暂时不可用，请稍后重试',
        `control_plane_${preflight.record.run.id}`,
        true,
      )
    }
  }

  async function getRun(request: GetRunRequest): Promise<ApiEnvelope<PublicRunView>> {
    const requestId = nextId('req')
    const traceId = nextId('trace')
    const actorError = validateActor(request.actor)
    if (actorError) return { ok: false, requestId, traceId, error: actorError }
    try {
      const stored = await options.controlPlane.getRun({
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        runId: request.runId,
      })
      if (!stored) {
        return failure(
          requestId,
          traceId,
          'SEMANTIC_NOT_FOUND',
          '没有找到对应运行记录',
          `run_${request.runId}`,
        )
      }
      if (stored.run.conversationId !== request.conversationId) {
        return failure(requestId, traceId, 'PERMISSION_DENIED', '无权访问该内容', 'run_boundary')
      }
      const conversation = await options.controlPlane.getConversation({
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        conversationId: request.conversationId,
      })
      if (!conversation || conversation.businessDomainId !== request.actor.businessDomainId) {
        return failure(requestId, traceId, 'PERMISSION_DENIED', '无权访问该内容', 'conversation_boundary')
      }
      return storedRunRecordToEnvelope(stored)
    } catch {
      return failure(requestId, traceId, 'INTERNAL_ERROR', '运行状态暂时不可用', 'control_plane_read', true)
    }
  }

  async function cancelRun(request: CancelRunRequest): Promise<ApiEnvelope<PublicRunView>> {
    const requestId = nextId('req')
    const traceId = nextId('trace')
    const actorError = validateActor(request.actor)
    if (actorError) return { ok: false, requestId, traceId, error: actorError }
    if (!request.runId || !request.conversationId) {
      return failure(requestId, traceId, 'VALIDATION_FAILED', '缺少运行 ID 或会话 ID', 'cancel_contract')
    }

    const cancelledAt = now()
    try {
      const cancelled = await options.controlPlane.cancelRun({
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        runId: request.runId,
        conversationId: request.conversationId,
        actor: request.actor,
        cancelledAt,
        event: {
          eventId: `cancel_${request.runId}`,
          occurredAt: cancelledAt,
          event: {
            type: 'run.cancelled',
            runId: request.runId,
            conversationId: request.conversationId,
            actorUserId: request.actor.userId,
            at: cancelledAt,
          },
        },
      })
      if (cancelled.ok) return storedRunRecordToEnvelope(cancelled.runRecord)
      if (cancelled.reason === 'not_found') {
        return failure(requestId, traceId, 'SEMANTIC_NOT_FOUND', '没有找到对应运行记录', `run_${request.runId}`)
      }
      if (cancelled.reason === 'scope_conflict') {
        return failure(requestId, traceId, 'PERMISSION_DENIED', '无权访问该内容', 'cancel_boundary')
      }
      return failure(requestId, traceId, 'RUN_CANCELLED', '当前运行不可取消', `cancel_${cancelled.reason}`)
    } catch {
      return failure(
        requestId,
        traceId,
        'INTERNAL_ERROR',
        '取消请求暂时不可用，请稍后重试',
        `control_plane_cancel_${request.runId}`,
        true,
      )
    }
  }

  return { submitQuestion, cancelRun, getRun }
}

function conflictEnvelope(
  requestId: string,
  traceId: string,
  conflict: {
    reason: SubmitAndEnqueueConflictReason
    existingRunId?: string
    activeRunId?: string
  },
): ApiEnvelope<PublicRunView> {
  if (conflict.reason === 'idempotency_conflict') {
    return failure(
      requestId,
      traceId,
      'VALIDATION_FAILED',
      '同一幂等键不能用于不同的问题或访问上下文',
      `idempotency_${conflict.existingRunId ?? 'conflict'}`,
    )
  }
  if (conflict.reason === 'conversation_active_run_conflict') {
    return failure(
      requestId,
      traceId,
      'RUN_ALREADY_ACTIVE',
      '当前会话已有运行中的问题，请先完成、澄清或取消。',
      conflict.activeRunId ?? 'active_run',
      true,
    )
  }
  if (conflict.reason === 'conversation_scope_conflict') {
    return failure(requestId, traceId, 'PERMISSION_DENIED', '无权访问该内容', 'conversation_scope')
  }
  return failure(requestId, traceId, 'INTERNAL_ERROR', '运行标识冲突，请重试', 'run_identity', true)
}

function failure(
  requestId: string,
  traceId: string,
  code: PublicErrorCode,
  message: string,
  debugReference: string,
  retryable = false,
): ApiEnvelope<PublicRunView> {
  return {
    ok: false,
    requestId,
    traceId,
    error: { code, message, retryable, debugReference },
  }
}
