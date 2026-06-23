import { createChatBiApplicationService, type ChatBiApplicationService } from '../application'
import {
  validationError,
  type ActorContext,
  type ApiEnvelope,
  type CancelRunRequest,
  type ClarifyRunRequest,
  type GetRunRequest,
  type PublicRunView,
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
    switch (envelope.error.code) {
      case 'VALIDATION_FAILED':
        return 400
      case 'PERMISSION_DENIED':
        return 403
      case 'SEMANTIC_NOT_FOUND':
        return 404
      case 'RUN_ALREADY_ACTIVE':
      case 'RUN_CANCELLED':
        return 409
      default:
        return 500
    }
  }

  function actorFrom(request: HttpRequestLike): ActorContext {
    const headers = request.headers ?? {}
    return {
      ...defaultActor,
      tenantId: headers['x-tenant-id'] || defaultActor.tenantId,
      workspaceId: headers['x-workspace-id'] || defaultActor.workspaceId,
      userId: headers['x-user-id'] || defaultActor.userId,
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

  function corsPreflight(): HttpResponseLike {
    return {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,idempotency-key,x-tenant-id,x-workspace-id,x-user-id,x-business-domain-id,x-semantic-version',
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

      const runMatch = path.match(/^\/v1\/runs\/([^/]+)(?:\/(clarify|cancel))?$/)
      if (runMatch) {
        const [, runId, action] = runMatch
        if (method === 'GET' && !action) {
          const envelope = service.getRun(getRequest(request, decodeURIComponent(runId)))
          return withCors(respond(envelopeStatus(envelope), envelope))
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
