import { describe, expect, it, vi } from 'vitest'
import {
  createDurableChatBiApplicationService,
  prepareQuerySubmission,
  type DurableQueryControlPlane,
  type QueryRunJobPayload,
} from '../application'
import type { ActorContext, SubmitQuestionRequest } from '../contracts'
import { transitionRun } from '../domain'
import type { SubmitAndEnqueueInput } from '../persistence/controlPlanePorts'

const at = '2026-07-15T13:00:00.000Z'
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

function request(patch: Partial<SubmitQuestionRequest> = {}): SubmitQuestionRequest {
  return {
    idempotencyKey: 'durable_api_submit',
    conversationId: 'conversation_durable_api',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
    ...patch,
  }
}

function controlPlane(overrides: Partial<DurableQueryControlPlane> = {}) {
  let submitted: SubmitAndEnqueueInput<QueryRunJobPayload> | undefined
  const plane: DurableQueryControlPlane = {
    async getConversation() { return undefined },
    async getRun() { return undefined },
    async getRunByIdempotency() { return { status: 'not_found' } },
    async submitAndEnqueue(input) {
      submitted = structuredClone(input)
      return {
        ok: true,
        created: true,
        conversation: structuredClone(input.conversation),
        runRecord: structuredClone(input.runRecord),
      }
    },
    async cancelRun() { return { ok: false, reason: 'not_found' } },
    ...overrides,
  }
  return { plane, submitted: () => submitted }
}

describe('durable ChatBI application service', () => {
  it('returns success only after the control plane atomically accepts the Run and query job', async () => {
    const durable = controlPlane()
    const service = createDurableChatBiApplicationService({ controlPlane: durable.plane, now: () => at })

    const result = await service.submitQuestion(request())

    expect(result).toMatchObject({ ok: true, data: { displayStatus: 'querying', executedQuery: false } })
    expect(durable.submitted()).toMatchObject({
      idempotencyKey: 'durable_api_submit',
      runRecord: { run: { displayStatus: 'querying' }, queryExecution: { status: 'queued' } },
      job: {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        payload: { actor, plan: { dataSourceId: 'warehouse_sales' } },
      },
    })
    expect(durable.submitted()?.requestFingerprint).toBe(durable.submitted()?.runRecord.idempotencyFingerprint)
  })

  it('atomically persists policy-terminal submissions without creating a query job', async () => {
    const durable = controlPlane()
    const service = createDurableChatBiApplicationService({ controlPlane: durable.plane, now: () => at })

    const result = await service.submitQuestion(request({ question: '查看其他事业部数据' }))

    expect(result).toMatchObject({ ok: true, data: { displayStatus: 'failed', error: { code: 'PERMISSION_DENIED' } } })
    expect(durable.submitted()?.job).toBeUndefined()
    expect(durable.submitted()?.conversation.activeRunId).toBeUndefined()
  })

  it('returns the committed record for an exact replay and rejects changed content before a new commit', async () => {
    const original = prepareQuerySubmission(request(), { now: () => at })
    if (!original.ok) throw new Error('expected original submission')
    const submitAndEnqueue = vi.fn()
    const exact = controlPlane({
      async getRunByIdempotency() { return { status: 'match', runRecord: original.record } },
      submitAndEnqueue,
    })
    const service = createDurableChatBiApplicationService({ controlPlane: exact.plane, now: () => at })

    await expect(service.submitQuestion(request())).resolves.toMatchObject({
      ok: true,
      data: { runId: original.record.run.id },
    })
    expect(submitAndEnqueue).not.toHaveBeenCalled()

    const changed = controlPlane({
      async getRunByIdempotency() { return { status: 'conflict', existingRunId: original.record.run.id } },
      submitAndEnqueue,
    })
    await expect(createDurableChatBiApplicationService({ controlPlane: changed.plane, now: () => at })
      .submitQuestion(request({ question: '过去 12 个月净收入区域贡献' })))
      .resolves.toMatchObject({ ok: false, error: { code: 'VALIDATION_FAILED' } })
    expect(submitAndEnqueue).not.toHaveBeenCalled()
  })

  it('maps transaction races and database failures to stable public errors', async () => {
    const active = controlPlane({
      async submitAndEnqueue() {
        return { ok: false, reason: 'conversation_active_run_conflict', activeRunId: 'run_active' }
      },
    })
    const activeService = createDurableChatBiApplicationService({ controlPlane: active.plane, now: () => at })
    await expect(activeService.submitQuestion(request())).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUN_ALREADY_ACTIVE', debugReference: 'run_active' },
    })

    const unavailable = controlPlane({
      async submitAndEnqueue() {
        throw new Error('postgresql://admin:secret@db/chatbi chatbi_query_runs')
      },
    })
    const response = await createDurableChatBiApplicationService({ controlPlane: unavailable.plane, now: () => at })
      .submitQuestion(request())
    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', retryable: true } })
    expect(JSON.stringify(response)).not.toContain('postgresql')
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(JSON.stringify(response)).not.toContain('chatbi_query_runs')
  })

  it('rechecks conversation domain when reading a scoped Run', async () => {
    const prepared = prepareQuerySubmission(request(), { now: () => at })
    if (!prepared.ok) throw new Error('expected prepared submission')
    const durable = controlPlane({
      async getRun() { return prepared.record },
      async getConversation() { return { ...prepared.conversation, businessDomainId: 'finance' } },
    })
    const service = createDurableChatBiApplicationService({ controlPlane: durable.plane, now: () => at })

    await expect(service.getRun({
      runId: prepared.record.run.id,
      conversationId: prepared.conversation.id,
      actor,
    })).resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })
  })

  it('delegates cancellation to the atomic control-plane boundary with a stable event', async () => {
    const prepared = prepareQuerySubmission(request(), { now: () => at })
    if (!prepared.ok) throw new Error('expected prepared submission')
    const cancelledRun = transitionRun(prepared.record.run, { type: 'CANCELLED', at })
    const cancelRun = vi.fn(async () => ({
      ok: true as const,
      applied: true,
      conversation: { ...prepared.conversation, activeRunId: undefined, updatedAt: at },
      runRecord: { ...prepared.record, run: cancelledRun },
    }))
    const service = createDurableChatBiApplicationService({
      controlPlane: controlPlane({ cancelRun }).plane,
      now: () => at,
    })

    await expect(service.cancelRun({
      runId: prepared.record.run.id,
      conversationId: prepared.conversation.id,
      actor,
    })).resolves.toMatchObject({
      ok: true,
      data: { runId: prepared.record.run.id, displayStatus: 'waiting_input' },
    })
    expect(cancelRun).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      runId: prepared.record.run.id,
      conversationId: prepared.conversation.id,
      actor,
      cancelledAt: at,
      event: {
        eventId: `cancel_${prepared.record.run.id}`,
        occurredAt: at,
        event: {
          type: 'run.cancelled',
          runId: prepared.record.run.id,
          conversationId: prepared.conversation.id,
          actorUserId: actor.userId,
          at,
        },
      },
    })
  })

  it('maps cancellation conflicts and failures without leaking storage details', async () => {
    const terminal = controlPlane({
      async cancelRun() { return { ok: false, reason: 'terminal_conflict' } },
    })
    await expect(createDurableChatBiApplicationService({ controlPlane: terminal.plane, now: () => at })
      .cancelRun({ runId: 'run_terminal', conversationId: 'conversation_terminal', actor }))
      .resolves.toMatchObject({ ok: false, error: { code: 'RUN_CANCELLED' } })

    const scoped = controlPlane({
      async cancelRun() { return { ok: false, reason: 'scope_conflict' } },
    })
    await expect(createDurableChatBiApplicationService({ controlPlane: scoped.plane, now: () => at })
      .cancelRun({ runId: 'run_scoped', conversationId: 'conversation_scoped', actor }))
      .resolves.toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } })

    const unavailable = controlPlane({
      async cancelRun() { throw new Error('postgresql://admin:secret@db/chatbi chatbi_run_jobs') },
    })
    const response = await createDurableChatBiApplicationService({ controlPlane: unavailable.plane, now: () => at })
      .cancelRun({ runId: 'run_unavailable', conversationId: 'conversation_unavailable', actor })
    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', retryable: true } })
    expect(JSON.stringify(response)).not.toContain('postgresql')
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(JSON.stringify(response)).not.toContain('chatbi_run_jobs')
  })
})
