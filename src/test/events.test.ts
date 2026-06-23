import { describe, expect, it } from 'vitest'
import {
  PUBLIC_ERROR_CATALOG,
  filterSseEventsAfter,
  runViewToSseEvents,
  serializeSseEvents,
} from '../contracts'
import { createChatBiApplicationService } from '../application'
import type { ActorContext, PublicErrorCode } from '../contracts'

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

const allPublicCodes: PublicErrorCode[] = [
  'AMBIGUOUS_QUERY',
  'SEMANTIC_NOT_FOUND',
  'PERMISSION_DENIED',
  'QUERY_TOO_EXPENSIVE',
  'DATA_STALE',
  'PARTIAL_RESULT',
  'MODEL_UNAVAILABLE',
  'RUN_ALREADY_ACTIVE',
  'RUN_CANCELLED',
  'VALIDATION_FAILED',
  'INTERNAL_ERROR',
]

describe('SSE and error contracts', () => {
  it('keeps a catalog entry for every public error code', () => {
    expect(Object.keys(PUBLIC_ERROR_CATALOG).sort()).toEqual([...allPublicCodes].sort())
    expect(PUBLIC_ERROR_CATALOG.PERMISSION_DENIED).toMatchObject({
      httpStatus: 403,
      safeForUser: true,
      retryableDefault: false,
    })
    expect(PUBLIC_ERROR_CATALOG.INTERNAL_ERROR.safeForUser).toBe(false)
  })

  it('turns a public run view into ordered SSE events', () => {
    const service = createChatBiApplicationService(() => '2026-06-23T09:00:00+08:00')
    const response = service.submitQuestion({
      idempotencyKey: 'events_success',
      conversationId: 'conversation_events',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!response.ok) throw new Error('expected run view')

    const events = runViewToSseEvents(response.data)
    expect(events.map((event) => event.event)).toEqual([
      'question.accepted',
      'planner.ir_created',
      'compiler.plan_created',
      'query.started',
      'query.completed',
      'result.ready',
      'run.snapshot',
      'run.result_ready',
    ])

    const serialized = serializeSseEvents(events)
    expect(serialized).toContain('event: run.snapshot')
    expect(serialized).toContain('retry: 3000')
    expect(serialized).toContain('data: {')
  })

  it('supports Last-Event-ID style filtering', () => {
    const service = createChatBiApplicationService(() => '2026-06-23T09:00:00+08:00')
    const response = service.submitQuestion({
      idempotencyKey: 'events_filter',
      conversationId: 'conversation_filter',
      question: '最近销售情况怎么样',
      mode: 'trusted',
      actor,
    })
    if (!response.ok) throw new Error('expected run view')
    const events = runViewToSseEvents(response.data)
    const afterFirst = filterSseEventsAfter(events, events[0].id)
    expect(afterFirst).toHaveLength(events.length - 1)
    expect(afterFirst[0].id).toBe(events[1].id)
    expect(filterSseEventsAfter(events, 'unknown')).toHaveLength(events.length)
  })
})
