import {
  createChatBiApplicationService,
  createCollaborationAssetApplicationService,
  createDataSourceApplicationService,
  createDeveloperAccessApplicationService,
  createEvaluationApplicationService,
  createIdentityPolicyApplicationService,
  createModelOpsApplicationService,
  createSemanticGovernanceApplicationService,
  createSharingExportApplicationService,
  createSloApplicationService,
  httpStatusForAssetEnvelope,
  httpStatusForDataSourceEnvelope,
  httpStatusForDeveloperAccessEnvelope,
  httpStatusForEvaluationEnvelope,
  httpStatusForIdentityEnvelope,
  httpStatusForModelOpsEnvelope,
  httpStatusForSemanticEnvelope,
  httpStatusForSharingEnvelope,
  httpStatusForSloEnvelope,
  type ChatBiApplicationService,
  type CollaborationAssetApplicationService,
  type DataSourceApplicationService,
  type DeveloperAccessApplicationService,
  type EvaluationApplicationService,
  type IdentityPolicyApplicationService,
  type ModelOpsApplicationService,
  type SemanticGovernanceApplicationService,
  type SharingExportApplicationService,
  type SloApplicationService,
} from '../application'
import {
  filterSseEventsAfter,
  httpStatusForError,
  runViewToSseEvents,
  serializeSseEvents,
  validationError,
  type ActorContext,
  type ApiEnvelope,
  type CancelRunRequest,
  type ClarifyRunRequest,
  type GetRunRequest,
  type ModelCapability,
  type PublicRunView,
  type ResultPageRequest,
  type ResultPageView,
  type SloWindow,
  type SubscriptionCadence,
  type SubmitQuestionRequest,
} from '../contracts'
import { openApiDocument } from './openapi'

export interface HttpRequestLike {
  method: string
  path: string
  headers?: Record<string, string | undefined>
  query?: Record<string, string | undefined>
  body?: unknown
}

export interface HttpResponseLike {
  status: number
  headers: Record<string, string>
  body: unknown
}

export interface ChatBiBffRouter {
  handle(request: HttpRequestLike): HttpResponseLike
  service: ChatBiApplicationService
  assets: CollaborationAssetApplicationService
  dataSources: DataSourceApplicationService
  developer: DeveloperAccessApplicationService
  evaluation: EvaluationApplicationService
  identity: IdentityPolicyApplicationService
  modelOps: ModelOpsApplicationService
  semantic: SemanticGovernanceApplicationService
  sharing: SharingExportApplicationService
  slo: SloApplicationService
}

const defaultActor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const jsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

export function createChatBiBffRouter(
  service: ChatBiApplicationService = createChatBiApplicationService(),
  assets: CollaborationAssetApplicationService = createCollaborationAssetApplicationService(),
  dataSources: DataSourceApplicationService = createDataSourceApplicationService(),
  developer: DeveloperAccessApplicationService = createDeveloperAccessApplicationService(),
  evaluation: EvaluationApplicationService = createEvaluationApplicationService(),
  identity: IdentityPolicyApplicationService = createIdentityPolicyApplicationService(),
  modelOps: ModelOpsApplicationService = createModelOpsApplicationService(),
  semantic: SemanticGovernanceApplicationService = createSemanticGovernanceApplicationService(),
  sharing: SharingExportApplicationService = createSharingExportApplicationService(),
  slo: SloApplicationService = createSloApplicationService(),
): ChatBiBffRouter {
  function respond(status: number, body: unknown, extraHeaders: Record<string, string> = {}): HttpResponseLike {
    return {
      status,
      headers: { ...jsonHeaders, ...extraHeaders },
      body,
    }
  }

  function envelopeStatus(envelope: ApiEnvelope<PublicRunView | ResultPageView>, successStatus = 200): number {
    if (envelope.ok) return successStatus
    return httpStatusForError(envelope.error.code)
  }

  function actorFrom(request: HttpRequestLike): ActorContext {
    const headers = request.headers ?? {}
    const roles = headers['x-user-roles']
      ?.split(',')
      .map((role) => role.trim())
      .filter(Boolean) as ActorContext['roles'] | undefined
    return {
      ...defaultActor,
      tenantId: headers['x-tenant-id'] || defaultActor.tenantId,
      workspaceId: headers['x-workspace-id'] || defaultActor.workspaceId,
      userId: headers['x-user-id'] || defaultActor.userId,
      roles: roles?.length ? roles : defaultActor.roles,
      businessDomainId: headers['x-business-domain-id'] || defaultActor.businessDomainId,
      semanticVersion: headers['x-semantic-version'] || defaultActor.semanticVersion,
      policyVersion: headers['x-policy-version'],
    }
  }

  function bodyObject(request: HttpRequestLike): Record<string, unknown> {
    return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as Record<string, unknown>
      : {}
  }

  function questionRequest(request: HttpRequestLike): SubmitQuestionRequest {
    const body = bodyObject(request)
    return {
      idempotencyKey: (request.headers?.['idempotency-key'] || body.idempotencyKey || body.idempotency_key || '') as string,
      conversationId: (body.conversationId || body.conversation_id || '') as string,
      question: (body.question || '') as string,
      mode: (body.mode || 'trusted') as SubmitQuestionRequest['mode'],
      actor: actorFrom(request),
    }
  }

  function getRequest(request: HttpRequestLike, runId: string): GetRunRequest {
    return {
      runId,
      conversationId: request.query?.conversation_id || request.query?.conversationId || '',
      actor: actorFrom(request),
    }
  }

  function resultPageRequest(request: HttpRequestLike, runId: string): ResultPageRequest {
    const rawLimit = request.query?.limit
    return {
      runId,
      conversationId: request.query?.conversation_id || request.query?.conversationId || '',
      cursor: request.query?.cursor,
      limit: rawLimit === undefined ? undefined : Number(rawLimit),
      actor: actorFrom(request),
    }
  }

  function clarifyRequest(request: HttpRequestLike, runId: string): ClarifyRunRequest {
    const body = bodyObject(request)
    return {
      runId,
      conversationId: (body.conversationId || body.conversation_id || '') as string,
      candidateId: (body.candidateId || body.candidate_id || '') as string,
      candidateVersion: (body.candidateVersion || body.candidate_version || '') as string,
      actor: actorFrom(request),
    }
  }

  function cancelRequest(request: HttpRequestLike, runId: string): CancelRunRequest {
    const body = bodyObject(request)
    return {
      runId,
      conversationId: (body.conversationId || body.conversation_id || '') as string,
      actor: actorFrom(request),
    }
  }

  function assetIdFrom(pathAssetId: string) {
    return decodeURIComponent(pathAssetId)
  }

  function corsPreflight(): HttpResponseLike {
    return {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-tenant-id,x-workspace-id,x-user-roles,x-business-domain-id,x-semantic-version,x-policy-version,x-timezone',
        'access-control-max-age': '600',
      },
      body: '',
    }
  }

  function withCors(response: HttpResponseLike): HttpResponseLike {
    return {
      ...response,
      headers: { ...response.headers, 'access-control-allow-origin': '*' },
    }
  }

  return {
    service,
    assets,
    dataSources,
    developer,
    evaluation,
    identity,
    modelOps,
    semantic,
    sharing,
    slo,
    handle(request) {
      const method = request.method.toUpperCase()
      const path = normalizePath(request.path)

      if (method === 'OPTIONS') return corsPreflight()
      if (method === 'GET' && path === '/healthz') {
        return withCors(respond(200, { ok: true, service: 'chatbi-local-bff' }))
      }
      if (method === 'GET' && path === '/openapi.json') return withCors(respond(200, openApiDocument))

      if (method === 'POST' && path === '/v1/developer/service-accounts') {
        const body = bodyObject(request)
        const envelope = developer.createServiceAccount({
          actor: actorFrom(request),
          name: String(body.name ?? ''),
          scopes: Array.isArray(body.scopes) ? body.scopes as never : [],
          expiresInDays: Number(body.expiresInDays ?? body.expires_in_days ?? 90),
          dailyRequestLimit: Number(body.dailyRequestLimit ?? body.daily_request_limit ?? 10000),
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/developer/api-keys') {
        const body = bodyObject(request)
        const envelope = developer.issueApiKey({
          actor: actorFrom(request),
          serviceAccountId: String(body.serviceAccountId ?? body.service_account_id ?? ''),
          expiresInDays: Number(body.expiresInDays ?? body.expires_in_days ?? 30),
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      const apiKeyRevokeMatch = path.match(/^\/v1\/developer\/api-keys\/([^/]+)\/revoke$/)
      if (method === 'POST' && apiKeyRevokeMatch) {
        const body = bodyObject(request)
        const envelope = developer.revokeApiKey({
          actor: actorFrom(request),
          keyId: decodeURIComponent(apiKeyRevokeMatch[1]),
          reason: String(body.reason ?? ''),
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      const apiKeyRotateMatch = path.match(/^\/v1\/developer\/api-keys\/([^/]+)\/rotate$/)
      if (method === 'POST' && apiKeyRotateMatch) {
        const body = bodyObject(request)
        const envelope = developer.rotateApiKey({
          actor: actorFrom(request),
          keyId: decodeURIComponent(apiKeyRotateMatch[1]),
          expiresInDays: Number(body.expiresInDays ?? body.expires_in_days ?? 30),
          graceMinutes: Number(body.graceMinutes ?? body.grace_minutes ?? 60),
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/developer/webhooks') {
        const body = bodyObject(request)
        const envelope = developer.registerWebhook({
          actor: actorFrom(request),
          url: String(body.url ?? ''),
          events: Array.isArray(body.events) ? body.events as never : [],
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      const webhookTestMatch = path.match(/^\/v1\/developer\/webhooks\/([^/]+)\/test$/)
      if (method === 'POST' && webhookTestMatch) {
        const envelope = developer.testWebhook({
          actor: actorFrom(request),
          webhookId: decodeURIComponent(webhookTestMatch[1]),
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      const webhookDeliveryMatch = path.match(/^\/v1\/developer\/webhooks\/([^/]+)\/deliveries$/)
      if (method === 'POST' && webhookDeliveryMatch) {
        const body = bodyObject(request)
        const simulatedHttpStatuses = body.simulatedHttpStatuses ?? body.simulated_http_statuses
        const envelope = developer.planWebhookDelivery({
          actor: actorFrom(request),
          webhookId: decodeURIComponent(webhookDeliveryMatch[1]),
          event: String(body.event ?? '') as never,
          payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
            ? body.payload as Record<string, unknown>
            : {},
          simulatedHttpStatuses: Array.isArray(simulatedHttpStatuses)
            ? simulatedHttpStatuses.map((status) => Number(status))
            : undefined,
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/developer/embed-tokens') {
        const body = bodyObject(request)
        const envelope = developer.issueEmbedToken({
          actor: actorFrom(request),
          hostOrigin: String(body.hostOrigin ?? body.host_origin ?? ''),
          source: (body.source || { type: 'asset', assetId: '' }) as never,
          expiresInMinutes: Number(body.expiresInMinutes ?? body.expires_in_minutes ?? 30),
        })
        return withCors(respond(httpStatusForDeveloperAccessEnvelope(envelope), envelope))
      }

      if (method === 'GET' && path === '/v1/model-ops/routes') {
        const envelope = modelOps.listRoutes({
          actor: actorFrom(request),
          capability: request.query?.capability as ModelCapability | 'all' | undefined,
        })
        return withCors(respond(httpStatusForModelOpsEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/model-ops/route') {
        const body = bodyObject(request)
        const envelope = modelOps.routeModel({
          actor: actorFrom(request),
          capability: (body.capability || 'planner') as ModelCapability,
          estimatedTokens: Number(body.estimatedTokens ?? body.estimated_tokens ?? 0),
          providerAvailable: body.providerAvailable === undefined && body.provider_available === undefined
            ? undefined
            : Boolean(body.providerAvailable ?? body.provider_available),
          requireNoTraining: body.requireNoTraining === undefined && body.require_no_training === undefined
            ? undefined
            : Boolean(body.requireNoTraining ?? body.require_no_training),
        })
        return withCors(respond(httpStatusForModelOpsEnvelope(envelope), envelope))
      }

      const modelRouteRollbackMatch = path.match(/^\/v1\/model-ops\/routes\/([^/]+)\/rollback$/)
      if (method === 'POST' && modelRouteRollbackMatch) {
        const body = bodyObject(request)
        const envelope = modelOps.rollbackRoute({
          actor: actorFrom(request),
          routeId: decodeURIComponent(modelRouteRollbackMatch[1]),
          reason: String(body.reason ?? body.note ?? ''),
        })
        return withCors(respond(httpStatusForModelOpsEnvelope(envelope), envelope))
      }

      if (method === 'GET' && path === '/v1/operations/slo') {
        const envelope = slo.getReport({
          actor: actorFrom(request),
          window: request.query?.window as SloWindow | undefined,
        })
        return withCors(respond(httpStatusForSloEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/operations/slo/budget-evaluations') {
        const body = bodyObject(request)
        const envelope = slo.evaluateBudget({
          actor: actorFrom(request),
          runId: String(body.runId ?? body.run_id ?? ''),
          latencySeconds: Number(body.latencySeconds ?? body.latency_seconds ?? 0),
          costCny: Number(body.costCny ?? body.cost_cny ?? 0),
          scanBytes: Number(body.scanBytes ?? body.scan_bytes ?? 0),
          cancelledPropagationSeconds: body.cancelledPropagationSeconds === undefined && body.cancelled_propagation_seconds === undefined
            ? undefined
            : Number(body.cancelledPropagationSeconds ?? body.cancelled_propagation_seconds),
        })
        return withCors(respond(httpStatusForSloEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/questions') {
        const envelope = service.submitQuestion(questionRequest(request))
        return withCors(respond(envelopeStatus(envelope), envelope))
      }

      const resultMatch = path.match(/^\/v1\/results\/([^/]+)$/)
      if (method === 'GET' && resultMatch) {
        const envelope = service.getResultPage(resultPageRequest(request, decodeURIComponent(resultMatch[1])))
        return withCors(respond(envelopeStatus(envelope), envelope))
      }

      if (method === 'GET' && path === '/v1/identity/context') {
        const envelope = identity.getContext({ actor: actorFrom(request) })
        return withCors(respond(httpStatusForIdentityEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/identity/policies/evaluate') {
        const body = bodyObject(request)
        const envelope = identity.evaluatePolicy({
          actor: actorFrom(request),
          action: (body.action || 'read') as never,
          resource: (body.resource || { type: 'workspace', workspaceId: actorFrom(request).workspaceId }) as never,
        })
        return withCors(respond(httpStatusForIdentityEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/identity/policies/current') {
        const body = bodyObject(request)
        const envelope = identity.updatePolicy({
          actor: actorFrom(request),
          note: String(body.note ?? ''),
        })
        return withCors(respond(httpStatusForIdentityEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/sharing/exports') {
        const body = bodyObject(request)
        const envelope = sharing.requestExport({
          actor: actorFrom(request),
          source: (body.source || { type: 'run', runId: '', conversationId: '' }) as never,
          format: (body.format || 'csv') as never,
          estimatedRows: Number(body.estimatedRows ?? body.estimated_rows ?? 0),
          estimatedBytes: Number(body.estimatedBytes ?? body.estimated_bytes ?? 0),
          classification: (body.classification || 'internal') as never,
        })
        return withCors(respond(httpStatusForSharingEnvelope(envelope), envelope))
      }

      const exportJobMatch = path.match(/^\/v1\/sharing\/exports\/([^/]+)$/)
      if (method === 'GET' && exportJobMatch) {
        const envelope = sharing.getExportJob({
          actor: actorFrom(request),
          exportId: decodeURIComponent(exportJobMatch[1]),
        })
        return withCors(respond(httpStatusForSharingEnvelope(envelope), envelope))
      }

      if (method === 'POST' && path === '/v1/sharing/shares') {
        const body = bodyObject(request)
        const envelope = sharing.createShare({
          actor: actorFrom(request),
          source: (body.source || { type: 'run', runId: '', conversationId: '' }) as never,
          scope: (body.scope || 'private_link') as never,
          recipientUserIds: Array.isArray(body.recipientUserIds)
            ? body.recipientUserIds.map(String)
            : Array.isArray(body.recipient_user_ids)
              ? body.recipient_user_ids.map(String)
              : [],
          expiresInDays: Number(body.expiresInDays ?? body.expires_in_days ?? 7),
        })
        return withCors(respond(httpStatusForSharingEnvelope(envelope), envelope))
      }

      const shareReauthMatch = path.match(/^\/v1\/sharing\/shares\/([^/]+)\/reauthorize$/)
      if (method === 'POST' && shareReauthMatch) {
        const envelope = sharing.reauthorizeShare({
          actor: actorFrom(request),
          shareId: decodeURIComponent(shareReauthMatch[1]),
        })
        return withCors(respond(httpStatusForSharingEnvelope(envelope), envelope))
      }

      if (method === 'GET' && path === '/v1/semantic/metrics') {
        const envelope = semantic.listMetrics({
          actor: actorFrom(request),
          lifecycle: request.query?.lifecycle as never,
          query: request.query?.q || request.query?.query,
        })
        return withCors(respond(httpStatusForSemanticEnvelope(envelope), envelope))
      }

      const semanticMetricMatch = path.match(/^\/v1\/semantic\/metrics\/([^/]+)(?:\/(submit-review|certify))?$/)
      if (semanticMetricMatch) {
        const [, pathMetricId, action] = semanticMetricMatch
        const metricId = decodeURIComponent(pathMetricId)
        const body = bodyObject(request)
        if (method === 'GET' && !action) {
          const envelope = semantic.getMetric({ actor: actorFrom(request), metricId })
          return withCors(respond(httpStatusForSemanticEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'submit-review') {
          const envelope = semantic.submitForReview({
            actor: actorFrom(request),
            metricId,
            note: String(body.note ?? ''),
          })
          return withCors(respond(httpStatusForSemanticEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'certify') {
          const envelope = semantic.certifyMetric({
            actor: actorFrom(request),
            metricId,
            note: String(body.note ?? ''),
            referenceSqlReconciled: Boolean(body.referenceSqlReconciled ?? body.reference_sql_reconciled),
          })
          return withCors(respond(httpStatusForSemanticEnvelope(envelope), envelope))
        }
      }

      if (method === 'GET' && path === '/v1/evaluation/gates/current') {
        const envelope = evaluation.evaluateReleaseGate({
          actor: actorFrom(request),
          candidateVersion: request.query?.candidate_version || request.query?.candidateVersion,
        })
        return withCors(respond(httpStatusForEvaluationEnvelope(envelope), envelope))
      }

      if (method === 'GET' && path === '/v1/evaluation/replays') {
        const envelope = evaluation.listReplayRuns({
          actor: actorFrom(request),
          query: request.query?.q || request.query?.query,
          status: request.query?.status as never,
          domain: request.query?.domain,
        })
        return withCors(respond(httpStatusForEvaluationEnvelope(envelope), envelope))
      }

      const replayMatch = path.match(/^\/v1\/evaluation\/replays\/([^/]+)$/)
      if (replayMatch && method === 'GET') {
        const envelope = evaluation.getReplayRun({
          actor: actorFrom(request),
          runId: decodeURIComponent(replayMatch[1]),
        })
        return withCors(respond(httpStatusForEvaluationEnvelope(envelope), envelope))
      }

      if (method === 'GET' && path === '/v1/data-sources') {
        const envelope = dataSources.listDataSources({
          actor: actorFrom(request),
          query: request.query?.q || request.query?.query,
          status: request.query?.status as never,
        })
        return withCors(respond(httpStatusForDataSourceEnvelope(envelope), envelope))
      }

      const dataSourceMatch = path.match(/^\/v1\/data-sources\/([^/]+)(?:\/(test-connection|lineage|schema-review))?$/)
      if (dataSourceMatch) {
        const [, pathDataSourceId, action] = dataSourceMatch
        const dataSourceId = decodeURIComponent(pathDataSourceId)
        if (method === 'GET' && !action) {
          const envelope = dataSources.getDataSource({ actor: actorFrom(request), dataSourceId })
          return withCors(respond(httpStatusForDataSourceEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'test-connection') {
          const envelope = dataSources.testConnection({ actor: actorFrom(request), dataSourceId })
          return withCors(respond(httpStatusForDataSourceEnvelope(envelope), envelope))
        }
        if (method === 'GET' && action === 'lineage') {
          const envelope = dataSources.getLineage({ actor: actorFrom(request), dataSourceId })
          return withCors(respond(httpStatusForDataSourceEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'schema-review') {
          const body = (request.body ?? {}) as Record<string, any>
          const nestedChange = (body.change ?? {}) as Record<string, any>
          const envelope = dataSources.reviewSchemaChange({
            actor: actorFrom(request),
            dataSourceId,
            change: {
              type: body.type ?? nestedChange.type,
              tableId: body.tableId ?? body.table_id ?? nestedChange.tableId ?? nestedChange.table_id,
              columnName: body.columnName ?? body.column_name ?? nestedChange.columnName ?? nestedChange.column_name,
              newType: body.newType ?? body.new_type ?? nestedChange.newType ?? nestedChange.new_type,
              reason: body.reason ?? nestedChange.reason ?? '',
            },
          })
          return withCors(respond(httpStatusForDataSourceEnvelope(envelope), envelope))
        }
      }

      if (method === 'GET' && path === '/v1/assets') {
        const envelope = assets.listAssets({
          actor: actorFrom(request),
          query: request.query?.q || request.query?.query,
          status: request.query?.status as never,
        })
        return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
      }

      const assetMatch = path.match(/^\/v1\/assets\/([^/]+)(?:\/(favorite|rename|subscription|notification-plan|audit))?$/)
      if (assetMatch) {
        const [, pathAssetId, action] = assetMatch
        const assetId = assetIdFrom(pathAssetId)
        const body = bodyObject(request)
        if (method === 'GET' && action === 'audit') {
          const envelope = assets.getAudit({ actor: actorFrom(request), assetId })
          return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'favorite') {
          const envelope = assets.updateFavorite({
            actor: actorFrom(request),
            assetId,
            favorite: Boolean(body.favorite),
          })
          return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'rename') {
          const envelope = assets.renameAsset({
            actor: actorFrom(request),
            assetId,
            title: String(body.title ?? ''),
          })
          return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'subscription') {
          const envelope = assets.updateSubscription({
            actor: actorFrom(request),
            assetId,
            cadence: (body.cadence || 'none') as SubscriptionCadence,
          })
          return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
        }
        if (method === 'POST' && action === 'notification-plan') {
          const envelope = assets.planNotification({ actor: actorFrom(request), assetId })
          return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
        }
      }

      const runMatch = path.match(/^\/v1\/runs\/([^/]+)(?:\/(clarify|cancel|events))?$/)
      if (runMatch) {
        const [, runId, action] = runMatch
        if (method === 'GET' && !action) {
          const envelope = service.getRun(getRequest(request, decodeURIComponent(runId)))
          return withCors(respond(envelopeStatus(envelope), envelope))
        }
        if (method === 'GET' && action === 'events') {
          const envelope = service.getRun(getRequest(request, decodeURIComponent(runId)))
          if (!envelope.ok) return withCors(respond(envelopeStatus(envelope), envelope))
          const events = filterSseEventsAfter(
            runViewToSseEvents(envelope.data),
            request.headers?.['last-event-id'] || request.query?.last_event_id,
          )
          return withCors({
            status: 200,
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              'connection': 'keep-alive',
              'x-content-type-options': 'nosniff',
            },
            body: serializeSseEvents(events),
          })
        }
        if (method === 'POST' && action === 'clarify') {
          const envelope = service.clarifyRun(clarifyRequest(request, decodeURIComponent(runId)))
          return withCors(respond(envelopeStatus(envelope), envelope))
        }
        if (method === 'POST' && action === 'cancel') {
          const envelope = service.cancelRun(cancelRequest(request, decodeURIComponent(runId)))
          return withCors(respond(envelopeStatus(envelope), envelope))
        }
      }

      return withCors(respond(404, {
        ok: false,
        requestId: 'req_not_found',
        traceId: 'trace_not_found',
        error: validationError(`未找到接口：${method} ${path}`),
      }))
    },
  }
}

export function normalizePath(path: string): string {
  const [withoutQuery] = path.split('?')
  if (!withoutQuery || withoutQuery === '/') return '/'
  return withoutQuery.endsWith('/') && withoutQuery.length > 1
    ? withoutQuery.slice(0, -1)
    : withoutQuery
}
