import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type IdentityAuditEvent,
  type IdentityContextRequest,
  type IdentityContextView,
  type PolicyEvaluationRequest,
  type PolicyEvaluationView,
  type PublicApiError,
  type UpdatePolicyRequest,
  type UserRole,
  type WorkspaceView,
} from '../contracts'

export interface IdentityPolicyApplicationService {
  getContext(request: IdentityContextRequest): ApiEnvelope<IdentityContextView>
  evaluatePolicy(request: PolicyEvaluationRequest): ApiEnvelope<PolicyEvaluationView>
  updatePolicy(request: UpdatePolicyRequest): ApiEnvelope<IdentityContextView>
}

export interface IdentityPolicyApplicationOptions {
  now?: () => string
}

interface WorkspaceRecord {
  id: string
  organizationId: string
  name: string
  businessDomains: Array<{ id: string; name: string }>
  memberships: Record<string, UserRole[]>
  lastAccessedAt: string
}

const tenant = { id: 'tenant_demo', name: '演示租户' }
const organization = { id: 'org_retail', name: '零售经营组织' }
const workspaces: WorkspaceRecord[] = [
  {
    id: 'workspace_sales',
    organizationId: organization.id,
    name: '销售经营工作区',
    businessDomains: [{ id: 'sales', name: '销售经营' }, { id: 'finance', name: '财务核算' }],
    memberships: {
      user_lin: ['business_user'],
      user_metric_admin: ['metric_admin'],
      user_data_admin: ['data_admin'],
      user_ops: ['platform_ops', 'analyst'],
      user_sec: ['security_admin'],
    },
    lastAccessedAt: '2026-06-24T08:30:00+08:00',
  },
  {
    id: 'workspace_growth',
    organizationId: organization.id,
    name: '增长分析工作区',
    businessDomains: [{ id: 'growth', name: '用户增长' }],
    memberships: {
      user_ops: ['platform_ops'],
    },
    lastAccessedAt: '2026-06-20T10:00:00+08:00',
  },
]

export function createIdentityPolicyApplicationService(
  options: IdentityPolicyApplicationOptions = {},
): IdentityPolicyApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  let policySequence = 7
  let policyUpdatedAt = '2026-06-24T08:00:00+08:00'
  let cacheInvalidAfter = '2026-06-24T08:05:00+08:00'
  const auditEvents: IdentityAuditEvent[] = []

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
  }

  function policyVersion() {
    return `policy-2026.06.${policySequence}`
  }

  function requestIds() {
    return { requestId: nextId('req'), traceId: nextId('trace') }
  }

  function success<T>(data: T): ApiEnvelope<T> {
    return { ok: true, ...requestIds(), data }
  }

  function failure(error: PublicApiError): ApiEnvelope<never> {
    return { ok: false, ...requestIds(), error }
  }

  function invalidActor(request: IdentityContextRequest) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function audit(
    type: IdentityAuditEvent['type'],
    request: IdentityContextRequest,
    summary: string,
    workspaceId = request.actor.workspaceId,
  ) {
    const event: IdentityAuditEvent = {
      id: nextId('identity_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId,
      policyVersion: policyVersion(),
      summary,
    }
    auditEvents.push(event)
    return event
  }

  function visibleWorkspaces(request: IdentityContextRequest) {
    return workspaces.filter((workspace) => Boolean(workspace.memberships[request.actor.userId]))
  }

  function workspaceView(workspace: WorkspaceRecord, request: IdentityContextRequest): WorkspaceView {
    return {
      id: workspace.id,
      organizationId: workspace.organizationId,
      name: workspace.name,
      businessDomains: workspace.businessDomains,
      roles: workspace.memberships[request.actor.userId] ?? [],
      lastAccessedAt: workspace.lastAccessedAt,
      policyVersion: policyVersion(),
    }
  }

  function permissionDigest(request: IdentityContextRequest, roles = request.actor.roles) {
    return [
      request.actor.tenantId,
      request.actor.workspaceId,
      request.actor.businessDomainId,
      roles.slice().sort().join('+'),
      policyVersion(),
    ].join('|')
  }

  function contextView(request: IdentityContextRequest): IdentityContextView {
    const available = visibleWorkspaces(request)
    const current = available.find((workspace) => workspace.id === request.actor.workspaceId)
    const selected = current ?? available[0]
    const roles = selected?.memberships[request.actor.userId] ?? request.actor.roles
    return {
      contractVersion: CONTRACT_VERSION,
      actor: {
        ...request.actor,
        roles,
        workspaceId: selected?.id ?? request.actor.workspaceId,
        policyVersion: policyVersion(),
      },
      tenant,
      organization,
      currentWorkspace: selected ? workspaceView(selected, request) : {
        id: request.actor.workspaceId,
        organizationId: organization.id,
        name: '不可见工作区',
        businessDomains: [],
        roles: [],
        lastAccessedAt: '',
        policyVersion: policyVersion(),
      },
      availableWorkspaces: available.map((workspace) => workspaceView(workspace, request)),
      permissionDigest: permissionDigest(request, roles),
      policy: {
        version: policyVersion(),
        updatedAt: policyUpdatedAt,
        effectiveWithinSeconds: 300,
        cacheInvalidAfter,
      },
      audit: auditEvents,
    }
  }

  function deny(reason: string, request: PolicyEvaluationRequest): PolicyEvaluationView {
    audit('identity.permission_denied', request, reason, resourceWorkspaceId(request))
    return {
      contractVersion: CONTRACT_VERSION,
      allowed: false,
      decision: 'deny',
      reason,
      policyVersion: policyVersion(),
      permissionDigest: permissionDigest(request),
      cacheKeyScope: cacheScope(request),
      effectiveWithinSeconds: 300,
      audit: auditEvents,
    }
  }

  function allow(reason: string, request: PolicyEvaluationRequest): PolicyEvaluationView {
    audit('identity.policy_evaluated', request, reason, resourceWorkspaceId(request))
    return {
      contractVersion: CONTRACT_VERSION,
      allowed: true,
      decision: 'allow',
      reason,
      policyVersion: policyVersion(),
      permissionDigest: permissionDigest(request),
      cacheKeyScope: cacheScope(request),
      effectiveWithinSeconds: 300,
      audit: auditEvents,
    }
  }

  function resourceWorkspaceId(request: PolicyEvaluationRequest) {
    return request.resource.workspaceId
  }

  function cacheScope(request: IdentityContextRequest) {
    return `${request.actor.tenantId}:${request.actor.workspaceId}:${request.actor.businessDomainId}:${policyVersion()}`
  }

  function hasWorkspaceMembership(request: PolicyEvaluationRequest) {
    return workspaces.some((workspace) => workspace.id === request.resource.workspaceId && Boolean(workspace.memberships[request.actor.userId]))
  }

  function hasBusinessDomain(request: PolicyEvaluationRequest) {
    if (request.resource.type === 'workspace') return true
    const resource = request.resource
    return workspaces.some((workspace) => workspace.id === request.resource.workspaceId
      && workspace.businessDomains.some((domain) => domain.id === resource.businessDomainId))
  }

  return {
    getContext(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      audit('identity.context_resolved', request, '身份上下文已解析，包含策略版本和权限摘要。')
      audit('identity.workspace_listed', request, `返回 ${visibleWorkspaces(request).length} 个可访问工作空间。`)
      return success(contextView(request))
    },

    evaluatePolicy(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (request.actor.tenantId !== tenant.id) return success(deny('跨租户请求被拒绝。', request))
      if (!hasWorkspaceMembership(request)) return success(deny('用户不是目标工作空间成员。', request))
      if (!hasBusinessDomain(request)) return success(deny('业务域不可见或不存在。', request))
      if (request.action === 'manage_policy' && !request.actor.roles.includes('security_admin')) {
        return success(deny('只有安全管理员可以修改策略。', request))
      }
      if (request.action === 'export' && request.resource.type === 'export') {
        if (request.resource.classification === 'restricted') return success(deny('受限数据禁止导出。', request))
        if (request.resource.classification === 'confidential' && !request.actor.roles.some((role) => ['security_admin', 'data_admin'].includes(role))) {
          return success(deny('敏感数据导出需要数据管理员或安全管理员角色。', request))
        }
      }
      return success(allow('策略允许当前操作。', request))
    },

    updatePolicy(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!request.actor.roles.includes('security_admin')) {
        return failure({
          code: 'PERMISSION_DENIED',
          message: '只有安全管理员可以更新策略',
          retryable: false,
          debugReference: 'policy_admin_role',
        })
      }
      policySequence += 1
      policyUpdatedAt = now()
      cacheInvalidAfter = now()
      audit('identity.policy_updated', request, `策略已更新：${request.note || '无备注'}。旧缓存必须按新策略版本失效。`)
      return success(contextView(request))
    },
  }
}

export function httpStatusForIdentityEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
