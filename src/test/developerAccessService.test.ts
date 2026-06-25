import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createDeveloperAccessApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const opsActor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_ops',
  roles: ['platform_ops', 'analyst'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  policyVersion: 'policy-2026.06.7',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const businessActor: ActorContext = {
  ...opsActor,
  userId: 'user_lin',
  roles: ['business_user'],
}

const opsHeaders = {
  'x-tenant-id': opsActor.tenantId,
  'x-workspace-id': opsActor.workspaceId,
  'x-user-id': opsActor.userId,
  'x-user-roles': opsActor.roles.join(','),
  'x-business-domain-id': opsActor.businessDomainId,
  'x-semantic-version': opsActor.semanticVersion,
  'x-policy-version': opsActor.policyVersion!,
}

const businessHeaders = {
  ...opsHeaders,
  'x-user-id': businessActor.userId,
  'x-user-roles': businessActor.roles.join(','),
}

describe('Developer access service', () => {
  it('creates workspace-scoped service accounts only for platform operators or security admins', () => {
    const service = createDeveloperAccessApplicationService({ now: () => '2026-06-24T16:00:00+08:00' })
    const denied = service.createServiceAccount({
      actor: businessActor,
      name: 'BI Embed Host',
      scopes: ['runs:read', 'embed:issue'],
      expiresInDays: 90,
      dailyRequestLimit: 1000,
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED')

    const created = service.createServiceAccount({
      actor: opsActor,
      name: 'BI Embed Host',
      scopes: ['runs:read', 'embed:issue', 'webhooks:manage'],
      expiresInDays: 90,
      dailyRequestLimit: 1000,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data).toMatchObject({
      contractVersion: 'chatbi.contracts.v0.2',
      name: 'BI Embed Host',
      status: 'active',
      workspaceId: 'workspace_sales',
      businessDomainId: 'sales',
      quota: {
        dailyRequestLimit: 1000,
        dailyRequestUsed: 0,
      },
      createdBy: 'user_ops',
    })
    expect(created.data.scopes).toEqual(['runs:read', 'embed:issue', 'webhooks:manage'])
    expect(created.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'developer.service_account_created' }),
    ]))
  })

  it('issues and revokes API keys without exposing reusable plaintext secrets', () => {
    const service = createDeveloperAccessApplicationService({ now: () => '2026-06-24T16:01:00+08:00' })
    const account = service.createServiceAccount({
      actor: opsActor,
      name: 'Operations SDK',
      scopes: ['questions:write', 'runs:read', 'semantic:read'],
      expiresInDays: 120,
      dailyRequestLimit: 5000,
    })
    expect(account.ok).toBe(true)
    if (!account.ok) return

    const issued = service.issueApiKey({
      actor: opsActor,
      serviceAccountId: account.data.id,
      expiresInDays: 30,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    expect(issued.data).toMatchObject({
      serviceAccountId: account.data.id,
      status: 'active',
      scopes: ['questions:write', 'runs:read', 'semantic:read'],
      prefix: expect.stringMatching(/^ifk_live_/),
      secretPreview: expect.stringContaining('redacted'),
      secretHash: expect.stringMatching(/^sha256:/),
    })
    expect(JSON.stringify(issued.data)).not.toMatch(/sk-|plain|password|token_secret/i)

    const revoked = service.revokeApiKey({
      actor: opsActor,
      keyId: issued.data.id,
      reason: 'rotation',
    })
    expect(revoked.ok).toBe(true)
    if (!revoked.ok) return
    expect(revoked.data.status).toBe('revoked')
    expect(revoked.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'developer.api_key_revoked' }),
    ]))
  })

  it('verifies API keys into scoped service-account actors and increments quota', () => {
    const now = '2026-06-24T16:01:00+08:00'
    const service = createDeveloperAccessApplicationService({ now: () => now })
    const account = service.createServiceAccount({
      actor: opsActor,
      name: 'Operations SDK',
      scopes: ['questions:write', 'runs:read'],
      expiresInDays: 120,
      dailyRequestLimit: 2,
    })
    expect(account.ok).toBe(true)
    if (!account.ok) return
    const issued = service.issueApiKey({
      actor: opsActor,
      serviceAccountId: account.data.id,
      expiresInDays: 30,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return

    const verified = service.verifyApiKey({
      presentedSecret: mockIssuedSecret('ifk_live', issued.data.id, 5),
      requiredScopes: ['questions:write'],
      workspaceId: 'workspace_sales',
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.data).toMatchObject({
      authenticated: true,
      keyId: issued.data.id,
      serviceAccountId: account.data.id,
      actor: {
        userId: account.data.id,
        roles: ['service_account'],
        workspaceId: 'workspace_sales',
        businessDomainId: 'sales',
      },
      quota: {
        dailyRequestLimit: 2,
        dailyRequestUsed: 1,
      },
      cannotAccessDatabaseCredentials: true,
    })
    expect(verified.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'developer.api_key_verified' }),
    ]))
    expect(JSON.stringify(verified.data)).not.toMatch(/database_password|credential_secret|presentedSecret/i)
  })

  it('rejects API keys with missing scopes, revoked status, quota exhaustion or boundary mismatch', () => {
    const now = '2026-06-24T16:01:00+08:00'
    const service = createDeveloperAccessApplicationService({ now: () => now })
    const account = service.createServiceAccount({
      actor: opsActor,
      name: 'Read Only SDK',
      scopes: ['runs:read'],
      expiresInDays: 120,
      dailyRequestLimit: 1,
    })
    expect(account.ok).toBe(true)
    if (!account.ok) return
    const issued = service.issueApiKey({
      actor: opsActor,
      serviceAccountId: account.data.id,
      expiresInDays: 30,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    const secret = mockIssuedSecret('ifk_live', issued.data.id, 5)

    const missingScope = service.verifyApiKey({
      presentedSecret: secret,
      requiredScopes: ['questions:write'],
      workspaceId: 'workspace_sales',
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(missingScope.ok).toBe(false)
    if (!missingScope.ok) expect(missingScope.error.code).toBe('PERMISSION_DENIED')

    const boundary = service.verifyApiKey({
      presentedSecret: secret,
      requiredScopes: ['runs:read'],
      workspaceId: 'workspace_growth',
      businessDomainId: 'growth',
      semanticVersion: 'sales-semantic-2026.06.1',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(boundary.ok).toBe(false)
    if (!boundary.ok) expect(boundary.error.code).toBe('PERMISSION_DENIED')

    const firstAllowed = service.verifyApiKey({
      presentedSecret: secret,
      requiredScopes: ['runs:read'],
      workspaceId: 'workspace_sales',
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(firstAllowed.ok).toBe(true)
    const exhausted = service.verifyApiKey({
      presentedSecret: secret,
      requiredScopes: ['runs:read'],
      workspaceId: 'workspace_sales',
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(exhausted.ok).toBe(false)
    if (!exhausted.ok) expect(exhausted.error.code).toBe('QUERY_TOO_EXPENSIVE')

    const revokedService = createDeveloperAccessApplicationService({ now: () => now })
    const revokedAccount = revokedService.createServiceAccount({
      actor: opsActor,
      name: 'Revoked SDK',
      scopes: ['runs:read'],
      expiresInDays: 120,
      dailyRequestLimit: 5,
    })
    expect(revokedAccount.ok).toBe(true)
    if (!revokedAccount.ok) return
    const revokedIssued = revokedService.issueApiKey({ actor: opsActor, serviceAccountId: revokedAccount.data.id, expiresInDays: 30 })
    expect(revokedIssued.ok).toBe(true)
    if (!revokedIssued.ok) return
    revokedService.revokeApiKey({ actor: opsActor, keyId: revokedIssued.data.id, reason: 'rotation' })
    const revoked = revokedService.verifyApiKey({
      presentedSecret: mockIssuedSecret('ifk_live', revokedIssued.data.id, 5),
      requiredScopes: ['runs:read'],
      workspaceId: 'workspace_sales',
      businessDomainId: 'sales',
      semanticVersion: 'sales-semantic-2026.06.1',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
    })
    expect(revoked.ok).toBe(false)
    if (!revoked.ok) expect(revoked.error.code).toBe('PERMISSION_DENIED')
  })

  it('registers HTTPS webhooks with signing, replay protection, retry and dead-letter policy', () => {
    const service = createDeveloperAccessApplicationService({ now: () => '2026-06-24T16:02:00+08:00' })
    const insecure = service.registerWebhook({
      actor: opsActor,
      url: 'http://example.com/webhook',
      events: ['run.completed'],
    })
    expect(insecure.ok).toBe(false)
    if (!insecure.ok) expect(insecure.error.code).toBe('VALIDATION_FAILED')

    const registered = service.registerWebhook({
      actor: opsActor,
      url: 'https://example.com/chatbi/webhook',
      events: ['run.completed', 'export.completed'],
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return
    expect(registered.data).toMatchObject({
      status: 'active',
      signingAlgorithm: 'hmac-sha256',
      replayProtectionSeconds: 300,
      retryPolicy: {
        maxAttempts: 5,
        backoff: 'exponential',
        deadLetterAfterAttempts: 5,
      },
      deliversOnlyAuthorizedData: true,
      secretPreview: expect.stringContaining('redacted'),
    })

    const tested = service.testWebhook({ actor: opsActor, webhookId: registered.data.id })
    expect(tested.ok).toBe(true)
    if (!tested.ok) return
    expect(tested.data.lastTest).toMatchObject({
      status: 'accepted',
      httpStatus: 202,
      signatureVerified: true,
    })
  })

  it('plans signed webhook deliveries with retry and dead-letter semantics', () => {
    const service = createDeveloperAccessApplicationService({ now: () => '2026-06-24T16:04:00+08:00' })
    const registered = service.registerWebhook({
      actor: opsActor,
      url: 'https://example.com/chatbi/webhook',
      events: ['run.completed', 'export.completed'],
    })
    expect(registered.ok).toBe(true)
    if (!registered.ok) return

    const accepted = service.planWebhookDelivery({
      actor: opsActor,
      webhookId: registered.data.id,
      event: 'run.completed',
      payload: { runId: 'run_001', status: 'completed', secret: 'must-not-leak' },
      simulatedHttpStatuses: [500, 202],
    })
    expect(accepted.ok).toBe(true)
    if (!accepted.ok) return
    expect(accepted.data).toMatchObject({
      finalState: 'accepted',
      signingAlgorithm: 'hmac-sha256',
      headers: {
        'x-insightflow-event': 'run.completed',
        'x-insightflow-signature': expect.stringMatching(/^sha256:/),
      },
      replayProtectionExpiresAt: '2026-06-24T08:09:00.000Z',
      payloadRedacted: true,
      deliversOnlyAuthorizedData: true,
      attempts: [
        expect.objectContaining({ attempt: 1, httpStatus: 500, result: 'retry_scheduled' }),
        expect.objectContaining({ attempt: 2, httpStatus: 202, result: 'accepted' }),
      ],
    })
    expect(JSON.stringify(accepted.data)).not.toContain('must-not-leak')

    const deadLettered = service.planWebhookDelivery({
      actor: opsActor,
      webhookId: registered.data.id,
      event: 'export.completed',
      payload: { exportId: 'export_001' },
      simulatedHttpStatuses: [500, 502, 503, 504, 500],
    })
    expect(deadLettered.ok).toBe(true)
    if (!deadLettered.ok) return
    expect(deadLettered.data).toMatchObject({
      finalState: 'dead_lettered',
      deadLetter: {
        reason: '连续投递失败，进入死信队列。',
        afterAttempts: 5,
      },
    })
    expect(deadLettered.data.attempts).toHaveLength(5)
    expect(deadLettered.data.attempts.at(-1)).toMatchObject({ result: 'dead_lettered' })
    expect(deadLettered.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'developer.webhook_delivery_planned' }),
    ]))

    const notSubscribed = service.planWebhookDelivery({
      actor: opsActor,
      webhookId: registered.data.id,
      event: 'asset.updated',
      payload: { assetId: 'asset_001' },
    })
    expect(notSubscribed.ok).toBe(false)
    if (!notSubscribed.ok) expect(notSubscribed.error.code).toBe('VALIDATION_FAILED')
  })

  it('issues short-lived embed tokens without database credential access', () => {
    const service = createDeveloperAccessApplicationService({ now: () => '2026-06-24T16:03:00+08:00' })
    const invalid = service.issueEmbedToken({
      actor: businessActor,
      hostOrigin: 'http://portal.example.com',
      source: { type: 'asset', assetId: 'asset_revenue_trend' },
      expiresInMinutes: 30,
    })
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.code).toBe('VALIDATION_FAILED')

    const issued = service.issueEmbedToken({
      actor: businessActor,
      hostOrigin: 'https://portal.example.com',
      source: { type: 'asset', assetId: 'asset_revenue_trend' },
      expiresInMinutes: 30,
    })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    expect(issued.data).toMatchObject({
      hostOrigin: 'https://portal.example.com',
      scopes: ['assets:read'],
      policyVersion: 'policy-2026.06.7',
      cannotAccessDatabaseCredentials: true,
      tokenPreview: expect.stringContaining('redacted'),
    })
    expect(JSON.stringify(issued.data)).not.toMatch(/password|credential_secret|token_secret/i)
  })

  it('exposes developer access routes through the BFF router', () => {
    const router = createChatBiBffRouter()
    const denied = router.handle({
      method: 'POST',
      path: '/v1/developer/service-accounts',
      headers: businessHeaders,
      body: {
        name: 'Denied SA',
        scopes: ['runs:read'],
        expires_in_days: 30,
        daily_request_limit: 1000,
      },
    })
    expect(denied.status).toBe(403)

    const account = router.handle({
      method: 'POST',
      path: '/v1/developer/service-accounts',
      headers: opsHeaders,
      body: {
        name: 'BI Embed Host',
        scopes: ['runs:read', 'embed:issue', 'webhooks:manage'],
        expires_in_days: 90,
        daily_request_limit: 1000,
      },
    })
    expect(account.status).toBe(200)
    const accountData = (account.body as { data: { id: string } }).data

    const key = router.handle({
      method: 'POST',
      path: '/v1/developer/api-keys',
      headers: opsHeaders,
      body: {
        service_account_id: accountData.id,
        expires_in_days: 30,
      },
    })
    expect(key.status).toBe(200)
    expect(key.body).toMatchObject({
      ok: true,
      data: {
        serviceAccountId: accountData.id,
        secretPreview: expect.stringContaining('redacted'),
      },
    })

    const webhook = router.handle({
      method: 'POST',
      path: '/v1/developer/webhooks',
      headers: opsHeaders,
      body: {
        url: 'https://example.com/chatbi/webhook',
        events: ['run.completed'],
      },
    })
    expect(webhook.status).toBe(200)
    const webhookData = (webhook.body as { data: { id: string } }).data
    const tested = router.handle({
      method: 'POST',
      path: `/v1/developer/webhooks/${webhookData.id}/test`,
      headers: opsHeaders,
    })
    expect(tested.status).toBe(200)
    expect(tested.body).toMatchObject({
      ok: true,
      data: { lastTest: { signatureVerified: true } },
    })

    const delivery = router.handle({
      method: 'POST',
      path: `/v1/developer/webhooks/${webhookData.id}/deliveries`,
      headers: opsHeaders,
      body: {
        event: 'run.completed',
        payload: {
          runId: 'run_demo',
          resultUrl: 'https://app.example.com/runs/run_demo',
          secret_note: 'must not be echoed',
        },
        simulated_http_statuses: [503, 202],
      },
    })
    expect(delivery.status).toBe(200)
    expect(delivery.body).toMatchObject({
      ok: true,
      data: {
        webhookId: webhookData.id,
        finalState: 'accepted',
        signingAlgorithm: 'hmac-sha256',
        payloadRedacted: true,
        deliversOnlyAuthorizedData: true,
        attempts: [
          expect.objectContaining({ httpStatus: 503, result: 'retry_scheduled' }),
          expect.objectContaining({ httpStatus: 202, result: 'accepted' }),
        ],
      },
    })
    expect(JSON.stringify(delivery.body)).not.toContain('must not be echoed')

    const embed = router.handle({
      method: 'POST',
      path: '/v1/developer/embed-tokens',
      headers: businessHeaders,
      body: {
        host_origin: 'https://portal.example.com',
        source: { type: 'asset', assetId: 'asset_revenue_trend' },
        expires_in_minutes: 30,
      },
    })
    expect(embed.status).toBe(200)
    expect(embed.body).toMatchObject({
      ok: true,
      data: {
        cannotAccessDatabaseCredentials: true,
        scopes: ['assets:read'],
      },
    })
  })
})

function mockIssuedSecret(prefix: string, id: string, sequence: number) {
  return `${prefix}_${id}_${sequence}`
}
