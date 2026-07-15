import {
  createChatBiApplicationService,
  createQueryExecutionCoordinator,
  httpStatusForDeveloperAccessEnvelope,
  type QueryExecutionDispatcher,
} from '../../../src/application'
import { createChatBiBffRouter, type ChatBiBffRouter, type HttpRequestLike, type HttpResponseLike } from '../../../src/api'
import type { DeveloperScope } from '../../../src/contracts'
import { createFileChatBiPersistence } from '../../../src/persistence/file'
import { createInMemoryChatBiPersistence } from '../../../src/persistence/memory'
import type { ChatBiPersistence } from '../../../src/persistence/ports'
import type { QueryAdapter } from '../../../src/query'
import { createPostgresPool, createPostgresQueryAdapter } from './adapters/postgresQueryAdapter'
import { createApiRuntimeConfig, type ApiRuntimeConfig, type ApiRuntimeConfigInput } from './config'

export interface ApiRuntime {
  config: ApiRuntimeConfig
  router: ChatBiBffRouter
  handle(request: HttpRequestLike): HttpResponseLike
  readiness(): ApiReadiness
  checkReadiness(): Promise<ApiReadiness>
  runQueryWorkerOnce(): Promise<{ status: string }>
  close(): Promise<void>
}

export interface ApiRuntimeDependencies {
  queryAdapter?: QueryAdapter & {
    readiness?(): Promise<{ ok: true }>
    close?(): Promise<void>
  }
  resolveQueryCredential?: (credentialRef: string) => string
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
  const query = createQueryRuntime(config, persistence, dependencies)
  const service = createChatBiApplicationService({ persistence, queryDispatcher: query.dispatcher })
  const router = createChatBiBffRouter(service)

  function readiness(): ApiReadiness {
    return {
      ok: query.status() !== 'failed' && query.status() !== 'checking',
      service: config.serviceName,
      environment: config.environment,
      checks: {
        persistence: 'ok',
        router: 'ok',
        auth: config.authMode,
        query: query.status(),
      },
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
      return query.dispatcher?.runOnce() ?? Promise.resolve({ status: 'idle' })
    },
    async close() {
      await query.close()
    },
    handle(request) {
      const path = normalizePath(request.path)
      if (request.method.toUpperCase() === 'GET' && path === '/readyz') {
        const snapshot = readiness()
        return json(snapshot.ok ? 200 : 503, snapshot, config)
      }
      const authenticated = authenticateBearer(request, path, router, config)
      if (!authenticated.ok) return authenticated.response
      const effectiveRequest = authenticated.request
      if (requiresActor(config, effectiveRequest, path)) {
        const missing = requiredActorHeaders.filter((header) => !effectiveRequest.headers?.[header])
        if (missing.length > 0) {
          return json(401, {
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
          }, config)
        }
      }
      return withConfiguredCors(router.handle(effectiveRequest), config)
    },
  }
}

interface QueryRuntimeBoundary {
  dispatcher?: QueryExecutionDispatcher
  status(): ApiReadiness['checks']['query']
  checkReadiness(): Promise<void>
  close(): Promise<void>
}

function createQueryRuntime(
  config: ApiRuntimeConfig,
  persistence: ChatBiPersistence,
  dependencies: ApiRuntimeDependencies,
): QueryRuntimeBoundary {
  if (config.query.mode === 'fixture') {
    return {
      status: () => 'fixture',
      checkReadiness: async () => undefined,
      close: async () => undefined,
    }
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
    checkReadiness,
    async close() {
      await adapter.close?.()
    },
  }
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
  return withoutQuery || '/'
}
