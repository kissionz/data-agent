import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createCollaborationAssetApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user', 'analyst'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const actorHeaders = {
  'x-tenant-id': actor.tenantId,
  'x-workspace-id': actor.workspaceId,
  'x-user-id': actor.userId,
  'x-user-roles': actor.roles.join(','),
  'x-business-domain-id': actor.businessDomainId,
  'x-semantic-version': actor.semanticVersion,
}

describe('Collaboration asset service', () => {
  it('lists visible assets with permission summaries and audit evidence', () => {
    const service = createCollaborationAssetApplicationService({ now: () => '2026-06-24T09:00:00+08:00' })
    const response = service.listAssets({ actor, status: 'active', query: '完整自然月' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.total).toBe(1)
    expect(response.data.items[0]).toMatchObject({
      id: 'asset_revenue_trend',
      contractVersion: 'chatbi.contracts.v0.2',
      permissionSummary: {
        workspaceScoped: true,
        requiresRecipientReauth: true,
        exportWatermarkRequired: true,
      },
    })
    expect(response.data.items[0].audit.some((event) => event.type === 'asset.listed')).toBe(true)
  })

  it('updates favorites and writes a durable public audit event', () => {
    const service = createCollaborationAssetApplicationService({ now: () => '2026-06-24T09:01:00+08:00' })
    const updated = service.updateFavorite({ actor, assetId: 'asset_revenue_trend', favorite: false })

    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data.isFavorite).toBe(false)
    expect(updated.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'asset.favorite_updated',
        actorUserId: 'user_lin',
        summary: '用户取消收藏协作资产。',
      }),
    ]))
  })

  it('renames active assets only for authorized collaborators', () => {
    const service = createCollaborationAssetApplicationService({ now: () => '2026-06-24T09:01:30+08:00' })
    const renamed = service.renameAsset({
      actor,
      assetId: 'asset_revenue_trend',
      title: '净收入趋势复盘（认证版）',
    })

    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return
    expect(renamed.data).toMatchObject({
      title: '净收入趋势复盘（认证版）',
      updatedAt: '2026-06-24T09:01:30+08:00',
    })
    expect(renamed.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'asset.renamed', actorUserId: 'user_lin' }),
    ]))

    const denied = service.renameAsset({
      actor: { ...actor, roles: ['business_user'] },
      assetId: 'asset_revenue_trend',
      title: '普通用户改名',
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED')

    const reviewAsset = service.renameAsset({
      actor,
      assetId: 'asset_refund_rate_review',
      title: '审核中模板改名',
    })
    expect(reviewAsset.ok).toBe(false)
    if (!reviewAsset.ok) expect(reviewAsset.error.message).toContain('仅活跃资产')
  })

  it('blocks subscriptions for review assets and records the blocked attempt', () => {
    const service = createCollaborationAssetApplicationService({ now: () => '2026-06-24T09:02:00+08:00' })
    const blocked = service.updateSubscription({ actor, assetId: 'asset_refund_rate_review', cadence: 'weekly' })

    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '审核中或已归档的资产不能订阅',
    })

    const audit = service.getAudit({ actor, assetId: 'asset_refund_rate_review' })
    expect(audit.ok).toBe(true)
    if (!audit.ok) return
    expect(audit.data.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'asset.subscription_blocked' }),
    ]))
  })

  it('plans subscription notifications with recipient reauthorization and no row payloads', () => {
    const service = createCollaborationAssetApplicationService({ now: () => '2026-06-24T09:03:00+08:00' })
    const plan = service.planNotification({ actor, assetId: 'asset_region_rank' })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data).toMatchObject({
      assetId: 'asset_region_rank',
      cadence: 'weekly',
      recipientCount: 26,
      delivery: {
        channel: 'email_digest',
        requiresRecipientReauth: true,
        payloadIncludesRows: false,
        watermarkedExportRequired: true,
      },
      guards: expect.arrayContaining(['active_asset', 'subscription_enabled', 'recipient_reauth', 'workspace_scope', 'watermark']),
      blockedReasons: [],
    })
    expect(plan.data.delivery.nextAttemptAt).toBe('2026-07-01T01:03:00.000Z')
    expect(plan.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'asset.notification_planned' }),
    ]))

    const blocked = service.planNotification({ actor, assetId: 'asset_refund_rate_review' })
    expect(blocked.ok).toBe(true)
    if (!blocked.ok) return
    expect(blocked.data.recipientCount).toBe(0)
    expect(blocked.data.blockedReasons.join(' ')).toContain('非活跃资产')
  })

  it('exposes collaboration assets through the BFF without leaking invisible assets', () => {
    const router = createChatBiBffRouter()
    const listed = router.handle({
      method: 'GET',
      path: '/v1/assets',
      headers: actorHeaders,
      query: { status: 'review' },
    })

    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [
          expect.objectContaining({
            id: 'asset_refund_rate_review',
            status: 'review',
          }),
        ],
      },
    })

    const blockedForBusinessUser = router.handle({
      method: 'GET',
      path: '/v1/assets',
      headers: { ...actorHeaders, 'x-user-id': 'user_business_only', 'x-user-roles': 'business_user' },
      query: { status: 'review' },
    })
    expect(blockedForBusinessUser.status).toBe(200)
    expect(blockedForBusinessUser.body).toMatchObject({ ok: true, data: { total: 0, items: [] } })
  })

  it('supports asset favorite, rename, subscription, notification plan and audit routes', () => {
    const router = createChatBiBffRouter()
    const favorite = router.handle({
      method: 'POST',
      path: '/v1/assets/asset_region_rank/favorite',
      headers: actorHeaders,
      body: { favorite: true },
    })
    expect(favorite.status).toBe(200)
    expect(favorite.body).toMatchObject({ ok: true, data: { id: 'asset_region_rank', isFavorite: true } })

    const rename = router.handle({
      method: 'POST',
      path: '/v1/assets/asset_region_rank/rename',
      headers: actorHeaders,
      body: { title: '区域经营周报订阅（北区）' },
    })
    expect(rename.status).toBe(200)
    expect(rename.body).toMatchObject({ ok: true, data: { title: '区域经营周报订阅（北区）' } })

    const subscription = router.handle({
      method: 'POST',
      path: '/v1/assets/asset_region_rank/subscription',
      headers: actorHeaders,
      body: { cadence: 'daily' },
    })
    expect(subscription.status).toBe(200)
    expect(subscription.body).toMatchObject({ ok: true, data: { subscriptionCadence: 'daily' } })

    const notification = router.handle({
      method: 'POST',
      path: '/v1/assets/asset_region_rank/notification-plan',
      headers: actorHeaders,
    })
    expect(notification.status).toBe(200)
    expect(notification.body).toMatchObject({
      ok: true,
      data: {
        delivery: {
          requiresRecipientReauth: true,
          payloadIncludesRows: false,
        },
      },
    })

    const audit = router.handle({
      method: 'GET',
      path: '/v1/assets/asset_region_rank/audit',
      headers: actorHeaders,
    })
    expect(audit.status).toBe(200)
    expect(audit.body).toMatchObject({
      ok: true,
      data: {
        assetId: 'asset_region_rank',
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'asset.favorite_updated' }),
          expect.objectContaining({ type: 'asset.renamed' }),
          expect.objectContaining({ type: 'asset.subscription_updated' }),
          expect.objectContaining({ type: 'asset.notification_planned' }),
          expect.objectContaining({ type: 'asset.audit_viewed' }),
        ]),
      },
    })
  })
})
