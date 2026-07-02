import type { DeveloperScope, EmbedTokenView } from './api'

export type DeveloperSdkEndpoint =
  | 'questions.submit'
  | 'feedback.submit'
  | 'runs.read'
  | 'runs.events'
  | 'results.page'
  | 'semantic.read'
  | 'assets.read'
  | 'exports.create'
  | 'exports.status'
  | 'webhooks.manage'
  | 'embed.issue'

export type DeveloperEndpointRequestInput =
  | (Omit<DeveloperSdkRequestInput, 'method' | 'path' | 'body'> & {
      endpoint: 'questions.submit'
      body: unknown
    })
  | (Omit<DeveloperSdkRequestInput, 'method' | 'path' | 'body'> & {
      endpoint: 'feedback.submit'
      body: unknown
    })
  | (Omit<DeveloperSdkRequestInput, 'method' | 'path' | 'body'> & {
      endpoint: 'runs.read' | 'runs.events'
      runId: string
      conversationId: string
    })
  | (Omit<DeveloperSdkRequestInput, 'method' | 'path' | 'body'> & {
      endpoint: 'results.page'
      runId: string
      conversationId: string
      cursor?: string
      limit?: number
    })
  | (Omit<DeveloperSdkRequestInput, 'method' | 'path' | 'body'> & {
      endpoint: 'exports.create'
      body: unknown
    })
  | (Omit<DeveloperSdkRequestInput, 'method' | 'path' | 'body'> & {
      endpoint: 'exports.status'
      exportId: string
    })

export interface DeveloperSdkRequestInput {
  baseUrl: string
  method: 'GET' | 'POST'
  path: `/${string}`
  apiKey: string
  body?: unknown
  idempotencyKey?: string
  headers?: Record<string, string>
}

export interface DeveloperSdkRequest {
  url: string
  method: DeveloperSdkRequestInput['method']
  headers: Record<string, string>
  body?: string
}

export interface EmbedFrameConfigInput {
  embedOrigin: string
  embedToken: string
  source: EmbedTokenView['source']
  locale?: string
  theme?: 'light' | 'dark' | 'system'
  height?: number
  title?: string
}

export interface EmbedFrameConfig {
  src: string
  title: string
  sandbox: string
  referrerPolicy: 'no-referrer'
  allow: string
  style: {
    width: '100%'
    height: string
    border: '0'
  }
  databaseCredentialsAccessible: false
}

const endpointScopes: Record<DeveloperSdkEndpoint, DeveloperScope[]> = {
  'questions.submit': ['questions:write'],
  'feedback.submit': ['feedback:write'],
  'runs.read': ['runs:read'],
  'runs.events': ['runs:read'],
  'results.page': ['runs:read'],
  'semantic.read': ['semantic:read'],
  'assets.read': ['assets:read'],
  'exports.create': ['exports:create'],
  'exports.status': ['exports:read'],
  'webhooks.manage': ['webhooks:manage'],
  'embed.issue': ['embed:issue'],
}

const sensitiveCredentialKeyPattern = /(?:password|passwd|pwd|secret|private[_-]?key|database[_-]?credential|credential[_-]?secret|connection[_-]?string|dsn)/i

export function requiredScopesForEndpoint(endpoint: DeveloperSdkEndpoint): DeveloperScope[] {
  return [...endpointScopes[endpoint]]
}

export function createDeveloperSdkRequest(input: DeveloperSdkRequestInput): DeveloperSdkRequest {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const headers: Record<string, string> = {
    ...input.headers,
    accept: 'application/json',
    authorization: `Bearer ${input.apiKey}`,
  }

  if (input.idempotencyKey) headers['idempotency-key'] = input.idempotencyKey

  const request: DeveloperSdkRequest = {
    url: `${baseUrl}${input.path}`,
    method: input.method,
    headers,
  }

  if (input.body !== undefined) {
    assertNoDatabaseCredentials(input.body)
    request.headers['content-type'] = request.headers['content-type'] ?? 'application/json'
    request.body = JSON.stringify(input.body)
  }

  return request
}

export function createDeveloperEndpointRequest(input: DeveloperEndpointRequestInput): DeveloperSdkRequest {
  switch (input.endpoint) {
    case 'questions.submit':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'POST',
        path: '/v1/questions',
        body: input.body,
      })
    case 'feedback.submit':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'POST',
        path: '/v1/feedback',
        body: input.body,
      })
    case 'runs.read':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(input.runId)}?${query({ conversation_id: input.conversationId })}` as `/${string}`,
      })
    case 'runs.events':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'GET',
        path: `/v1/runs/${encodeURIComponent(input.runId)}/events?${query({ conversation_id: input.conversationId })}` as `/${string}`,
      })
    case 'results.page':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'GET',
        path: `/v1/results/${encodeURIComponent(input.runId)}?${query({
          conversation_id: input.conversationId,
          cursor: input.cursor,
          limit: input.limit,
        })}` as `/${string}`,
      })
    case 'exports.create':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'POST',
        path: '/v1/sharing/exports',
        body: input.body,
      })
    case 'exports.status':
      return createDeveloperSdkRequest({
        ...baseEndpointInput(input),
        method: 'GET',
        path: `/v1/sharing/exports/${encodeURIComponent(input.exportId)}`,
      })
  }
}

export function createEmbedFrameConfig(input: EmbedFrameConfigInput): EmbedFrameConfig {
  assertHttpsOrigin(input.embedOrigin, 'embedOrigin')
  if (!input.embedToken || input.embedToken.length < 8) {
    throw new Error('embedToken must be a short-lived host-issued token, not a database credential.')
  }
  assertNoDatabaseCredentials(input)

  const origin = input.embedOrigin.replace(/\/+$/, '')
  const sourcePath = input.source.type === 'run'
    ? `/embed/runs/${encodeURIComponent(input.source.runId)}`
    : `/embed/assets/${encodeURIComponent(input.source.assetId)}`
  const params = new URLSearchParams({
    source_type: input.source.type,
    theme: input.theme ?? 'system',
    locale: input.locale ?? 'zh-CN',
  })
  const fragment = new URLSearchParams({ embed_token: input.embedToken })

  return {
    src: `${origin}${sourcePath}?${params.toString()}#${fragment.toString()}`,
    title: input.title ?? 'InsightFlow embedded analytics',
    sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups',
    referrerPolicy: 'no-referrer',
    allow: 'clipboard-read; clipboard-write',
    style: {
      width: '100%',
      height: `${input.height ?? 720}px`,
      border: '0',
    },
    databaseCredentialsAccessible: false,
  }
}

export function createEmbedIframeSnippet(config: EmbedFrameConfig): string {
  return [
    '<iframe',
    `  src="${escapeHtmlAttribute(config.src)}"`,
    `  title="${escapeHtmlAttribute(config.title)}"`,
    `  sandbox="${escapeHtmlAttribute(config.sandbox)}"`,
    `  referrerpolicy="${config.referrerPolicy}"`,
    `  allow="${escapeHtmlAttribute(config.allow)}"`,
    `  style="width:${config.style.width};height:${config.style.height};border:${config.style.border};"`,
    '></iframe>',
  ].join('\n')
}

export function assertNoDatabaseCredentials(value: unknown): void {
  const visited = new Set<unknown>()
  const walk = (current: unknown, path: string) => {
    if (current === null || current === undefined) return
    if (typeof current !== 'object') return
    if (visited.has(current)) return
    visited.add(current)

    for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
      const nextPath = path ? `${path}.${key}` : key
      if (sensitiveCredentialKeyPattern.test(key)) {
        throw new Error(`database credentials must not be passed through SDK/embed config: ${nextPath}`)
      }
      walk(nested, nextPath)
    }
  }

  walk(value, '')
}

function normalizeBaseUrl(baseUrl: string) {
  const parsed = new URL(baseUrl)
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('baseUrl must use HTTPS outside localhost.')
  }
  return parsed.toString().replace(/\/+$/, '')
}

function baseEndpointInput(input: DeveloperEndpointRequestInput): Pick<DeveloperSdkRequestInput, 'baseUrl' | 'apiKey' | 'headers' | 'idempotencyKey'> {
  return {
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    headers: input.headers,
    idempotencyKey: input.idempotencyKey,
  }
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value))
  }
  return params.toString()
}

function assertHttpsOrigin(origin: string, label: string) {
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`)
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error(`${label} must be an origin, not a full URL.`)
}

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
