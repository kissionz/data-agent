import { describe, expect, it } from 'vitest'
import {
  prepareQuerySubmission,
  toQueryRunJobInput,
  type QueryRunJobPayload,
} from '../application'
import type { ActorContext, SubmitQuestionRequest } from '../contracts'
import { createInMemoryQueryControlPlane } from '../persistence/controlPlaneMemory'
import type { SubmitAndEnqueueInput } from '../persistence/controlPlanePorts'

const now = '2026-07-15T16:00:00.000Z'
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
    idempotencyKey: 'memory_control_plane',
    conversationId: 'conversation_memory_control_plane',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
    ...patch,
  }
}

function preparedInput(patch: Partial<SubmitQuestionRequest> = {}): SubmitAndEnqueueInput<QueryRunJobPayload> {
  const requested = request(patch)
  const prepared = prepareQuerySubmission(requested, { now: () => now })
  if (!prepared.ok) throw new Error(`expected prepared submission: ${JSON.stringify(prepared.envelope)}`)
  return {
    idempotencyKey: requested.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    conversation: prepared.conversation,
    runRecord: prepared.record,
    ...(prepared.job ? { job: toQueryRunJobInput(prepared.job) } : {}),
  }
}

describe('in-memory query control plane', () => {
  it('atomically stores a Run, conversation, idempotency reservation and optional job with defensive copies', async () => {
    const plane = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const input = preparedInput()
    const scope = {
      tenantId: input.conversation.tenantId,
      workspaceId: input.conversation.workspaceId,
    }

    const committed = await plane.submitAndEnqueue(input)
    expect(committed).toMatchObject({ ok: true, created: true, runRecord: { run: { displayStatus: 'querying' } } })
    const job = await plane.getJob({ ...scope, runId: input.runRecord.run.id })
    expect(job).toMatchObject({ runId: input.runRecord.run.id, payload: { actor, plan: { dataSourceId: 'warehouse_sales' } } })

    input.conversation.title = 'caller mutation'
    input.runRecord.run.question = 'caller mutation'
    if (input.job) input.job.payload.actor.userId = 'caller_mutation'
    if (committed.ok) {
      committed.conversation.title = 'response mutation'
      committed.runRecord.run.question = 'response mutation'
    }
    if (job) job.payload.actor.userId = 'response_mutation'

    await expect(plane.getConversation({ ...scope, conversationId: input.conversation.id }))
      .resolves.not.toMatchObject({ title: expect.stringContaining('mutation') })
    await expect(plane.getRun({ ...scope, runId: input.runRecord.run.id }))
      .resolves.not.toMatchObject({ run: { question: expect.stringContaining('mutation') } })
    await expect(plane.getJob({ ...scope, runId: input.runRecord.run.id }))
      .resolves.toMatchObject({ payload: { actor: { userId: actor.userId } } })
  })

  it('returns the original committed Run for an exact replay and rejects a changed idempotency key payload', async () => {
    const plane = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const original = preparedInput()
    const first = await plane.submitAndEnqueue(original)
    const replayCandidate = preparedInput()

    await expect(plane.submitAndEnqueue(replayCandidate)).resolves.toMatchObject({
      ok: true,
      created: false,
      runRecord: { run: { id: original.runRecord.run.id } },
    })
    const changed = preparedInput({ question: '过去 12 个月净收入区域贡献' })
    await expect(plane.submitAndEnqueue(changed)).resolves.toEqual({
      ok: false,
      reason: 'idempotency_conflict',
      existingRunId: original.runRecord.run.id,
    })
    expect(first).toMatchObject({ ok: true, created: true })
  })

  it('serializes competing active submissions so only one can own the conversation', async () => {
    const plane = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const first = preparedInput({ idempotencyKey: 'active_race_first' })
    const second = preparedInput({ idempotencyKey: 'active_race_second' })

    const results = await Promise.all([
      plane.submitAndEnqueue(first),
      plane.submitAndEnqueue(second),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([{
      ok: false,
      reason: 'conversation_active_run_conflict',
      activeRunId: first.runRecord.run.id,
    }])
    await expect(plane.getJob({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      runId: second.runRecord.run.id,
    })).resolves.toBeUndefined()
  })

  it('rejects conversation scope/domain and duplicate Run identities without partial publication', async () => {
    const plane = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const original = preparedInput()
    await plane.submitAndEnqueue(original)

    const wrongDomain = preparedInput({ idempotencyKey: 'wrong_domain' })
    wrongDomain.conversation.businessDomainId = 'finance'
    await expect(plane.submitAndEnqueue(wrongDomain)).resolves.toEqual({
      ok: false,
      reason: 'conversation_scope_conflict',
    })

    const wrongScope = preparedInput({ idempotencyKey: 'wrong_scope' })
    wrongScope.conversation.tenantId = 'tenant_other'
    wrongScope.runRecord.run.tenantId = 'tenant_other'
    if (wrongScope.job) {
      wrongScope.job.tenantId = 'tenant_other'
      wrongScope.job.payload.actor.tenantId = 'tenant_other'
    }
    await expect(plane.submitAndEnqueue(wrongScope)).resolves.toEqual({
      ok: false,
      reason: 'conversation_scope_conflict',
    })

    const runCollision = preparedInput({
      idempotencyKey: 'run_collision',
      conversationId: 'conversation_run_collision',
    })
    runCollision.runRecord.run.id = original.runRecord.run.id
    runCollision.conversation.activeRunId = original.runRecord.run.id
    if (runCollision.job) runCollision.job.runId = original.runRecord.run.id
    await expect(plane.submitAndEnqueue(runCollision)).resolves.toEqual({
      ok: false,
      reason: 'run_identity_conflict',
    })
    await expect(plane.getConversation({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      conversationId: wrongDomain.conversation.id,
    })).resolves.toMatchObject({ businessDomainId: 'sales' })
  })

  it('stores terminal submissions without creating a job', async () => {
    const plane = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const terminal = preparedInput({
      idempotencyKey: 'terminal_without_job',
      conversationId: 'conversation_terminal_without_job',
      question: '查看其他事业部数据',
    })

    await expect(plane.submitAndEnqueue(terminal)).resolves.toMatchObject({
      ok: true,
      created: true,
      conversation: { activeRunId: undefined },
      runRecord: { run: { displayStatus: 'failed' } },
    })
    expect(terminal.job).toBeUndefined()
    await expect(plane.getJob({
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      runId: terminal.runRecord.run.id,
    })).resolves.toBeUndefined()
  })

  it('scopes reads and returns defensive idempotency replay copies', async () => {
    const plane = createInMemoryQueryControlPlane<QueryRunJobPayload>()
    const input = preparedInput()
    await plane.submitAndEnqueue(input)
    const lookup = {
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      conversationId: input.conversation.id,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
    }

    const replay = await plane.getRunByIdempotency(lookup)
    expect(replay).toMatchObject({ status: 'match', runRecord: { run: { id: input.runRecord.run.id } } })
    if (replay.status === 'match') replay.runRecord.run.question = 'mutated replay'
    await expect(plane.getRunByIdempotency(lookup)).resolves.toMatchObject({
      status: 'match',
      runRecord: { run: { question: '过去 12 个月净收入趋势' } },
    })
    await expect(plane.getRun({
      tenantId: 'tenant_other',
      workspaceId: actor.workspaceId,
      runId: input.runRecord.run.id,
    })).resolves.toBeUndefined()
  })
})
