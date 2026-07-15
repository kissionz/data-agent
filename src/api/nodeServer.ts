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
  try {
    const httpRequest = await toHttpRequestLike(request)
    const httpResponse = await resolveNodeBffResponse(router, httpRequest)
    response.writeHead(httpResponse.status, httpResponse.headers)
    response.end(typeof httpResponse.body === 'string' ? httpResponse.body : JSON.stringify(httpResponse.body))
  } catch (error) {
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
}

export async function resolveNodeBffResponse(
  router: NodeBffRouter,
  request: HttpRequestLike,
): Promise<HttpResponseLike> {
  return await Promise.resolve(router.handle(request))
}

async function toHttpRequestLike(request: IncomingMessage): Promise<HttpRequestLike> {
  const url = new URL(request.url ?? '/', 'http://local-bff')
  const query: Record<string, string> = {}
  for (const [key, value] of url.searchParams.entries()) query[key] = value

  return {
    method: request.method ?? 'GET',
    path: url.pathname,
    query,
    headers: normalizeHeaders(request.headers),
    body: await readJsonBody(request),
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

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('error', reject)
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      const text = new TextDecoder().decode(concat(chunks))
      if (!text.trim()) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是有效 JSON'))
      }
    })
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
