import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createSharingExportApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  policyVersion: 'policy-2026.06.7',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const recipientActor: ActorContext = {
  ...actor,
  userId: 'user_metric_admin',
  roles: ['metric_admin'],
}

const dataAdminActor: ActorContext = {
  ...actor,
  userId: 'user_data_admin',
  roles: ['data_admin'],
}

const actorHeaders = {
  'x-tenant-id': actor.tenantId,
  'x-workspace-id': actor.workspaceId,
  'x-user-id': actor.userId,
  'x-user-roles': actor.roles.join(','),
  'x-business-domain-id': actor.businessDomainId,
  'x-semantic-version': actor.semanticVersion,
  'x-policy-version': actor.policyVersion!,
}

const recipientHeaders = {
  ...actorHeaders,
  'x-user-id': recipientActor.userId,
  'x-user-roles': recipientActor.roles.join(','),
}

describe('Sharing export service', () => {
  it('reauthorizes exports and returns watermark, desensitization and short-lived download metadata', () => {
    const service = createSharingExportApplicationService({ now: () => '2026-06-24T13:00:00+08:00' })
    const response = service.requestExport({
      actor: dataAdminActor,
      source: { type: 'run', runId: 'run_0001', conversationId: 'conversation_001' },
      format: 'csv',
      estimatedRows: 5000,
      estimatedBytes: 2 * 1024 * 1024,
      classification: 'confidential',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      contractVersion: 'chatbi.contracts.v0.2',
      status: 'completed',
      limits: { maxRows: 100000, maxBytes: 52428800 },
      watermark: {
        enabled: true,
        text: 'tenant_demo/workspace_sales/user_data_admin/policy-2026.06.7',
      },
      desensitization: {
        required: true,
        rules: ['mask_direct_identifiers', 'aggregate_small_groups'],
      },
      download: {
        available: true,
        signedUrlPreview: expect.stringContaining('signature=redacted'),
      },
    })
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'export.requested' }),
      expect.objectContaining({ type: 'export.completed' }),
    ]))
    expect(JSON.stringify(response.data)).not.toMatch(/password|secret|token/i)
  })

  it('blocks online exports that exceed row or byte limits', () => {
    const service = createSharingExportApplicationService({ now: () => '2026-06-24T13:01:00+08:00' })
    const response = service.requestExport({
      actor,
      source: { type: 'asset', assetId: 'asset_revenue_trend' },
      format: 'xlsx',
      estimatedRows: 100001,
      estimatedBytes: 60 * 1024 * 1024,
      classification: 'internal',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.status).toBe('blocked')
    expect(response.data.download.available).toBe(false)
    expect(response.data.blockingReasons).toEqual(expect.arrayContaining([
      '导出超过 100000 行在线上限。',
      '导出超过 50MB 在线上限。',
    ]))
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'export.blocked' }),
    ]))
  })

  it('blocks restricted exports through policy reauthorization', () => {
    const service = createSharingExportApplicationService()
    const response = service.requestExport({
      actor,
      source: { type: 'run', runId: 'run_sensitive', conversationId: 'conversation_sensitive' },
      format: 'pdf',
      estimatedRows: 10,
      estimatedBytes: 1024,
      classification: 'restricted',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      status: 'blocked',
      download: { available: false },
    })
    expect(response.data.blockingReasons).toEqual(expect.arrayContaining(['受限数据禁止导出。']))
  })

  it('creates share references without result snapshots and reauthorizes recipients', () => {
    const service = createSharingExportApplicationService({ now: () => '2026-06-24T13:02:00+08:00' })
    const created = service.createShare({
      actor,
      source: { type: 'asset', assetId: 'asset_revenue_trend' },
      scope: 'workspace',
      recipientUserIds: ['user_metric_admin'],
      expiresInDays: 7,
    })

    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect(created.data).toMatchObject({
      storesResultSnapshot: false,
      requiresRecipientReauth: true,
      policyVersion: 'policy-2026.06.7',
    })
    expect(created.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'share.created' }),
    ]))

    const allowed = service.reauthorizeShare({ actor: recipientActor, shareId: created.data.id })
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    expect(allowed.data).toMatchObject({
      allowed: true,
      decision: 'allow',
      rerunRequired: true,
    })

    const denied = service.reauthorizeShare({
      actor: { ...recipientActor, userId: 'user_outside', roles: ['business_user'] },
      shareId: created.data.id,
    })
    expect(denied.ok).toBe(true)
    if (!denied.ok) return
    expect(denied.data).toMatchObject({
      allowed: false,
      decision: 'deny',
      rerunRequired: false,
      reason: '接收者当前权限不足，不能继承分享者结果。',
    })
  })

  it('exposes sharing export routes through the BFF', () => {
    const router = createChatBiBffRouter()
    const exported = router.handle({
      method: 'POST',
      path: '/v1/sharing/exports',
      headers: actorHeaders,
      body: {
        source: { type: 'run', runId: 'run_0001', conversationId: 'conversation_001' },
        format: 'csv',
        estimated_rows: 500,
        estimated_bytes: 2048,
        classification: 'internal',
      },
    })
    expect(exported.status).toBe(200)
    expect(exported.body).toMatchObject({
      ok: true,
      data: {
        status: 'completed',
        watermark: { enabled: true },
      },
    })

    const shared = router.handle({
      method: 'POST',
      path: '/v1/sharing/shares',
      headers: actorHeaders,
      body: {
        source: { type: 'asset', assetId: 'asset_revenue_trend' },
        scope: 'workspace',
        recipient_user_ids: ['user_metric_admin'],
        expires_in_days: 7,
      },
    })
    expect(shared.status).toBe(200)
    const shareId = (shared.body as { data: { id: string } }).data.id

    const reauth = router.handle({
      method: 'POST',
      path: `/v1/sharing/shares/${shareId}/reauthorize`,
      headers: recipientHeaders,
    })
    expect(reauth.status).toBe(200)
    expect(reauth.body).toMatchObject({
      ok: true,
      data: {
        allowed: true,
        rerunRequired: true,
      },
    })
  })
})
