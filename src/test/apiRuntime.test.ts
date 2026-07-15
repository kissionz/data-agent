import { describe, expect, it, vi } from 'vitest'
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

  it('keeps PostgreSQL credentials behind a server-side reference and validates cancellation capacity', () => {
    const config = createApiRuntimeConfig({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      queryPoolMax: '4',
      queryStatementTimeoutMs: '12000',
    })

    expect(config.query).toEqual(expect.objectContaining({
      mode: 'postgresql',
      credentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      poolMax: 4,
      statementTimeoutMs: 12_000,
    }))
    expect(JSON.stringify(config.query)).not.toContain('postgresql://')
    expect(() => createApiRuntimeConfig({ queryMode: 'postgresql' })).toThrow('credential reference')
    expect(() => createApiRuntimeConfig({
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      queryPoolMax: 1,
    })).toThrow('at least 2')
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

  it('runs the production PostgreSQL mode through the queued worker and real-result mapper', async () => {
    const runtime = createApiRuntime({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
    }, {
      queryAdapter: {
        dialect: 'postgresql',
        readiness: vi.fn(async () => ({ ok: true as const })),
        runReadOnly: vi.fn(async () => ({
          status: 'executed' as const,
          explain: {
            estimatedRows: 1,
            estimatedScanBytes: 512,
            costUnits: 2.5,
            checkedAt: '2026-07-15T12:00:00.000Z',
          },
          fields: [
            { name: 'order_date', databaseType: '1082' },
            { name: 'net_revenue', databaseType: '1700' },
          ],
          rows: [{ order_date: '2026-06-01T00:00:00.000Z', net_revenue: '1326000.00' }],
          rowCount: 1,
          truncated: false,
        })),
        close: vi.fn(async () => undefined),
      },
    })
    await runtime.checkReadiness()
    expect(runtime.handle({ method: 'GET', path: '/readyz' })).toMatchObject({
      status: 200,
      body: { ok: true, checks: { query: 'ok' } },
    })

    const created = runtime.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...actorHeaders, 'idempotency-key': 'runtime_postgres_worker' },
      body: {
        conversation_id: 'conversation_runtime_postgres',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })
    expect(created).toMatchObject({
      status: 202,
      body: { ok: true, data: { displayStatus: 'querying', queryExecution: { status: 'queued' } } },
    })
    const data = (created.body as { data: { runId: string; conversationId: string } }).data
    await expect(runtime.runQueryWorkerOnce()).resolves.toMatchObject({ status: 'completed' })
    const completed = runtime.handle({
      method: 'GET',
      path: `/v1/runs/${data.runId}`,
      headers: actorHeaders,
      query: { conversation_id: data.conversationId },
    })
    expect(completed).toMatchObject({
      status: 200,
      body: {
        ok: true,
        data: {
          displayStatus: 'completed',
          executedQuery: true,
          result: { answer: { generatedFrom: 'query_result' } },
        },
      },
    })
    await runtime.close()
  })

  it('reports PostgreSQL readiness failure without exposing credentials', async () => {
    const runtime = createApiRuntime({
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
    }, {
      queryAdapter: {
        dialect: 'postgresql',
        readiness: async () => { throw new Error('postgresql://secret@host/db') },
        runReadOnly: async () => { throw new Error('not expected') },
      },
    })
    await runtime.checkReadiness()
    const ready = runtime.handle({ method: 'GET', path: '/readyz' })
    expect(ready).toMatchObject({ status: 503, body: { ok: false, checks: { query: 'failed' } } })
    expect(JSON.stringify(ready.body)).not.toContain('postgresql://')
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

  it('accepts API Key bearer auth by verifying it into a service-account actor', () => {
    const runtime = createApiRuntime({ environment: 'production' })
    const issued = issueRuntimeApiKey(runtime, ['questions:write', 'runs:read'], 10)

    const created = runtime.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: {
        authorization: `Bearer ${issued.secret}`,
        'idempotency-key': 'runtime_api_key',
      },
      body: {
        conversation_id: 'conversation_runtime_api_key',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })

    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({
      ok: true,
      data: {
        displayStatus: 'completed',
        audit: expect.arrayContaining([
          expect.objectContaining({ actorUserId: issued.serviceAccountId }),
        ]),
      },
    })
  })

  it('rejects API Key bearer auth when the endpoint scope is missing', () => {
    const runtime = createApiRuntime({ environment: 'production' })
    const issued = issueRuntimeApiKey(runtime, ['runs:read'], 10)

    const response = runtime.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: {
        authorization: `Bearer ${issued.secret}`,
        'idempotency-key': 'runtime_api_key_missing_scope',
      },
      body: {
        conversation_id: 'conversation_runtime_api_key_missing_scope',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })

    expect(response.status).toBe(403)
    expect(response.body).toMatchObject({
      ok: false,
      error: {
        code: 'PERMISSION_DENIED',
      },
    })
  })
})

function issueRuntimeApiKey(runtime: ReturnType<typeof createApiRuntime>, scopes: string[], dailyRequestLimit: number) {
  const account = runtime.router.developer.createServiceAccount({
    actor: {
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      userId: 'user_ops',
      roles: ['platform_ops'],
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      policyVersion: 'policy-2026.06.7',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    },
    name: 'Runtime API Key',
    scopes: scopes as never,
    expiresInDays: 30,
    dailyRequestLimit,
  })
  if (!account.ok) throw new Error('expected service account')
  const key = runtime.router.developer.issueApiKey({
    actor: {
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      userId: 'user_ops',
      roles: ['platform_ops'],
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      policyVersion: 'policy-2026.06.7',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    },
    serviceAccountId: account.data.id,
    expiresInDays: 30,
  })
  if (!key.ok) throw new Error('expected api key')
  return {
    serviceAccountId: account.data.id,
    secret: mockIssuedSecret('ifk_live', key.data.id, 5),
  }
}

function mockIssuedSecret(prefix: string, id: string, sequence: number) {
  return `${prefix}_${id}_${sequence}`
}
