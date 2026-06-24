import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createSloApplicationService } from '../application'
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

const opsHeaders = {
  'x-tenant-id': opsActor.tenantId,
  'x-workspace-id': opsActor.workspaceId,
  'x-user-id': opsActor.userId,
  'x-user-roles': opsActor.roles.join(','),
  'x-business-domain-id': opsActor.businessDomainId,
  'x-semantic-version': opsActor.semanticVersion,
  'x-policy-version': opsActor.policyVersion!,
}

describe('SLO and performance budget service', () => {
  it('builds a deterministic SLO report with objectives, warning alerts and audit evidence', () => {
    const service = createSloApplicationService({ now: () => '2026-06-24T15:00:00+08:00' })
    const response = service.getReport({ actor: opsActor, window: '7d' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      contractVersion: 'chatbi.contracts.v0.2',
      window: '7d',
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      summary: {
        status: 'warning',
        healthy: 3,
        warning: 2,
        breach: 0,
        costPerSuccessCny: 0.084,
        p95LatencySeconds: 11.8,
        p95CancelSeconds: 2.7,
      },
    })
    expect(response.data.objectives).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: '核心问答可用性', status: 'healthy', comparator: 'gte' }),
      expect.objectContaining({ name: '常规查询 P95', status: 'healthy', target: 15 }),
      expect.objectContaining({ name: '单次成功成本', category: 'cost', status: 'warning' }),
      expect.objectContaining({ name: '取消传递 P95', category: 'cancellation', status: 'warning' }),
    ]))
    expect(response.data.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ objective: '单次成功成本', runbook: 'runbooks/model-cost.md', rollbackRequired: false }),
      expect.objectContaining({ objective: '取消传递 P95', runbook: 'runbooks/cancel-propagation.md' }),
    ]))
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'slo.report_generated' }),
    ]))
  })

  it('allows runs that stay within latency, cost and scan budgets', () => {
    const service = createSloApplicationService()
    const response = service.evaluateBudget({
      actor: opsActor,
      runId: 'RUN-ok',
      latencySeconds: 10,
      costCny: 0.05,
      scanBytes: 20_000_000,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      runId: 'RUN-ok',
      decision: 'allow',
      reasons: [],
      budgets: {
        latencySeconds: { actual: 10, target: 15, status: 'healthy' },
        costCny: { actual: 0.05, target: 0.08, status: 'healthy' },
        scanBytes: { actual: 20_000_000, target: 100_000_000, status: 'healthy' },
      },
    })
    expect(response.data.audit).toEqual([expect.objectContaining({ type: 'slo.budget_evaluated' })])
  })

  it('warns before blocking when a run exceeds soft performance budgets', () => {
    const service = createSloApplicationService()
    const response = service.evaluateBudget({
      actor: opsActor,
      runId: 'RUN-warn',
      latencySeconds: 20,
      costCny: 0.09,
      scanBytes: 150_000_000,
      cancelledPropagationSeconds: 4,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.decision).toBe('warn')
    expect(response.data.reasons.join(' ')).toContain('完整答案延迟')
    expect(response.data.reasons.join(' ')).toContain('单次成本')
    expect(response.data.reasons.join(' ')).toContain('扫描量')
    expect(response.data.reasons.join(' ')).toContain('取消传播')
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'slo.budget_evaluated' }),
      expect.objectContaining({ type: 'slo.alert_triggered' }),
    ]))
  })

  it('blocks severe performance budget breaches and keeps the decision public-safe', () => {
    const service = createSloApplicationService()
    const response = service.evaluateBudget({
      actor: opsActor,
      runId: 'RUN-block',
      latencySeconds: 61,
      costCny: 0.05,
      scanBytes: 600_000_000,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.decision).toBe('block')
    expect(response.data.budgets.latencySeconds.status).toBe('breach')
    expect(response.data.budgets.scanBytes.status).toBe('breach')
    expect(JSON.stringify(response.data)).not.toContain('SELECT')
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'slo.alert_triggered' }),
    ]))
  })

  it('validates actor context and SLO report window', () => {
    const service = createSloApplicationService()
    const invalidActor = service.getReport({
      actor: { ...opsActor, semanticVersion: '' },
      window: '7d',
    })
    expect(invalidActor.ok).toBe(false)
    if (!invalidActor.ok) expect(invalidActor.error.code).toBe('VALIDATION_FAILED')

    const invalidWindow = service.getReport({
      actor: opsActor,
      window: '1d' as never,
    })
    expect(invalidWindow.ok).toBe(false)
    if (!invalidWindow.ok) expect(invalidWindow.error.message).toContain('7d')
  })

  it('exposes SLO contracts through the BFF router and OpenAPI document', () => {
    const router = createChatBiBffRouter()
    const report = router.handle({
      method: 'GET',
      path: '/v1/operations/slo',
      headers: opsHeaders,
      query: { window: '30d' },
    })
    expect(report.status).toBe(200)
    expect(report.body).toMatchObject({
      ok: true,
      data: {
        window: '30d',
        summary: { status: 'warning' },
      },
    })

    const budget = router.handle({
      method: 'POST',
      path: '/v1/operations/slo/budget-evaluations',
      headers: opsHeaders,
      body: {
        run_id: 'RUN-router',
        latency_seconds: 61,
        cost_cny: 0.21,
        scan_bytes: 10_000_000,
      },
    })
    expect(budget.status).toBe(200)
    expect(budget.body).toMatchObject({
      ok: true,
      data: {
        runId: 'RUN-router',
        decision: 'block',
      },
    })

    const openapi = router.handle({ method: 'GET', path: '/openapi.json' })
    expect(openapi.body).toMatchObject({
      paths: {
        '/v1/operations/slo': expect.any(Object),
        '/v1/operations/slo/budget-evaluations': expect.any(Object),
      },
    })
  })
})
