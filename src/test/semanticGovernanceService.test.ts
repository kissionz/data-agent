import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createSemanticGovernanceApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const metricAdmin: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_metric_admin',
  roles: ['metric_admin'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const adminHeaders = {
  'x-tenant-id': metricAdmin.tenantId,
  'x-workspace-id': metricAdmin.workspaceId,
  'x-user-id': metricAdmin.userId,
  'x-user-roles': metricAdmin.roles.join(','),
  'x-business-domain-id': metricAdmin.businessDomainId,
  'x-semantic-version': metricAdmin.semanticVersion,
}

describe('Semantic governance service', () => {
  it('lists governed metrics with dimensions, join graph and release readiness', () => {
    const service = createSemanticGovernanceApplicationService({ now: () => '2026-06-24T11:00:00+08:00' })
    const response = service.listMetrics({ actor: metricAdmin, lifecycle: 'all', query: '收入' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.total).toBe(1)
    expect(response.data.metrics[0]).toMatchObject({
      id: 'net_revenue',
      contractVersion: 'chatbi.contracts.v0.2',
      lifecycle: 'certified',
      immutableVersion: true,
      canUseInTrustedMode: true,
    })
    expect(response.data.dimensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'region', requiresJoin: 'orders_region' }),
    ]))
    expect(response.data.joinGraph).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'orders_product_line', risk: 'high', approved: false }),
    ]))
  })

  it('submits draft metrics for review and requires reference SQL reconciliation before certification', () => {
    const service = createSemanticGovernanceApplicationService({ now: () => '2026-06-24T11:01:00+08:00' })
    const submitted = service.submitForReview({ actor: metricAdmin, metricId: 'refund_rate', note: '补充退款口径评审' })

    expect(submitted.ok).toBe(true)
    if (!submitted.ok) return
    expect(submitted.data).toMatchObject({
      id: 'refund_rate',
      lifecycle: 'review',
      canUseInTrustedMode: false,
    })
    expect(submitted.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'semantic.metric_submitted' }),
    ]))

    const blocked = service.certifyMetric({
      actor: metricAdmin,
      metricId: 'refund_rate',
      note: '尝试发布',
      referenceSqlReconciled: false,
    })
    expect(blocked.ok).toBe(false)
    if (blocked.ok) return
    expect(blocked.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '参考 SQL 对账未通过，不能认证发布',
    })

    const certified = service.certifyMetric({
      actor: metricAdmin,
      metricId: 'refund_rate',
      note: '参考 SQL 已对齐',
      referenceSqlReconciled: true,
    })
    expect(certified.ok).toBe(true)
    if (!certified.ok) return
    expect(certified.data).toMatchObject({
      lifecycle: 'certified',
      canUseInTrustedMode: true,
      releaseReadiness: {
        referenceSqlReconciled: true,
        approvedJoinGraph: true,
        certifiedBy: 'user_metric_admin',
      },
    })
  })

  it('rejects lifecycle changes from ordinary business users', () => {
    const service = createSemanticGovernanceApplicationService()
    const response = service.submitForReview({
      actor: { ...metricAdmin, userId: 'user_business', roles: ['business_user'] },
      metricId: 'refund_rate',
      note: '普通用户尝试提交',
    })

    expect(response.ok).toBe(false)
    if (response.ok) return
    expect(response.error).toMatchObject({
      code: 'PERMISSION_DENIED',
      message: '无权提交语义指标评审',
    })
  })

  it('blocks certification when compatible dimensions require an unapproved high-risk Join Graph path', () => {
    const service = createSemanticGovernanceApplicationService()
    const submitted = service.submitForReview({ actor: metricAdmin, metricId: 'refund_rate', note: '进入评审' })
    expect(submitted.ok).toBe(true)
    const response = service.certifyMetric({
      actor: metricAdmin,
      metricId: 'refund_rate',
      note: '发布',
      referenceSqlReconciled: true,
    })

    // refund_rate only depends on approved dimensions, so use product_line readiness through net_revenue detail.
    expect(response.ok).toBe(true)
    const risky = service.getMetric({ actor: metricAdmin, metricId: 'net_revenue' })
    expect(risky.ok).toBe(true)
    if (!risky.ok) return
    expect(risky.data.releaseReadiness.blockingReasons).toEqual(expect.arrayContaining([
      expect.stringContaining('orders_product_line'),
    ]))
  })

  it('exposes semantic governance routes through the BFF', () => {
    const router = createChatBiBffRouter()
    const listed = router.handle({
      method: 'GET',
      path: '/v1/semantic/metrics',
      headers: adminHeaders,
      query: { lifecycle: 'draft' },
    })
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        metrics: [expect.objectContaining({ id: 'refund_rate', lifecycle: 'draft' })],
      },
    })

    const submitted = router.handle({
      method: 'POST',
      path: '/v1/semantic/metrics/refund_rate/submit-review',
      headers: adminHeaders,
      body: { note: '提交评审' },
    })
    expect(submitted.status).toBe(200)
    expect(submitted.body).toMatchObject({ ok: true, data: { id: 'refund_rate', lifecycle: 'review' } })

    const certified = router.handle({
      method: 'POST',
      path: '/v1/semantic/metrics/refund_rate/certify',
      headers: adminHeaders,
      body: { note: '对账通过', reference_sql_reconciled: true },
    })
    expect(certified.status).toBe(200)
    expect(certified.body).toMatchObject({
      ok: true,
      data: {
        id: 'refund_rate',
        lifecycle: 'certified',
        canUseInTrustedMode: true,
      },
    })
  })
})
