import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createModelOpsApplicationService } from '../application'
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

describe('Model ops service', () => {
  it('lists versioned model routes with tenant overrides, canary traffic, quota and fallback chain', () => {
    const service = createModelOpsApplicationService({ now: () => '2026-06-24T14:00:00+08:00' })
    const response = service.listRoutes({ actor: opsActor, capability: 'planner' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      total: 1,
      routes: [
        {
          contractVersion: 'chatbi.contracts.v0.2',
          id: 'route_planner',
          capability: 'planner',
          provider: 'openai',
          activeVersion: 'planner-3.2',
          candidateVersion: 'planner-3.3-rc2',
          status: 'canary',
          trafficSplit: { active: 80, candidate: 20 },
          timeoutMs: 12000,
          temperature: 0.1,
          quota: {
            tenantDailyLimit: 1000000,
            tenantUsedToday: 720000,
            workspaceDailyLimit: 300000,
            workspaceUsedToday: 180000,
          },
          tenantOverride: {
            tenantId: 'tenant_demo',
            region: 'cn',
            dataRetention: 'none',
            trainingAllowed: false,
          },
        },
      ],
    })
    expect(response.data.routes[0].fallbackChain).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'local_template', reason: 'provider_unavailable' }),
      expect.objectContaining({ provider: 'local_template', reason: 'quota_exhausted' }),
    ]))
    expect(response.data.routes[0].audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.route_evaluated' }),
    ]))
  })

  it('routes canary traffic to the candidate model when policy, provider and quota are healthy', () => {
    const service = createModelOpsApplicationService()
    const response = service.routeModel({
      actor: opsActor,
      capability: 'planner',
      estimatedTokens: 5000,
      providerAvailable: true,
      requireNoTraining: true,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      routeId: 'route_planner',
      selected: {
        provider: 'openai',
        version: 'planner-3.3-rc2',
        source: 'candidate',
      },
      status: 'routed',
      quotaRemaining: 120000,
      timeoutMs: 12000,
      temperature: 0.1,
      policyVersion: 'policy-2026.06.7',
    })
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.quota_checked' }),
      expect.objectContaining({ type: 'model.route_evaluated' }),
    ]))
  })

  it('falls back when quota is exhausted or provider is unavailable', () => {
    const service = createModelOpsApplicationService()
    const quota = service.routeModel({
      actor: opsActor,
      capability: 'planner',
      estimatedTokens: 130000,
      providerAvailable: true,
    })
    expect(quota.ok).toBe(true)
    if (quota.ok) {
      expect(quota.data).toMatchObject({
        status: 'fallback',
        selected: {
          provider: 'local_template',
          version: 'planner-budget-guard',
          source: 'fallback',
        },
      })
    }

    const provider = service.routeModel({
      actor: opsActor,
      capability: 'entity_linker',
      estimatedTokens: 1000,
      providerAvailable: false,
    })
    expect(provider.ok).toBe(true)
    if (provider.ok) {
      expect(provider.data).toMatchObject({
        status: 'fallback',
        selected: {
          provider: 'local_template',
          version: 'keyword-linker-1.0',
          source: 'fallback',
        },
      })
    }
  })

  it('blocks unreleased answer candidates behind the release gate and exposes a safe fallback', () => {
    const service = createModelOpsApplicationService()
    const response = service.routeModel({
      actor: opsActor,
      capability: 'answer',
      estimatedTokens: 1000,
      providerAvailable: true,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      routeId: 'route_answer',
      status: 'blocked',
      selected: {
        provider: 'local_template',
        version: 'grounded-answer-template-1.0',
        source: 'fallback',
      },
      reason: '候选版本被发布门禁阻断。',
    })
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.release_blocked' }),
    ]))
  })

  it('restricts model rollback to platform operators and security admins', () => {
    const service = createModelOpsApplicationService()
    const denied = service.rollbackRoute({
      actor: businessActor,
      routeId: 'route_planner',
      reason: 'ordinary users cannot rollback',
    })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.code).toBe('PERMISSION_DENIED')

    const rolledBack = service.rollbackRoute({
      actor: opsActor,
      routeId: 'route_planner',
      reason: 'P95 latency regression',
    })
    expect(rolledBack.ok).toBe(true)
    if (!rolledBack.ok) return
    expect(rolledBack.data).toMatchObject({
      id: 'route_planner',
      status: 'rolled_back',
      trafficSplit: { active: 100, candidate: 0 },
    })
    expect(rolledBack.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model.rollback_completed' }),
    ]))
  })

  it('exposes model ops contracts through the BFF router', () => {
    const router = createChatBiBffRouter()
    const listed = router.handle({
      method: 'GET',
      path: '/v1/model-ops/routes',
      headers: opsHeaders,
      query: { capability: 'planner' },
    })
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        routes: [expect.objectContaining({ id: 'route_planner' })],
      },
    })

    const routed = router.handle({
      method: 'POST',
      path: '/v1/model-ops/route',
      headers: opsHeaders,
      body: {
        capability: 'planner',
        estimated_tokens: 5000,
        provider_available: true,
      },
    })
    expect(routed.status).toBe(200)
    expect(routed.body).toMatchObject({
      ok: true,
      data: {
        status: 'routed',
        selected: { source: 'candidate' },
      },
    })

    const deniedRollback = router.handle({
      method: 'POST',
      path: '/v1/model-ops/routes/route_planner/rollback',
      headers: businessHeaders,
      body: { reason: 'try rollback' },
    })
    expect(deniedRollback.status).toBe(403)

    const rollback = router.handle({
      method: 'POST',
      path: '/v1/model-ops/routes/route_planner/rollback',
      headers: opsHeaders,
      body: { reason: 'latency regression' },
    })
    expect(rollback.status).toBe(200)
    expect(rollback.body).toMatchObject({
      ok: true,
      data: {
        status: 'rolled_back',
        trafficSplit: { active: 100, candidate: 0 },
      },
    })
  })
})
