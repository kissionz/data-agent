import { describe, expect, it } from 'vitest'
import { createApiRuntime, createApiRuntimeConfig } from '../../apps/api/src'

const actorHeaders = {
  'x-tenant-id': 'tenant_demo',
  'x-workspace-id': 'workspace_sales',
  'x-user-id': 'user_lin',
  'x-business-domain-id': 'sales',
  'x-semantic-version': 'sales-semantic-2026.06.1',
}

describe('apps/api runtime boundary', () => {
  it('creates validated runtime config with production auth defaults', () => {
    const config = createApiRuntimeConfig({ environment: 'production', port: '9090', corsAllowOrigin: 'https://example.com' })

    expect(config).toMatchObject({
      serviceName: 'insightflow-chatbi-api',
      environment: 'production',
      port: 9090,
      authMode: 'required_header_actor',
      cors: { allowOrigin: 'https://example.com' },
    })
    expect(() => createApiRuntimeConfig({ port: '0' })).toThrow('API port')
  })

  it('serves readiness and requires actor headers for v1 routes when auth is enabled', () => {
    const runtime = createApiRuntime({ environment: 'production' })

    const ready = runtime.handle({ method: 'GET', path: '/readyz' })
    expect(ready).toMatchObject({
      status: 200,
      body: {
        ok: true,
        checks: {
          persistence: 'ok',
          router: 'ok',
          auth: 'required_header_actor',
        },
      },
    })

    const unauthorized = runtime.handle({
      method: 'POST',
      path: '/v1/questions',
      body: {
        conversation_id: 'conversation_api_runtime',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.body).toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: '缺少认证上下文',
      },
    })

    const authorized = runtime.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'runtime_authorized' },
      body: {
        conversation_id: 'conversation_api_runtime',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })
    expect(authorized.status).toBe(200)
    expect(authorized.body).toMatchObject({ ok: true, data: { displayStatus: 'completed' } })
  })

  it('can use file persistence across runtime instances', () => {
    const filePath = `/private/tmp/chatbi-api-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    const first = createApiRuntime({
      environment: 'test',
      authMode: 'required_header_actor',
      persistenceMode: 'file',
      persistenceFilePath: filePath,
    })
    const created = first.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'runtime_file' },
      body: {
        conversation_id: 'conversation_file_runtime',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })
    expect(created.status).toBe(200)
    const data = (created.body as { data: { runId: string; conversationId: string } }).data

    const second = createApiRuntime({
      environment: 'test',
      authMode: 'required_header_actor',
      persistenceMode: 'file',
      persistenceFilePath: filePath,
    })
    const snapshot = second.handle({
      method: 'GET',
      path: `/v1/runs/${data.runId}`,
      headers: actorHeaders,
      query: { conversation_id: data.conversationId },
    })

    expect(snapshot.status).toBe(200)
    expect(snapshot.body).toMatchObject({ ok: true, data: { runId: data.runId } })
  })
})

