import { createChatBiApplicationService } from '../../../src/application'
import { createChatBiBffRouter, type ChatBiBffRouter, type HttpRequestLike, type HttpResponseLike } from '../../../src/api'
import { createFileChatBiPersistence } from '../../../src/persistence/file'
import { createInMemoryChatBiPersistence } from '../../../src/persistence/memory'
import type { ChatBiPersistence } from '../../../src/persistence/ports'
import { createApiRuntimeConfig, type ApiRuntimeConfig, type ApiRuntimeConfigInput } from './config'

export interface ApiRuntime {
  config: ApiRuntimeConfig
  router: ChatBiBffRouter
  handle(request: HttpRequestLike): HttpResponseLike
  readiness(): ApiReadiness
}

export interface ApiReadiness {
  ok: boolean
  service: string
  environment: ApiRuntimeConfig['environment']
  checks: {
    persistence: 'ok'
    router: 'ok'
    auth: ApiRuntimeConfig['authMode']
  }
}

const requiredActorHeaders = [
  'x-tenant-id',
  'x-workspace-id',
  'x-user-id',
  'x-business-domain-id',
  'x-semantic-version',
]

export function createApiRuntime(input: ApiRuntimeConfigInput = {}): ApiRuntime {
  const config = createApiRuntimeConfig(input)
  const persistence = createPersistence(config)
  const service = createChatBiApplicationService({ persistence })
  const router = createChatBiBffRouter(service)

  function readiness(): ApiReadiness {
    return {
      ok: true,
      service: config.serviceName,
      environment: config.environment,
      checks: {
        persistence: 'ok',
        router: 'ok',
        auth: config.authMode,
      },
    }
  }

  return {
    config,
    router,
    readiness,
    handle(request) {
      const path = normalizePath(request.path)
      if (request.method.toUpperCase() === 'GET' && path === '/readyz') {
        return json(200, readiness(), config)
      }
      if (requiresActor(config, request, path)) {
        const missing = requiredActorHeaders.filter((header) => !request.headers?.[header])
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
      return withConfiguredCors(router.handle(request), config)
    },
  }
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
