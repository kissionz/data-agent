import {
  createChatBiApplicationService,
  createCollaborationAssetApplicationService,
  createDataSourceApplicationService,
  createEvaluationApplicationService,
  httpStatusForAssetEnvelope,
  httpStatusForDataSourceEnvelope,
  httpStatusForEvaluationEnvelope,
  type ChatBiApplicationService,
  type CollaborationAssetApplicationService,
  type DataSourceApplicationService,
  type EvaluationApplicationService,
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
  type PublicRunView,
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
  evaluation: EvaluationApplicationService
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
  evaluation: EvaluationApplicationService = createEvaluationApplicationService(),
): ChatBiBffRouter {
  function respond(status: number, body: unknown, extraHeaders: Record<string, string> = {}): HttpResponseLike {
    return {
      status,
      headers: { ...jsonHeaders, ...extraHeaders },
      body,
    }
  }

  function envelopeStatus(envelope: ApiEnvelope<PublicRunView>, successStatus = 200): number {
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
        'access-control-allow-headers': 'content-type,idempotency-key,x-tenant-id,x-workspace-id,x-user-roles,x-business-domain-id,x-semantic-version',
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
    evaluation,
    handle(request) {
      const method = request.method.toUpperCase()
      const path = normalizePath(request.path)

      if (method === 'OPTIONS') return corsPreflight()
      if (method === 'GET' && path === '/healthz') {
        return withCors(respond(200, { ok: true, service: 'chatbi-local-bff' }))
      }
      if (method === 'GET' && path === '/openapi.json') return withCors(respond(200, openApiDocument))

      if (method === 'POST' && path === '/v1/questions') {
        const envelope = service.submitQuestion(questionRequest(request))
        return withCors(respond(envelopeStatus(envelope), envelope))
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

      const dataSourceMatch = path.match(/^\/v1\/data-sources\/([^/]+)(?:\/(test-connection))?$/)
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
      }

      if (method === 'GET' && path === '/v1/assets') {
        const envelope = assets.listAssets({
          actor: actorFrom(request),
          query: request.query?.q || request.query?.query,
          status: request.query?.status as never,
        })
        return withCors(respond(httpStatusForAssetEnvelope(envelope), envelope))
      }

      const assetMatch = path.match(/^\/v1\/assets\/([^/]+)(?:\/(favorite|subscription|audit))?$/)
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
        if (method === 'POST' && action === 'subscription') {
          const envelope = assets.updateSubscription({
            actor: actorFrom(request),
            assetId,
            cadence: (body.cadence || 'none') as SubscriptionCadence,
          })
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
