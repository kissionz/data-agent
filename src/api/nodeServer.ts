import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { URL } from 'node:url'
import type { AsyncHttpRouterLike } from './asyncRouter'
import {
  createChatBiBffRouter,
  type ChatBiBffRouter,
  type HttpRequestLike,
  type HttpResponseLike,
} from './router'

export type NodeBffRouter = ChatBiBffRouter | AsyncHttpRouterLike

export interface NodeBffServerOptions {
  host?: string
  port?: number
  router?: NodeBffRouter
}

export function createNodeBffServer(options: NodeBffServerOptions = {}): Server {
  const router = options.router ?? createChatBiBffRouter()
  return createServer((request, response) => {
    void handleNodeRequest(router, request, response)
  })
}

export function listenNodeBff(options: NodeBffServerOptions = {}): Server {
  const host = options.host ?? '127.0.0.1'
  const port = options.port ?? 8787
  const server = createNodeBffServer(options)
  server.listen(port, host)
  return server
}

async function handleNodeRequest(
  router: NodeBffRouter,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const disconnect = bindNodeDisconnect(request, response)
  try {
    const httpRequest = await toHttpRequestLike(request, disconnect.signal)
    const httpResponse = await resolveNodeBffResponse(router, httpRequest)
    if (disconnect.signal.aborted || response.destroyed) return
    await writeNodeBffResponse(response, httpResponse, disconnect.signal)
  } catch {
    writeNodeInternalErrorResponse(response, disconnect.signal)
  } finally {
    disconnect.dispose()
  }
}

export async function writeNodeBffResponse(
  response: ServerResponse,
  httpResponse: HttpResponseLike,
  signal?: AbortSignal,
) {
  response.writeHead(httpResponse.status, httpResponse.headers)
  if (isStreamingBody(httpResponse.body)) {
    await writeNodeStreamingBody(response, httpResponse.body, signal)
    return
  }
  response.end(typeof httpResponse.body === 'string' ? httpResponse.body : JSON.stringify(httpResponse.body))
}

export function writeNodeInternalErrorResponse(
  response: Pick<
    ServerResponse,
    'destroyed' | 'headersSent' | 'destroy' | 'writeHead' | 'end'
  >,
  signal?: AbortSignal,
) {
  if (signal?.aborted || response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({
    ok: false,
    requestId: 'req_node_adapter',
    traceId: 'trace_node_adapter',
    error: {
      code: 'INTERNAL_ERROR',
      message: '本地 BFF 适配器错误',
      retryable: false,
      debugReference: 'node_adapter',
    },
  }))
}

export type NodeStreamingBody = AsyncIterable<string | Uint8Array>

export function isStreamingBody(body: unknown): body is NodeStreamingBody {
  return Boolean(
    body
    && typeof body === 'object'
    && Symbol.asyncIterator in body
    && typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function',
  )
}

/** Writes one chunk at a time and never pulls the next chunk before `drain`. */
export async function writeNodeStreamingBody(
  response: Pick<
    ServerResponse,
    'write' | 'end' | 'once' | 'removeListener' | 'destroyed'
  >,
  body: NodeStreamingBody,
  signal?: AbortSignal,
): Promise<void> {
  try {
    for await (const chunk of body) {
      if (signal?.aborted || response.destroyed) throw streamAborted()
      const writable = response.write(chunk)
      if (!writable) await waitForNodeDrain(response, signal)
    }
    if (!signal?.aborted && !response.destroyed) response.end()
  } catch (error) {
    if (signal?.aborted || response.destroyed || isAbortError(error)) return
    throw error
  }
}

function waitForNodeDrain(
  response: Pick<ServerResponse, 'once' | 'removeListener' | 'destroyed'>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || response.destroyed) return Promise.reject(streamAborted())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      response.removeListener('drain', onDrain)
      response.removeListener('error', onError)
      response.removeListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const onDrain = () => finish(resolve)
    const onError = (error: Error) => finish(() => reject(error))
    const onClose = () => finish(() => reject(streamAborted()))
    const onAbort = () => finish(() => reject(streamAborted()))
    response.once('drain', onDrain)
    response.once('error', onError)
    response.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted || response.destroyed) onAbort()
  })
}

function streamAborted() {
  const error = new Error('HTTP result stream aborted')
  error.name = 'AbortError'
  return error
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError'
}

export async function resolveNodeBffResponse(
  router: NodeBffRouter,
  request: HttpRequestLike,
): Promise<HttpResponseLike> {
  return await Promise.resolve(router.handle(request))
}

export function bindNodeDisconnect(request: IncomingMessage, response: ServerResponse) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  request.once('aborted', abort)
  response.once('close', abort)
  return {
    signal: controller.signal,
    dispose() {
      request.removeListener('aborted', abort)
      response.removeListener('close', abort)
    },
  }
}

async function toHttpRequestLike(request: IncomingMessage, signal: AbortSignal): Promise<HttpRequestLike> {
  const url = new URL(request.url ?? '/', 'http://local-bff')
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) query[key] = value

  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    query,
    headers: normalizeHeaders(request.headers),
    body: await readJsonBody(request, signal),
    signal,
  }
}

function normalizeHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) normalized[key.toLowerCase()] = value.join(',')
    else if (value !== undefined) normalized[key.toLowerCase()] = value
  }
  return normalized
}

function readJsonBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    const cleanup = () => {
      request.removeListener('data', onData)
      request.removeListener('error', onError)
      request.removeListener('end', onEnd)
      signal.removeEventListener('abort', onAbort)
    }
    const settle = (operation: () => void) => {
      cleanup()
      operation()
    }
    const onData = (chunk: Uint8Array) => chunks.push(chunk)
    const onError = (error: Error) => settle(() => reject(error))
    const onAbort = () => settle(() => reject(new Error('request disconnected')))
    const onEnd = () => {
      if (chunks.length === 0) {
        settle(() => resolve(undefined))
        return
      }
      const text = new TextDecoder().decode(concat(chunks))
      if (!text.trim()) {
        settle(() => resolve(undefined))
        return
      }
      try {
        const body = JSON.parse(text)
        settle(() => resolve(body))
      } catch {
        settle(() => reject(new Error('请求体不是有效 JSON')))
      }
    }
    request.on('data', onData)
    request.on('error', onError)
    request.on('end', onEnd)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}
