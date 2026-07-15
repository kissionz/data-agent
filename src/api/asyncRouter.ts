import {
  createChatBiBffRouter,
  normalizePath,
  type HttpRequestLike,
  type HttpResponseLike,
} from './router'

export interface AsyncHttpRouterLike {
  handle(request: HttpRequestLike): Promise<HttpResponseLike>
}

export interface SyncHttpRouterLike {
  handle(request: HttpRequestLike): HttpResponseLike
}

export type AsyncRouteName = 'submit' | 'cancel' | 'clarify' | 'getRun' | 'resultPage'

export interface AsyncRouteContext {
  route: AsyncRouteName
  runId?: string
}

export type AsyncRouteHandler = (
  request: HttpRequestLike,
  context: AsyncRouteContext,
) => HttpResponseLike | Promise<HttpResponseLike>

/**
 * Deliberately limited to the routes backed by the durable query control plane.
 * All other routes continue through the existing synchronous BFF router.
 */
export interface AsyncRouteOverrides {
  submit?: AsyncRouteHandler
  cancel?: AsyncRouteHandler
  clarify?: AsyncRouteHandler
  getRun?: AsyncRouteHandler
  resultPage?: AsyncRouteHandler
}

export function createAsyncHttpRouter(
  delegate: SyncHttpRouterLike = createChatBiBffRouter(),
  overrides: AsyncRouteOverrides = {},
): AsyncHttpRouterLike {
  return {
    async handle(request) {
      try {
        const match = matchAsyncRoute(request)
        const override = match ? overrides[match.route] : undefined
        if (match && override) return await override(request, match)
        return await Promise.resolve(delegate.handle(request))
      } catch {
        return safeInternalErrorResponse()
      }
    },
  }
}

export function matchAsyncRoute(request: HttpRequestLike): AsyncRouteContext | undefined {
  const method = request.method.toUpperCase()
  const path = normalizePath(request.path)

  if (method === 'POST' && path === '/v1/questions') return { route: 'submit' }

  const resultMatch = path.match(/^\/v1\/results\/([^/]+)$/)
  if (method === 'GET' && resultMatch) {
    return { route: 'resultPage', runId: decodeURIComponent(resultMatch[1]) }
  }

  const runMatch = path.match(/^\/v1\/runs\/([^/]+)(?:\/(clarify|cancel|events))?$/)
  if (!runMatch) return undefined

  const [, encodedRunId, action] = runMatch
  const runId = decodeURIComponent(encodedRunId)
  if (method === 'GET' && !action) return { route: 'getRun', runId }
  if (method === 'POST' && action === 'clarify') return { route: 'clarify', runId }
  if (method === 'POST' && action === 'cancel') return { route: 'cancel', runId }
  return undefined
}

function safeInternalErrorResponse(): HttpResponseLike {
  return {
    status: 500,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    },
    body: {
      ok: false,
      requestId: 'req_async_router',
      traceId: 'trace_async_router',
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务暂时不可用',
        retryable: true,
        debugReference: 'async_router',
      },
    },
  }
}
