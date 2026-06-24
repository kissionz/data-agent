import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter, normalizePath } from '../api'
import type { ActorContext } from '../contracts'

const actorHeaders = {
  'x-tenant-id': 'tenant_demo',
  'x-workspace-id': 'workspace_sales',
  'x-user-id': 'user_lin',
  'x-business-domain-id': 'sales',
  'x-semantic-version': 'sales-semantic-2026.06.1',
}

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

function submitBody(question: string, conversationId = 'conversation_api') {
  return {
    conversation_id: conversationId,
    question,
    mode: 'trusted',
  }
}

describe('ChatBI local BFF router', () => {
  it('serves health and OpenAPI without caching', () => {
    const router = createChatBiBffRouter()
    const health = router.handle({ method: 'GET', path: '/healthz' })
    expect(health).toMatchObject({
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      },
    })

    const openapi = router.handle({ method: 'GET', path: '/openapi.json' })
    expect(openapi.status).toBe(200)
    expect(openapi.body).toMatchObject({
      openapi: '3.1.0',
      paths: {
        '/v1/questions': expect.any(Object),
        '/v1/model-ops/routes': expect.any(Object),
        '/v1/model-ops/route': expect.any(Object),
        '/v1/runs/{runId}/clarify': expect.any(Object),
        '/v1/runs/{runId}/events': expect.any(Object),
      },
      components: {
        schemas: {
          QueryExecutionSummary: expect.objectContaining({
            additionalProperties: false,
          }),
        },
      },
    })
  })

  it('maps POST /v1/questions to PublicRunView and honors Idempotency-Key', () => {
    const router = createChatBiBffRouter()
    const first = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_same' },
      body: submitBody('过去 12 个月净收入趋势'),
    })
    const second = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_same' },
      body: submitBody('过去 12 个月净收入趋势'),
    })

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = first.body as Record<string, unknown>
    const secondBody = second.body as Record<string, unknown>
    expect(firstBody).toMatchObject({ ok: true })
    expect((secondBody.data as { runId: string }).runId).toBe((firstBody.data as { runId: string }).runId)
    expect((firstBody.data as { executedQuery: boolean }).executedQuery).toBe(true)
    expect((firstBody.data as { queryExecution: { cacheKey: string; sqlFingerprint: string } }).queryExecution).toMatchObject({
      cacheKey: expect.stringMatching(/^qcache_/),
      sqlFingerprint: expect.any(String),
    })
    expect(JSON.stringify((firstBody.data as { queryExecution: unknown }).queryExecution)).not.toContain('SELECT')
  })

  it('gets run snapshots and rejects cross-workspace reads with safe 403', () => {
    const router = createChatBiBffRouter()
    const created = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_get' },
      body: submitBody('过去 12 个月净收入趋势'),
    })
    const createdData = (created.body as { data: { runId: string; conversationId: string } }).data

    const snapshot = router.handle({
      method: 'GET',
      path: `/v1/runs/${createdData.runId}`,
      headers: actorHeaders,
      query: { conversation_id: createdData.conversationId },
    })
    expect(snapshot.status).toBe(200)
    expect(snapshot.body).toMatchObject({ ok: true, data: { runId: createdData.runId } })

    const denied = router.handle({
      method: 'GET',
      path: `/v1/runs/${createdData.runId}`,
      headers: { ...actorHeaders, 'x-workspace-id': 'other_workspace' },
      query: { conversation_id: createdData.conversationId },
    })
    expect(denied.status).toBe(403)
    expect(JSON.stringify(denied.body)).not.toMatch(/sales|net_revenue|workspace_sales|policy/i)
  })

  it('runs the clarification endpoint with candidate version binding', () => {
    const router = createChatBiBffRouter()
    const ambiguous = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_clarify' },
      body: submitBody('最近销售情况怎么样', 'conversation_clarify'),
    })
    expect(ambiguous.status).toBe(200)
    const ambiguousData = (ambiguous.body as {
      data: {
        runId: string
        conversationId: string
        displayStatus: string
        clarification: { candidates: Array<{ id: string; candidateVersion: string }> }
      }
    }).data
    expect(ambiguousData.displayStatus).toBe('needs_clarification')

    const candidate = ambiguousData.clarification.candidates[0]
    const clarified = router.handle({
      method: 'POST',
      path: `/v1/runs/${ambiguousData.runId}/clarify`,
      headers: actorHeaders,
      body: {
        conversation_id: ambiguousData.conversationId,
        candidate_id: candidate.id,
        candidate_version: candidate.candidateVersion,
      },
    })
    expect(clarified.status).toBe(200)
    expect(clarified.body).toMatchObject({
      ok: true,
      data: { displayStatus: 'completed', executedQuery: true },
    })
  })

  it('serves run SSE events and supports Last-Event-ID resume', () => {
    const router = createChatBiBffRouter()
    const created = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_events' },
      body: submitBody('过去 12 个月净收入趋势', 'conversation_events_api'),
    })
    const createdData = (created.body as { data: { runId: string; conversationId: string; audit: Array<{ id: string }> } }).data

    const events = router.handle({
      method: 'GET',
      path: `/v1/runs/${createdData.runId}/events`,
      headers: actorHeaders,
      query: { conversation_id: createdData.conversationId },
    })
    expect(events.status).toBe(200)
    expect(events.headers['content-type']).toContain('text/event-stream')
    expect(events.body).toContain('event: run.snapshot')
    expect(events.body).toContain('event: run.result_ready')

    const resumed = router.handle({
      method: 'GET',
      path: `/v1/runs/${createdData.runId}/events`,
      headers: { ...actorHeaders, 'last-event-id': createdData.audit[0].id },
      query: { conversation_id: createdData.conversationId },
    })
    expect(resumed.status).toBe(200)
    expect(String(resumed.body)).not.toContain(`id: ${createdData.audit[0].id}`)
  })

  it('keeps event streams behind the same workspace boundary', () => {
    const router = createChatBiBffRouter()
    const created = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_events_boundary' },
      body: submitBody('过去 12 个月净收入趋势', 'conversation_events_boundary'),
    })
    const createdData = (created.body as { data: { runId: string; conversationId: string } }).data

    const denied = router.handle({
      method: 'GET',
      path: `/v1/runs/${createdData.runId}/events`,
      headers: { ...actorHeaders, 'x-workspace-id': 'other_workspace' },
      query: { conversation_id: createdData.conversationId },
    })
    expect(denied.status).toBe(403)
    expect(denied.headers['content-type']).toContain('application/json')
  })

  it('uses 409 for active run and invalid cancel states', () => {
    const router = createChatBiBffRouter()
    const ambiguous = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_active' },
      body: submitBody('最近销售情况怎么样', 'conversation_active'),
    })
    expect(ambiguous.status).toBe(200)

    const blocked = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_blocked' },
      body: submitBody('过去 12 个月净收入趋势', 'conversation_active'),
    })
    expect(blocked.status).toBe(409)

    const completed = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'api_done' },
      body: submitBody('过去 12 个月净收入趋势', 'conversation_done'),
    })
    const completedData = (completed.body as { data: { runId: string; conversationId: string } }).data
    const cancelCompleted = router.handle({
      method: 'POST',
      path: `/v1/runs/${completedData.runId}/cancel`,
      headers: actorHeaders,
      body: { conversation_id: completedData.conversationId },
    })
    expect(cancelCompleted.status).toBe(409)
  })

  it('supports CORS preflight and path normalization', () => {
    const router = createChatBiBffRouter()
    expect(normalizePath('/v1/questions?x=1')).toBe('/v1/questions')
    expect(normalizePath('/v1/questions/')).toBe('/v1/questions')

    const preflight = router.handle({ method: 'OPTIONS', path: '/v1/questions' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-methods']).toContain('POST')
  })

  it('keeps the default demo actor compatible with the application service contract', () => {
    const router = createChatBiBffRouter()
    const response = router.service.submitQuestion({
      idempotencyKey: 'direct_service_contract',
      conversationId: 'conversation_actor',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    expect(response.ok).toBe(true)
  })
})
