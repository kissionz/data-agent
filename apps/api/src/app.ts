import {
  createChatBiApplicationService,
  createDurableChatBiApplicationService,
  createQueryExecutionCoordinator,
  httpStatusForDeveloperAccessEnvelope,
  type DurableQueryControlPlane,
  type QueryExecutionDispatcher,
} from '../../../src/application'
import { createChatBiBffRouter, type ChatBiBffRouter, type HttpRequestLike, type HttpResponseLike } from '../../../src/api'
import { httpStatusForError, type ActorContext, type DeveloperScope, type SubmitQuestionRequest } from '../../../src/contracts'
import { createFileChatBiPersistence } from '../../../src/persistence/file'
import { createInMemoryChatBiPersistence } from '../../../src/persistence/memory'
import type { ChatBiPersistence } from '../../../src/persistence/ports'
import type { ResultPageStore, RunEventStore, StoredRunEvent } from '../../../src/persistence/resultPorts'
import type { QueryAdapter } from '../../../src/query'
import { createPostgresPool, createPostgresQueryAdapter } from './adapters/postgresQueryAdapter'
import { createApiRuntimeConfig, type ApiRuntimeConfig, type ApiRuntimeConfigInput } from './config'
import { createDurableQueryReadService } from './durableQueryReadService'
import { createPostgresQueryRuntime, type PostgresQueryRuntime } from './postgresQueryRuntime'
import type {
  TransactionalResultManifestMetadata,
  TransactionalResultPage,
} from './transactionalQueryExecutionCoordinator'

export interface ApiRuntime {
  config: ApiRuntimeConfig
  router: ChatBiBffRouter
  handle(request: HttpRequestLike): HttpResponseLike
  handleAsync(request: HttpRequestLike): Promise<HttpResponseLike>
  readiness(): ApiReadiness
  checkReadiness(): Promise<ApiReadiness>
  runQueryWorkerOnce(): Promise<{ status: string }>
  startQueryWorker(): void
  close(): Promise<void>
}

export interface ApiRuntimeDependencies {
  queryAdapter?: QueryAdapter & {
    readiness?(): Promise<{ ok: true }>
    close?(): Promise<void>
  }
  resolveQueryCredential?: (credentialRef: string) => string
  queryControlPlane?: DurableQueryControlPlane
  resultPageStore?: ResultPageStore<TransactionalResultPage, TransactionalResultManifestMetadata>
  runEventStore?: RunEventStore
  postgresRuntime?: PostgresQueryRuntime
}

export interface ApiReadiness {
  ok: boolean
  service: string
  environment: ApiRuntimeConfig['environment']
  checks: {
    persistence: 'ok'
    router: 'ok'
    auth: ApiRuntimeConfig['authMode']
    query: 'fixture' | 'checking' | 'ok' | 'failed'
    controlPlane: 'not_configured' | 'checking' | 'ok' | 'failed'
    worker: 'not_configured' | 'stopped' | 'running' | 'draining' | 'failed'
    reconciler: 'not_configured' | 'stopped' | 'initializing' | 'running' | 'draining' | 'failed'
    outbox: 'not_configured' | 'stopped' | 'initializing' | 'running' | 'draining' | 'failed'
  }
  outboxDelivery?: {
    degraded: boolean
    consecutiveFailures: number
    deadLetteredSinceStart: number
    lastPublishedAt?: string
    lastFailure?: {
      status: 'retry_scheduled' | 'dead_lettered' | 'lost_lease'
      at: string
    }
  }
}

const requiredActorHeaders = [
  'x-tenant-id',
  'x-workspace-id',
  'x-user-id',
  'x-business-domain-id',
  'x-semantic-version',
]

export function createApiRuntime(
  input: ApiRuntimeConfigInput = {},
  dependencies: ApiRuntimeDependencies = {},
): ApiRuntime {
  const config = createApiRuntimeConfig(input)
  const persistence = createPersistence(config)
  const managedPostgres = config.query.mode === 'postgresql'
    ? dependencies.postgresRuntime ?? createManagedPostgresRuntime(config, dependencies)
    : undefined
  const query = createQueryRuntime(config, persistence, dependencies, managedPostgres)
  const queryControlPlane = dependencies.queryControlPlane ?? managedPostgres?.controlPlane
  const resultPageStore = dependencies.resultPageStore ?? managedPostgres?.resultPageStore
  const runEventStore = dependencies.runEventStore ?? managedPostgres?.runEventStore
  const service = createChatBiApplicationService({ persistence, queryDispatcher: query.dispatcher })
  const durableService = queryControlPlane
    ? createDurableChatBiApplicationService({ controlPlane: queryControlPlane })
    : undefined
  const durableReadService = queryControlPlane && resultPageStore && runEventStore
    ? createDurableQueryReadService({
        controlPlane: queryControlPlane,
        resultPageStore,
        runEventStore,
      })
    : undefined
  const router = createChatBiBffRouter(service)

  function readiness(): ApiReadiness {
    const outboxDelivery = query.outboxDeliveryStatus()
    return {
      ok: query.isReady(),
      service: config.serviceName,
      environment: config.environment,
      checks: {
        persistence: 'ok',
        router: 'ok',
        auth: config.authMode,
        query: query.status(),
        controlPlane: query.controlPlaneStatus(),
        worker: query.workerStatus(),
        reconciler: query.reconcilerStatus(),
        outbox: query.outboxStatus(),
      },
      ...(outboxDelivery ? { outboxDelivery } : {}),
    }
  }

  return {
    config,
    router,
    readiness,
    async checkReadiness() {
      await query.checkReadiness()
      return readiness()
    },
    runQueryWorkerOnce() {
      return query.runOnce()
    },
    startQueryWorker() {
      query.start()
    },
    async close() {
      await query.close()
    },
    async handleAsync(request) {
      const prepared = prepareRequest(request)
      if (!prepared.ok) return prepared.response
      const effectiveRequest = prepared.request
      if (!durableService) return withConfiguredCors(router.handle(effectiveRequest), config)
      const path = normalizePath(effectiveRequest.path)
      const method = effectiveRequest.method.toUpperCase()
      if (method === 'POST' && path === '/v1/questions') {
        const envelope = await durableService.submitQuestion(questionRequest(effectiveRequest))
        const status = envelope.ok
          ? envelope.data.displayStatus === 'querying' ? 202 : 200
          : httpStatusForError(envelope.error.code)
        return withConfiguredCors(json(status, envelope, config), config)
      }
      const cancelMatch = path.match(/^\/v1\/runs\/([^/]+)\/cancel$/)
      if (method === 'POST' && cancelMatch) {
        const body = bodyObject(effectiveRequest)
        const envelope = await durableService.cancelRun({
          runId: decodeURIComponent(cancelMatch[1]),
          conversationId: String(body.conversationId ?? body.conversation_id ?? ''),
          actor: actorFrom(effectiveRequest),
        })
        return withConfiguredCors(json(envelope.ok ? 200 : httpStatusForError(envelope.error.code), envelope, config), config)
      }
      const runMatch = path.match(/^\/v1\/runs\/([^/]+)$/)
      if (method === 'GET' && runMatch) {
        const envelope = await durableService.getRun({
          runId: decodeURIComponent(runMatch[1]),
          conversationId: effectiveRequest.query?.conversation_id || effectiveRequest.query?.conversationId || '',
          actor: actorFrom(effectiveRequest),
        })
        return withConfiguredCors(json(envelope.ok ? 200 : httpStatusForError(envelope.error.code), envelope, config), config)
      }
      const resultMatch = path.match(/^\/v1\/results\/([^/]+)$/)
      if (method === 'GET' && resultMatch) {
        if (!durableReadService) return durableRouteUnavailable(config)
        const rawLimit = effectiveRequest.query?.limit
        const envelope = await durableReadService.getResultPage({
          runId: decodeURIComponent(resultMatch[1]),
          conversationId: effectiveRequest.query?.conversation_id || effectiveRequest.query?.conversationId || '',
          cursor: effectiveRequest.query?.cursor,
          limit: rawLimit === undefined ? undefined : Number(rawLimit),
          actor: actorFrom(effectiveRequest),
        })
        return json(envelope.ok ? 200 : httpStatusForError(envelope.error.code), envelope, config)
      }
      const eventMatch = path.match(/^\/v1\/runs\/([^/]+)\/events$/)
      if (method === 'GET' && eventMatch) {
        if (!durableReadService) return durableRouteUnavailable(config)
        const rawLimit = effectiveRequest.query?.limit
        const rawWaitMs = effectiveRequest.query?.wait_ms ?? effectiveRequest.query?.waitMs
        const envelope = await durableReadService.getRunEvents({
          runId: decodeURIComponent(eventMatch[1]),
          conversationId: effectiveRequest.query?.conversation_id || effectiveRequest.query?.conversationId || '',
          actor: actorFrom(effectiveRequest),
          afterSequence: effectiveRequest.headers?.['last-event-id']
            || effectiveRequest.headers?.['Last-Event-ID']
            || effectiveRequest.query?.last_event_id,
          limit: rawLimit === undefined ? undefined : Number(rawLimit),
          waitMs: rawWaitMs === undefined ? undefined : Number(rawWaitMs),
          signal: effectiveRequest.signal,
        })
        if (!envelope.ok) return json(httpStatusForError(envelope.error.code), envelope, config)
        return withConfiguredCors({
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            'connection': 'keep-alive',
            'x-content-type-options': 'nosniff',
            'x-stream-mode': 'finite-long-poll',
            'x-event-sequence': String(envelope.data.afterSequence),
            'x-event-waited-ms': String(envelope.data.waitedMs),
          },
          body: envelope.data.events.length > 0
            ? serializeDurableEvents(envelope.data.events)
            : serializeDurableHeartbeat(),
        }, config)
      }
      if (isUnsupportedDurableRoute(method, path)) return durableRouteUnavailable(config)
      return withConfiguredCors(router.handle(effectiveRequest), config)
    },
    handle(request) {
      const prepared = prepareRequest(request)
      if (!prepared.ok) return prepared.response
      if (durableService && isDurableQueryRoute(prepared.request.method, normalizePath(prepared.request.path))) {
        return durableRouteUnavailable(config)
      }
      return withConfiguredCors(router.handle(prepared.request), config)
    },
  }

  function prepareRequest(request: HttpRequestLike): { ok: true; request: HttpRequestLike } | { ok: false; response: HttpResponseLike } {
    const path = normalizePath(request.path)
    if (request.method.toUpperCase() === 'GET' && path === '/readyz') {
      const snapshot = readiness()
      return { ok: false, response: json(snapshot.ok ? 200 : 503, snapshot, config) }
    }
    const authenticated = authenticateBearer(request, path, router, config)
    if (!authenticated.ok) return authenticated
    const effectiveRequest = authenticated.request
    if (requiresActor(config, effectiveRequest, path)) {
      const missing = requiredActorHeaders.filter((header) => !effectiveRequest.headers?.[header])
      if (missing.length > 0) {
        return { ok: false, response: json(401, {
          ok: false,
          requestId: 'req_auth_required',
          traceId: 'trace_auth_required',
          error: {
            code: 'VALIDATION_FAILED',
            message: '缺少认证上下文',
            retryable: false,
            debugReference: 'api_auth_headers',
            missingHeaders: missing,
          },
        }, config) }
      }
    }
    return { ok: true, request: effectiveRequest }
  }
}

function bodyObject(request: HttpRequestLike): Record<string, unknown> {
  return request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
}

function isUnsupportedDurableRoute(method: string, path: string): boolean {
  return method === 'POST' && /^\/v1\/runs\/[^/]+\/clarify$/.test(path)
}

function serializeDurableEvents(events: StoredRunEvent[]): string {
  return events.map((stored) => {
    const value = stored.event && typeof stored.event === 'object' && !Array.isArray(stored.event)
      ? stored.event as Record<string, unknown>
      : { payload: stored.event }
    const rawEventName = typeof value.type === 'string' ? value.type : 'run.event'
    const eventName = /^[A-Za-z0-9_.-]+$/.test(rawEventName) ? rawEventName : 'run.event'
    const data = { ...value, sequence: stored.sequence, occurredAt: stored.occurredAt }
    return [
      `id: ${stored.sequence}`,
      `event: ${eventName}`,
      `data: ${JSON.stringify(data)}`,
      '',
    ].join('\n')
  }).join('\n')
}

function serializeDurableHeartbeat(): string {
  return ['retry: 1000', ': heartbeat', '', ''].join('\n')
}

function isDurableQueryRoute(method: string, path: string): boolean {
  const normalizedMethod = method.toUpperCase()
  return (normalizedMethod === 'POST' && path === '/v1/questions')
    || (normalizedMethod === 'GET' && /^\/v1\/runs\/[^/]+(?:\/events)?$/.test(path))
    || (normalizedMethod === 'POST' && /^\/v1\/runs\/[^/]+\/(?:clarify|cancel)$/.test(path))
    || (normalizedMethod === 'GET' && /^\/v1\/results\/[^/]+$/.test(path))
}

function durableRouteUnavailable(config: ApiRuntimeConfig): HttpResponseLike {
  return json(503, {
    ok: false,
    requestId: 'req_durable_route_unavailable',
    traceId: 'trace_durable_route_unavailable',
    error: {
      code: 'INTERNAL_ERROR',
      message: '该持久化查询操作尚未开放，请稍后重试',
      retryable: true,
      debugReference: 'durable_route_unavailable',
    },
  }, config)
}

function actorFrom(request: HttpRequestLike): ActorContext {
  const headers = request.headers ?? {}
  const roles = headers['x-user-roles']?.split(',').map((role) => role.trim()).filter(Boolean) as ActorContext['roles'] | undefined
  return {
    tenantId: headers['x-tenant-id'] || 'tenant_demo',
    workspaceId: headers['x-workspace-id'] || 'workspace_sales',
    userId: headers['x-user-id'] || 'user_lin',
    roles: roles?.length ? roles : ['business_user'],
    businessDomainId: headers['x-business-domain-id'] || 'sales',
    semanticVersion: headers['x-semantic-version'] || 'sales-semantic-2026.06.1',
    policyVersion: headers['x-policy-version'],
    locale: 'zh-CN',
    timezone: headers['x-timezone'] || 'Asia/Shanghai',
  }
}

function questionRequest(request: HttpRequestLike): SubmitQuestionRequest {
  const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
    ? request.body as Record<string, unknown>
    : {}
  return {
    idempotencyKey: (request.headers?.['idempotency-key'] || body.idempotencyKey || body.idempotency_key || '') as string,
    conversationId: (body.conversationId || body.conversation_id || '') as string,
    question: (body.question || '') as string,
    mode: (body.mode || 'trusted') as SubmitQuestionRequest['mode'],
    actor: actorFrom(request),
  }
}

interface QueryRuntimeBoundary {
  dispatcher?: QueryExecutionDispatcher
  status(): ApiReadiness['checks']['query']
  controlPlaneStatus(): ApiReadiness['checks']['controlPlane']
  workerStatus(): ApiReadiness['checks']['worker']
  reconcilerStatus(): ApiReadiness['checks']['reconciler']
  outboxStatus(): ApiReadiness['checks']['outbox']
  outboxDeliveryStatus(): ApiReadiness['outboxDelivery']
  isReady(): boolean
  checkReadiness(): Promise<void>
  start(): void
  runOnce(): Promise<{ status: string }>
  close(): Promise<void>
}

function createQueryRuntime(
  config: ApiRuntimeConfig,
  persistence: ChatBiPersistence,
  dependencies: ApiRuntimeDependencies,
  managedPostgres?: PostgresQueryRuntime,
): QueryRuntimeBoundary {
  if (config.query.mode === 'fixture') {
    return {
      status: () => 'fixture',
      controlPlaneStatus: () => dependencies.queryControlPlane ? 'ok' : 'not_configured',
      workerStatus: () => 'not_configured',
      reconcilerStatus: () => 'not_configured',
      outboxStatus: () => 'not_configured',
      outboxDeliveryStatus: () => undefined,
      isReady: () => true,
      checkReadiness: async () => undefined,
      start: () => undefined,
      runOnce: () => Promise.resolve({ status: 'idle' }),
      close: async () => undefined,
    }
  }

  if (managedPostgres) {
    void managedPostgres.checkReadiness()
    return {
      status: () => managedPostgres.readiness().query,
      controlPlaneStatus: () => managedPostgres.readiness().controlPlane,
      workerStatus: () => {
        const worker = managedPostgres.readiness().worker
        if (worker.lastError) return 'failed'
        if (worker.draining) return 'draining'
        return worker.running ? 'running' : 'stopped'
      },
      reconcilerStatus: () => {
        const reconciler = managedPostgres.readiness().reconciler
        if (reconciler.lastError) return 'failed'
        if (reconciler.draining) return 'draining'
        if (reconciler.running && !reconciler.initialized) return 'initializing'
        return reconciler.running ? 'running' : 'stopped'
      },
      outboxStatus: () => {
        const outbox = managedPostgres.readiness().outbox
        if (outbox.mode === 'disabled') return 'not_configured'
        if (outbox.lastError || outbox.deliveryDegraded) return 'failed'
        if (outbox.draining) return 'draining'
        if (outbox.running && !outbox.initialized) return 'initializing'
        return outbox.running ? 'running' : 'stopped'
      },
      outboxDeliveryStatus: () => {
        const outbox = managedPostgres.readiness().outbox
        if (outbox.mode === 'disabled') return undefined
        return {
          degraded: outbox.deliveryDegraded,
          consecutiveFailures: outbox.consecutiveDeliveryFailures,
          deadLetteredSinceStart: outbox.deadLetteredSinceStart,
          ...(outbox.lastPublishedAt ? { lastPublishedAt: outbox.lastPublishedAt } : {}),
          ...(outbox.lastDeliveryFailure
            ? { lastFailure: { ...outbox.lastDeliveryFailure } }
            : {}),
        }
      },
      isReady: () => managedPostgres.readiness().ok,
      async checkReadiness() {
        await managedPostgres.checkReadiness()
      },
      start: () => managedPostgres.start(),
      runOnce: () => managedPostgres.runOnce(),
      async close() {
        await managedPostgres.close()
      },
    }
  }

  if (config.environment === 'staging' || config.environment === 'production') {
    throw new Error('Staging and production PostgreSQL mode requires the transactional managed runtime')
  }

  const adapter = dependencies.queryAdapter ?? createConfiguredPostgresAdapter(config, dependencies)
  const dispatcher = createQueryExecutionCoordinator({
    adapter,
    persistence,
    leaseMs: config.query.leaseMs,
  })
  let currentStatus: ApiReadiness['checks']['query'] = 'checking'
  async function checkReadiness() {
    try {
      if (adapter.readiness) await adapter.readiness()
      currentStatus = 'ok'
    } catch {
      currentStatus = 'failed'
    }
  }
  void checkReadiness()
  return {
    dispatcher,
    status: () => currentStatus,
    controlPlaneStatus: () => dependencies.queryControlPlane ? 'ok' : 'not_configured',
    workerStatus: () => 'not_configured',
    reconcilerStatus: () => 'not_configured',
    outboxStatus: () => 'not_configured',
    outboxDeliveryStatus: () => undefined,
    isReady: () => currentStatus === 'ok',
    checkReadiness,
    start: () => undefined,
    runOnce: () => dispatcher.runOnce(),
    async close() {
      await adapter.close?.()
    },
  }
}

function createManagedPostgresRuntime(
  config: ApiRuntimeConfig,
  dependencies: ApiRuntimeDependencies,
): PostgresQueryRuntime | undefined {
  // Explicit adapter injection is retained for deterministic unit tests. The
  // default process path always constructs the transactional dual-pool runtime.
  if (dependencies.queryAdapter || dependencies.queryControlPlane) return undefined
  if (!dependencies.resolveQueryCredential) {
    throw new Error('PostgreSQL runtime requires a server-side credential resolver')
  }
  return createPostgresQueryRuntime({ config, resolveCredential: dependencies.resolveQueryCredential })
}

function createConfiguredPostgresAdapter(config: ApiRuntimeConfig, dependencies: ApiRuntimeDependencies) {
  const credentialRef = config.query.credentialRef!
  const connectionString = dependencies.resolveQueryCredential?.(credentialRef)?.trim()
  if (!connectionString) throw new Error(`No server-side query credential is available for reference: ${credentialRef}`)
  const pool = createPostgresPool({
    connectionString,
    max: config.query.poolMax,
    connectionTimeoutMillis: config.query.connectTimeoutMs,
    idleTimeoutMillis: config.query.idleTimeoutMs,
    ssl: config.query.sslMode === 'disable'
      ? false
      : { rejectUnauthorized: config.query.sslMode === 'verify-full' },
  })
  return createPostgresQueryAdapter({
    pool,
    dataSourceId: 'warehouse_sales',
    maxStatementTimeoutMs: config.query.statementTimeoutMs,
  })
}

function authenticateBearer(
  request: HttpRequestLike,
  path: string,
  router: ChatBiBffRouter,
  config: ApiRuntimeConfig,
): { ok: true; request: HttpRequestLike } | { ok: false; response: HttpResponseLike } {
  const authorization = request.headers?.authorization ?? request.headers?.Authorization
  if (!authorization?.startsWith('Bearer ')) return { ok: true, request }
  const requiredScopes = scopesForRequest(request.method, path)
  if (requiredScopes.length === 0) {
    return {
      ok: false,
      response: json(403, {
        ok: false,
        requestId: 'req_api_key_scope',
        traceId: 'trace_api_key_scope',
        error: {
          code: 'PERMISSION_DENIED',
          message: 'API Key 不能访问该端点',
          retryable: false,
          debugReference: 'api_key_endpoint_scope',
        },
      }, config),
    }
  }
  const envelope = router.developer.verifyApiKey({
    presentedSecret: authorization.slice('Bearer '.length).trim(),
    requiredScopes,
    workspaceId: request.headers?.['x-workspace-id'] || 'workspace_sales',
    businessDomainId: request.headers?.['x-business-domain-id'] || 'sales',
    semanticVersion: request.headers?.['x-semantic-version'] || 'sales-semantic-2026.06.1',
    locale: 'zh-CN',
    timezone: request.headers?.['x-timezone'] || 'Asia/Shanghai',
  })
  if (!envelope.ok) {
    return { ok: false, response: json(httpStatusForDeveloperAccessEnvelope(envelope), envelope, config) }
  }
  const actor = envelope.data.actor
  return {
    ok: true,
    request: {
      ...request,
      headers: {
        ...request.headers,
        'x-tenant-id': actor.tenantId,
        'x-workspace-id': actor.workspaceId,
        'x-user-id': actor.userId,
        'x-user-roles': actor.roles.join(','),
        'x-business-domain-id': actor.businessDomainId,
        'x-semantic-version': actor.semanticVersion,
        'x-policy-version': actor.policyVersion,
      },
    },
  }
}

function scopesForRequest(method: string, path: string): DeveloperScope[] {
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === 'POST' && path === '/v1/questions') return ['questions:write']
  if (normalizedMethod === 'POST' && path === '/v1/feedback') return ['feedback:write']
  if (normalizedMethod === 'GET' && /^\/v1\/runs\/[^/]+(?:\/events)?$/.test(path)) return ['runs:read']
  if (normalizedMethod === 'POST' && /^\/v1\/runs\/[^/]+\/(?:clarify|cancel)$/.test(path)) return ['questions:write']
  if (normalizedMethod === 'GET' && path.startsWith('/v1/semantic')) return ['semantic:read']
  if (normalizedMethod === 'GET' && path.startsWith('/v1/assets')) return ['assets:read']
  if (normalizedMethod === 'POST' && path === '/v1/sharing/exports') return ['exports:create']
  if (normalizedMethod === 'POST' && path.startsWith('/v1/developer/webhooks')) return ['webhooks:manage']
  if (normalizedMethod === 'POST' && path === '/v1/developer/embed-tokens') return ['embed:issue']
  return []
}

function createPersistence(config: ApiRuntimeConfig): ChatBiPersistence {
  if (config.persistence.mode === 'file') {
    return createFileChatBiPersistence(config.persistence.filePath!)
  }
  return createInMemoryChatBiPersistence()
}

function requiresActor(config: ApiRuntimeConfig, request: HttpRequestLike, path: string) {
  if (config.authMode !== 'required_header_actor') return false
  if (request.method.toUpperCase() === 'OPTIONS') return false
  if (path === '/healthz' || path === '/readyz' || path === '/openapi.json') return false
  return path.startsWith('/v1/')
}

function json(status: number, body: unknown, config: ApiRuntimeConfig): HttpResponseLike {
  return withConfiguredCors({
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body,
  }, config)
}

function withConfiguredCors(response: HttpResponseLike, config: ApiRuntimeConfig): HttpResponseLike {
  return {
    ...response,
    headers: {
      ...response.headers,
      'access-control-allow-origin': config.cors.allowOrigin,
    },
  }
}

function normalizePath(path: string) {
  const [withoutQuery] = path.split('?')
  if (!withoutQuery || withoutQuery === '/') return '/'
  return withoutQuery.endsWith('/') ? withoutQuery.slice(0, -1) : withoutQuery
}
