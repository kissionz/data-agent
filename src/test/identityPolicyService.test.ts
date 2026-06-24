import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createIdentityPolicyApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const businessActor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const securityActor: ActorContext = {
  ...businessActor,
  userId: 'user_sec',
  roles: ['security_admin'],
}

const businessHeaders = {
  'x-tenant-id': businessActor.tenantId,
  'x-workspace-id': businessActor.workspaceId,
  'x-user-id': businessActor.userId,
  'x-user-roles': businessActor.roles.join(','),
  'x-business-domain-id': businessActor.businessDomainId,
  'x-semantic-version': businessActor.semanticVersion,
}

const securityHeaders = {
  ...businessHeaders,
  'x-user-id': securityActor.userId,
  'x-user-roles': securityActor.roles.join(','),
}

describe('Identity policy service', () => {
  it('resolves tenant, workspace, roles, policy version and permission digest', () => {
    const service = createIdentityPolicyApplicationService({ now: () => '2026-06-24T12:00:00+08:00' })
    const context = service.getContext({ actor: businessActor })

    expect(context.ok).toBe(true)
    if (!context.ok) return
    expect(context.data).toMatchObject({
      contractVersion: 'chatbi.contracts.v0.2',
      tenant: { id: 'tenant_demo' },
      organization: { id: 'org_retail' },
      currentWorkspace: {
        id: 'workspace_sales',
        roles: ['business_user'],
        policyVersion: 'policy-2026.06.7',
      },
      policy: {
        version: 'policy-2026.06.7',
        effectiveWithinSeconds: 300,
      },
    })
    expect(context.data.availableWorkspaces).toHaveLength(1)
    expect(context.data.permissionDigest).toContain('policy-2026.06.7')
    expect(context.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'identity.context_resolved' }),
      expect.objectContaining({ type: 'identity.workspace_listed' }),
    ]))
  })

  it('denies cross-workspace access and keeps denial public-safe', () => {
    const service = createIdentityPolicyApplicationService()
    const decision = service.evaluatePolicy({
      actor: businessActor,
      action: 'read',
      resource: { type: 'workspace', workspaceId: 'workspace_growth' },
    })

    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.data).toMatchObject({
      allowed: false,
      decision: 'deny',
      reason: '用户不是目标工作空间成员。',
      policyVersion: 'policy-2026.06.7',
    })
    expect(JSON.stringify(decision.data)).not.toMatch(/workspace_sales.*workspace_growth.*secret/i)
  })

  it('denies restricted exports and includes policy version in cache scope', () => {
    const service = createIdentityPolicyApplicationService()
    const decision = service.evaluatePolicy({
      actor: businessActor,
      action: 'export',
      resource: {
        type: 'export',
        workspaceId: 'workspace_sales',
        businessDomainId: 'sales',
        classification: 'restricted',
      },
    })

    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    expect(decision.data).toMatchObject({
      allowed: false,
      decision: 'deny',
      reason: '受限数据禁止导出。',
      effectiveWithinSeconds: 300,
    })
    expect(decision.data.cacheKeyScope).toBe('tenant_demo:workspace_sales:sales:policy-2026.06.7')
    expect(decision.data.permissionDigest).toContain('business_user')
  })

  it('updates policy version only for security admins and invalidates old cache scope', () => {
    const service = createIdentityPolicyApplicationService({ now: () => '2026-06-24T12:03:00+08:00' })
    const denied = service.updatePolicy({ actor: businessActor, note: '普通用户尝试更新' })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toMatchObject({ code: 'PERMISSION_DENIED' })

    const before = service.evaluatePolicy({
      actor: securityActor,
      action: 'manage_policy',
      resource: { type: 'workspace', workspaceId: 'workspace_sales' },
    })
    expect(before.ok).toBe(true)
    const beforeScope = before.ok ? before.data.cacheKeyScope : ''

    const updated = service.updatePolicy({ actor: securityActor, note: '撤销过期导出策略' })
    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.data.policy).toMatchObject({
      version: 'policy-2026.06.8',
      updatedAt: '2026-06-24T12:03:00+08:00',
      cacheInvalidAfter: '2026-06-24T12:03:00+08:00',
      effectiveWithinSeconds: 300,
    })
    expect(updated.data.permissionDigest).toContain('policy-2026.06.8')

    const after = service.evaluatePolicy({
      actor: securityActor,
      action: 'manage_policy',
      resource: { type: 'workspace', workspaceId: 'workspace_sales' },
    })
    expect(after.ok).toBe(true)
    if (!after.ok) return
    expect(after.data.cacheKeyScope).not.toBe(beforeScope)
    expect(after.data.cacheKeyScope).toContain('policy-2026.06.8')
  })

  it('exposes identity context and policy evaluation through the BFF', () => {
    const router = createChatBiBffRouter()
    const context = router.handle({
      method: 'GET',
      path: '/v1/identity/context',
      headers: businessHeaders,
    })
    expect(context.status).toBe(200)
    expect(context.body).toMatchObject({
      ok: true,
      data: {
        currentWorkspace: { id: 'workspace_sales' },
        policy: { effectiveWithinSeconds: 300 },
      },
    })

    const exportDenied = router.handle({
      method: 'POST',
      path: '/v1/identity/policies/evaluate',
      headers: businessHeaders,
      body: {
        action: 'export',
        resource: {
          type: 'export',
          workspaceId: 'workspace_sales',
          businessDomainId: 'sales',
          classification: 'restricted',
        },
      },
    })
    expect(exportDenied.status).toBe(200)
    expect(exportDenied.body).toMatchObject({
      ok: true,
      data: {
        allowed: false,
        reason: '受限数据禁止导出。',
      },
    })

    const updated = router.handle({
      method: 'POST',
      path: '/v1/identity/policies/current',
      headers: securityHeaders,
      body: { note: '安全策略更新' },
    })
    expect(updated.status).toBe(200)
    expect(updated.body).toMatchObject({
      ok: true,
      data: {
        policy: { version: 'policy-2026.06.8' },
      },
    })
  })
})
