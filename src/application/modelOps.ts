import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type ListModelRoutesRequest,
  type ModelCapability,
  type ModelOpsAuditEvent,
  type ModelProvider,
  type ModelRouteDecisionView,
  type ModelRouteView,
  type PublicApiError,
  type RollbackModelRouteRequest,
  type RouteModelRequest,
} from '../contracts'

export interface ModelOpsApplicationService {
  listRoutes(request: ListModelRoutesRequest): ApiEnvelope<{ routes: ModelRouteView[]; total: number }>
  routeModel(request: RouteModelRequest): ApiEnvelope<ModelRouteDecisionView>
  rollbackRoute(request: RollbackModelRouteRequest): ApiEnvelope<ModelRouteView>
}

export interface ModelOpsApplicationOptions {
  now?: () => string
}

type RouteRecord = Omit<ModelRouteView, 'contractVersion' | 'audit'>

const initialRoutes: RouteRecord[] = [
  {
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
    fallbackChain: [
      { provider: 'local_template', version: 'planner-template-1.0', reason: 'provider_unavailable' },
      { provider: 'local_template', version: 'planner-budget-guard', reason: 'quota_exhausted' },
    ],
    tenantOverride: {
      tenantId: 'tenant_demo',
      region: 'cn',
      dataRetention: 'none',
      trainingAllowed: false,
    },
  },
  {
    id: 'route_entity_linker',
    capability: 'entity_linker',
    provider: 'azure_openai',
    activeVersion: 'entity-linker-2.8',
    candidateVersion: 'entity-linker-2.9-rc1',
    status: 'canary',
    trafficSplit: { active: 95, candidate: 5 },
    timeoutMs: 6000,
    temperature: 0,
    quota: {
      tenantDailyLimit: 800000,
      tenantUsedToday: 410000,
      workspaceDailyLimit: 200000,
      workspaceUsedToday: 90000,
    },
    fallbackChain: [
      { provider: 'local_template', version: 'keyword-linker-1.0', reason: 'provider_unavailable' },
    ],
    tenantOverride: {
      tenantId: 'tenant_demo',
      region: 'cn',
      dataRetention: 'none',
      trainingAllowed: false,
    },
  },
  {
    id: 'route_answer',
    capability: 'answer',
    provider: 'anthropic',
    activeVersion: 'answer-4.1',
    candidateVersion: 'answer-4.2-rc1',
    status: 'blocked',
    trafficSplit: { active: 100, candidate: 0 },
    timeoutMs: 20000,
    temperature: 0.2,
    quota: {
      tenantDailyLimit: 600000,
      tenantUsedToday: 590000,
      workspaceDailyLimit: 200000,
      workspaceUsedToday: 198000,
    },
    fallbackChain: [
      { provider: 'local_template', version: 'grounded-answer-template-1.0', reason: 'quota_exhausted' },
      { provider: 'local_template', version: 'grounded-answer-template-1.0', reason: 'policy_blocked' },
    ],
    tenantOverride: {
      tenantId: 'tenant_demo',
      region: 'cn',
      dataRetention: 'none',
      trainingAllowed: false,
    },
  },
]

export function createModelOpsApplicationService(options: ModelOpsApplicationOptions = {}): ModelOpsApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const routes = initialRoutes.map((route) => ({ ...route, quota: { ...route.quota }, trafficSplit: { ...route.trafficSplit }, fallbackChain: route.fallbackChain.map((fallback) => ({ ...fallback })), tenantOverride: route.tenantOverride ? { ...route.tenantOverride } : undefined }))
  const auditEvents = new Map<string, ModelOpsAuditEvent[]>()

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
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

  function invalidActor(request: { actor: ListModelRoutesRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function canOperate(actor: ListModelRoutesRequest['actor']) {
    return actor.roles.some((role) => ['platform_ops', 'security_admin'].includes(role))
  }

  function audit(type: ModelOpsAuditEvent['type'], request: { actor: ListModelRoutesRequest['actor'] }, routeId: string, summary: string) {
    const event: ModelOpsAuditEvent = {
      id: nextId('model_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      routeId,
      summary,
    }
    auditEvents.set(routeId, [...(auditEvents.get(routeId) ?? []), event])
    return event
  }

  function view(route: RouteRecord): ModelRouteView {
    return {
      contractVersion: CONTRACT_VERSION,
      ...route,
      audit: auditEvents.get(route.id) ?? [],
    }
  }

  function findRoute(capability: ModelCapability) {
    return routes.find((route) => route.capability === capability)
  }

  function findFallback(
    route: RouteRecord,
    reason: 'quota_exhausted' | 'provider_unavailable' | 'policy_blocked',
  ) {
    return route.fallbackChain.find((fallback) => fallback.reason === reason) ?? route.fallbackChain[0]
  }

  function decision(
    request: RouteModelRequest,
    route: RouteRecord,
    selected: { provider: ModelProvider; version: string; source: ModelRouteDecisionView['selected']['source'] },
    status: ModelRouteDecisionView['status'],
    reason: string,
  ): ModelRouteDecisionView {
    return {
      contractVersion: CONTRACT_VERSION,
      routeId: route.id,
      selected,
      status,
      reason,
      quotaRemaining: Math.min(
        route.quota.tenantDailyLimit - route.quota.tenantUsedToday,
        route.quota.workspaceDailyLimit - route.quota.workspaceUsedToday,
      ),
      timeoutMs: route.timeoutMs,
      temperature: route.temperature,
      policyVersion: request.actor.policyVersion,
      audit: auditEvents.get(route.id) ?? [],
    }
  }

  return {
    listRoutes(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const filtered = routes.filter((route) => !request.capability || request.capability === 'all' || route.capability === request.capability)
      for (const route of filtered) {
        audit('model.route_evaluated', request, route.id, '模型路由配置进入当前运营视图。')
      }
      return success({ routes: filtered.map((route) => view(route)), total: filtered.length })
    },

    routeModel(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const route = findRoute(request.capability)
      if (!route) return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到模型路由配置',
        retryable: false,
        debugReference: `model_route_${request.capability}`,
      })
      if (request.requireNoTraining !== false && route.tenantOverride?.trainingAllowed !== false) {
        const fallback = findFallback(route, 'policy_blocked')
        audit('model.fallback_selected', request, route.id, '模型训练/留存策略不满足租户要求，降级到模板。')
        return success(decision(request, route, { provider: fallback.provider, version: fallback.version, source: 'fallback' }, 'fallback', '模型策略不满足租户数据外发要求，已降级。'))
      }
      const quotaRemaining = Math.min(
        route.quota.tenantDailyLimit - route.quota.tenantUsedToday,
        route.quota.workspaceDailyLimit - route.quota.workspaceUsedToday,
      )
      audit('model.quota_checked', request, route.id, `模型配额剩余 ${quotaRemaining} tokens。`)
      if (request.estimatedTokens > quotaRemaining) {
        const fallback = findFallback(route, 'quota_exhausted')
        audit('model.fallback_selected', request, route.id, '模型配额不足，选择降级链。')
        return success(decision(request, route, { provider: fallback.provider, version: fallback.version, source: 'fallback' }, 'fallback', '模型配额不足，已降级到确定性模板。'))
      }
      if (request.providerAvailable === false) {
        const fallback = findFallback(route, 'provider_unavailable')
        audit('model.fallback_selected', request, route.id, '模型供应商不可用，选择降级链。')
        return success(decision(request, route, { provider: fallback.provider, version: fallback.version, source: 'fallback' }, 'fallback', '模型供应商不可用，已降级。'))
      }
      if (route.status === 'blocked') {
        const fallback = findFallback(route, 'policy_blocked')
        audit('model.release_blocked', request, route.id, '候选版本未通过门禁，不能路由到候选模型。')
        return success(decision(request, route, { provider: fallback.provider, version: fallback.version, source: 'fallback' }, 'blocked', '候选版本被发布门禁阻断。'))
      }
      const useCandidate = route.status === 'canary' && route.candidateVersion && route.trafficSplit.candidate > 0
      audit('model.route_evaluated', request, route.id, useCandidate ? '灰度路由选择候选版本。' : '路由选择生产版本。')
      return success(decision(
        request,
        route,
        {
          provider: route.provider,
          version: useCandidate ? route.candidateVersion! : route.activeVersion,
          source: useCandidate ? 'candidate' : 'active',
        },
        'routed',
        useCandidate ? `按 ${route.trafficSplit.candidate}% 灰度流量选择候选版本。` : '选择生产版本。',
      ))
    },

    rollbackRoute(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canOperate(request.actor)) return failure({
        code: 'PERMISSION_DENIED',
        message: '只有平台运维或安全管理员可以回滚模型路由',
        retryable: false,
        debugReference: 'model_ops_role',
      })
      const route = routes.find((candidate) => candidate.id === request.routeId)
      if (!route) return failure({
        code: 'SEMANTIC_NOT_FOUND',
        message: '没有找到模型路由配置',
        retryable: false,
        debugReference: `model_route_${request.routeId}`,
      })
      route.status = 'rolled_back'
      route.trafficSplit = { active: 100, candidate: 0 }
      audit('model.rollback_completed', request, route.id, `模型路由已回滚：${request.reason || '无备注'}。`)
      return success(view(route))
    },
  }
}

export function httpStatusForModelOpsEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
