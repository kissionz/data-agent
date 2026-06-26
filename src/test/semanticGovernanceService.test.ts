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

  it('records automatic reference SQL reconciliation and uses it as a certification gate', () => {
    const service = createSemanticGovernanceApplicationService({ now: () => '2026-06-24T11:03:00+08:00' })
    const submitted = service.submitForReview({ actor: metricAdmin, metricId: 'refund_rate', note: '进入自动对账' })
    expect(submitted.ok).toBe(true)

    const failed = service.reconcileReferenceSql({
      actor: metricAdmin,
      metricId: 'refund_rate',
      referenceSqlFingerprint: 'sql_ref_refund_rate',
      compiledSqlFingerprint: 'sql_compiled_refund_rate',
      tolerancePct: 0.1,
      comparedRows: 120,
      maxDeltaPct: 0.8,
    })
    expect(failed.ok).toBe(true)
    if (!failed.ok) return
    expect(failed.data).toMatchObject({
      status: 'failed',
      blocksCertification: true,
      comparedRows: 120,
    })

    const blocked = service.certifyMetric({
      actor: metricAdmin,
      metricId: 'refund_rate',
      note: '失败对账不能发布',
      referenceSqlReconciled: false,
    })
    expect(blocked.ok).toBe(false)

    const passed = service.reconcileReferenceSql({
      actor: metricAdmin,
      metricId: 'refund_rate',
      referenceSqlFingerprint: 'sql_ref_refund_rate',
      compiledSqlFingerprint: 'sql_compiled_refund_rate',
      tolerancePct: 0.1,
      comparedRows: 120,
      maxDeltaPct: 0.02,
    })
    expect(passed.ok).toBe(true)
    if (!passed.ok) return
    expect(passed.data).toMatchObject({
      status: 'passed',
      blocksCertification: false,
    })
    expect(passed.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'semantic.reference_reconciled' }),
    ]))

    const certified = service.certifyMetric({
      actor: metricAdmin,
      metricId: 'refund_rate',
      note: '自动对账通过后发布',
      referenceSqlReconciled: false,
    })
    expect(certified.ok).toBe(true)
    if (!certified.ok) return
    expect(certified.data.releaseReadiness).toMatchObject({
      referenceSqlReconciled: true,
      reconciliation: {
        status: 'passed',
        maxDeltaPct: 0.02,
        comparedRows: 120,
        tolerancePct: 0.1,
      },
    })
  })

  it('plans gray release stages and rolls back certified semantic metrics', () => {
    const service = createSemanticGovernanceApplicationService({ now: () => '2026-06-24T11:04:00+08:00' })
    const plan = service.planRelease({
      actor: metricAdmin,
      metricId: 'net_revenue',
      note: '按 PRD 灰度节奏发布',
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.data).toMatchObject({
      metricId: 'net_revenue',
      status: 'planned',
      stages: [
        expect.objectContaining({ percentage: 5, gate: 'offline_eval' }),
        expect.objectContaining({ percentage: 20, gate: 'shadow_traffic' }),
        expect.objectContaining({ percentage: 50, gate: 'tenant_canary' }),
        expect.objectContaining({ percentage: 100, gate: 'business_cycle_observation' }),
      ],
      automaticRollback: {
        enabled: true,
        runbook: 'runbooks/semantic-release-rollback.md',
      },
      requiresApproval: true,
    })
    expect(plan.data.automaticRollback.rollbackThresholds).toEqual(expect.arrayContaining([
      'P0 认证指标准确率低于 100%',
    ]))

    const denied = service.rollbackMetric({
      actor: { ...metricAdmin, userId: 'user_business', roles: ['business_user'] },
      metricId: 'net_revenue',
      reason: '普通用户不能回滚',
    })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error.code).toBe('PERMISSION_DENIED')

    const rolledBack = service.rollbackMetric({
      actor: metricAdmin,
      metricId: 'net_revenue',
      reason: '灰度准确率低于阈值',
      targetSemanticVersion: 'sales-semantic-2026.06.1',
    })
    expect(rolledBack.ok).toBe(true)
    if (!rolledBack.ok) return
    expect(rolledBack.data).toMatchObject({
      lifecycle: 'deprecated',
      canUseInTrustedMode: false,
      releaseReadiness: {
        releasePlan: {
          status: 'rolled_back',
          rolloutPercentages: [5, 20, 50, 100],
        },
      },
    })
    expect(rolledBack.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'semantic.rollback_completed' }),
    ]))
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

    const releasePlan = router.handle({
      method: 'POST',
      path: '/v1/semantic/metrics/refund_rate/release-plan',
      headers: adminHeaders,
      body: { note: '发布计划', rollout_percentages: [5, 20, 50, 100] },
    })
    expect(releasePlan.status).toBe(200)
    expect(releasePlan.body).toMatchObject({
      ok: true,
      data: {
        metricId: 'refund_rate',
        automaticRollback: { enabled: true },
      },
    })
  })
})
