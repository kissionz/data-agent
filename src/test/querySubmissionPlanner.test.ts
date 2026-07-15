import { describe, expect, it } from 'vitest'
import { prepareQuerySubmission } from '../application'
import type { ActorContext, SubmitQuestionRequest } from '../contracts'
import type { Conversation } from '../domain'

const at = '2026-07-15T12:30:00.000Z'
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
    idempotencyKey: 'durable_submit_1',
    conversationId: 'conversation_durable_submit',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
    ...patch,
  }
}

describe('durable query submission planner', () => {
  it('prepares one querying run and its exact scoped job without external writes', () => {
    const prepared = prepareQuerySubmission(request(), { now: () => at })

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected prepared submission')
    expect(prepared.envelope.data).toMatchObject({ displayStatus: 'querying', executedQuery: false })
    expect(prepared.record).toMatchObject({
      run: { id: prepared.envelope.data.runId, displayStatus: 'querying' },
      idempotencyFingerprint: prepared.requestFingerprint,
      queryExecution: { status: 'queued' },
    })
    expect(prepared.conversation.activeRunId).toBe(prepared.record.run.id)
    expect(prepared.job).toMatchObject({
      runId: prepared.record.run.id,
      actor,
      plan: { dataSourceId: 'warehouse_sales' },
    })
    expect(prepared.idempotencyKey).not.toBe(request().idempotencyKey)
  })

  it('prepares terminal policy failures without creating a query job', () => {
    const prepared = prepareQuerySubmission(request({ question: '查看其他事业部数据' }), { now: () => at })

    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('expected prepared policy result')
    expect(prepared.record.run).toMatchObject({ displayStatus: 'failed', error: { code: 'PERMISSION_DENIED' } })
    expect(prepared.conversation.activeRunId).toBeUndefined()
    expect(prepared.job).toBeUndefined()
  })

  it('preserves an active-conversation conflict for the transactional layer to recheck', () => {
    const existing: Conversation = {
      id: 'conversation_durable_submit',
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      businessDomainId: actor.businessDomainId,
      title: 'existing',
      mode: 'trusted',
      semanticVersion: actor.semanticVersion,
      state: {
        metrics: { value: ['net_revenue'], source: 'system_default' },
        dimensions: { value: ['order_date'], source: 'system_default' },
        filters: { value: {}, source: 'system_default' },
        timeRange: { value: 'last_12_complete_months', source: 'system_default' },
        grain: { value: 'month', source: 'system_default' },
        presentation: { value: 'line', source: 'system_default' },
        assumptions: [],
      },
      activeRunId: 'run_existing',
      createdBy: actor.userId,
      createdAt: at,
      updatedAt: at,
    }

    const prepared = prepareQuerySubmission(request(), { existingConversation: existing, now: () => at })

    expect(prepared).toMatchObject({ ok: false, envelope: { error: { code: 'RUN_ALREADY_ACTIVE' } } })
  })
})
