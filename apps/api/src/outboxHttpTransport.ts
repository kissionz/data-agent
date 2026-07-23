import { createHash, createHmac } from 'node:crypto'
import type {
  OutboxPublishRequest,
  OutboxPublishResult,
  OutboxTransport,
} from '../../../src/application/outboxPublisher'
import {
  assertPublicOutboxPayload,
  canonicalizeOutboxPayload,
} from '../../../src/persistence/outboxPorts'

const SCHEMA_VERSION = 'chatbi.outbox.v1'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000

export interface OutboxHttpResponseLike {
  readonly status: number
}

export type OutboxHttpFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<OutboxHttpResponseLike>

export interface OutboxHttpTransportOptions {
  endpoint: string | URL
  hmacSecret: string | Uint8Array
  /** Exact, normalized hostnames. Wildcards and URL-shaped entries are rejected. */
  allowedHosts?: readonly string[]
  timeoutMs?: number
  fetch?: OutboxHttpFetch
  now?: () => string
}

export interface OutboxHttpTransport<TPayload = unknown> extends OutboxTransport<TPayload> {
  readonly endpointOrigin: string
}

type FetchOutcome =
  | { type: 'response'; response: OutboxHttpResponseLike }
  | { type: 'network_error' }
  | { type: 'timeout' }
  | { type: 'aborted' }

/**
 * Node-only signed HTTP transport. The HMAC secret is copied into closure
 * memory and is never placed in the returned transport, request, result, or
 * error text.
 */
export function createOutboxHttpTransport<TPayload = unknown>(
  options: OutboxHttpTransportOptions,
): OutboxHttpTransport<TPayload> {
  const endpoint = validateEndpoint(options.endpoint, options.allowedHosts)
  const secret = copySecret(options.hmacSecret)
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('outbox HTTP fetch is unavailable')
  const now = options.now ?? (() => new Date().toISOString())

  async function publish(request: OutboxPublishRequest<TPayload>): Promise<OutboxPublishResult> {
    if (request.signal.aborted) return failure('OUTBOX_HTTP_ABORTED', true)

    let body: string
    let timestamp: string
    try {
      validateRequest(request)
      timestamp = instant(now())
      const occurredAt = instant(request.occurredAt)
      assertPublicOutboxPayload(request.payload)
      const payload = canonicalizeOutboxPayload(request.payload)
      body = `{"aggregateId":${JSON.stringify(request.aggregateId)},`
        + `"aggregateType":${JSON.stringify(request.aggregateType)},`
        + `"eventId":${JSON.stringify(request.eventId)},`
        + `"occurredAt":${JSON.stringify(occurredAt)},`
        + `"payload":${payload},`
        + `"schemaVersion":${JSON.stringify(SCHEMA_VERSION)},`
        + `"tenantId":${JSON.stringify(request.tenantId)},`
        + `"topic":${JSON.stringify(request.topic)},`
        + `"workspaceId":${JSON.stringify(request.workspaceId)}}`
    } catch {
      return failure('OUTBOX_HTTP_INVALID_REQUEST', false)
    }

    const signature = createHmac('sha256', secret)
      .update(`${timestamp}\n${request.eventId}\n`, 'utf8')
      .update(body, 'utf8')
      .digest('hex')
    const publicationFingerprint = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abortListener: (() => void) | undefined

    const requestPromise: Promise<FetchOutcome> = Promise.resolve()
      .then(async () => await fetchImpl(endpoint.href, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': request.eventId,
          'x-chatbi-event-id': request.eventId,
          'x-chatbi-schema-version': SCHEMA_VERSION,
          'x-chatbi-signature': `sha256=${signature}`,
          'x-chatbi-timestamp': timestamp,
          'x-chatbi-topic': request.topic,
        },
        body,
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      }))
      .then(
        (response): FetchOutcome => ({ type: 'response', response }),
        (): FetchOutcome => ({ type: 'network_error' }),
      )

    const timeoutPromise = new Promise<FetchOutcome>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort()
        resolve({ type: 'timeout' })
      }, timeoutMs)
    })
    const abortPromise = new Promise<FetchOutcome>((resolve) => {
      abortListener = () => {
        controller.abort()
        resolve({ type: 'aborted' })
      }
      request.signal.addEventListener('abort', abortListener, { once: true })
    })

    let outcome: FetchOutcome
    try {
      outcome = await Promise.race([requestPromise, timeoutPromise, abortPromise])
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      if (abortListener) request.signal.removeEventListener('abort', abortListener)
    }

    if (outcome.type === 'timeout') return failure('OUTBOX_HTTP_TIMEOUT', true)
    if (outcome.type === 'aborted') return failure('OUTBOX_HTTP_ABORTED', true)
    if (outcome.type === 'network_error') {
      return request.signal.aborted
        ? failure('OUTBOX_HTTP_ABORTED', true)
        : failure('OUTBOX_HTTP_NETWORK_ERROR', true)
    }

    const status = outcome.response.status
    if (Number.isSafeInteger(status) && status >= 200 && status <= 299) {
      return { ok: true, publicationFingerprint }
    }
    if (status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)) {
      return failure('OUTBOX_HTTP_RETRYABLE_STATUS', true)
    }
    if (status >= 400 && status <= 499) return failure('OUTBOX_HTTP_REJECTED', false)
    if (status >= 300 && status <= 399) return failure('OUTBOX_HTTP_REDIRECT_REJECTED', false)
    return failure('OUTBOX_HTTP_INVALID_STATUS', false)
  }

  return {
    publish,
    endpointOrigin: endpoint.origin,
  }
}

function validateEndpoint(input: string | URL, allowedHosts: readonly string[] | undefined) {
  let endpoint: URL
  try {
    endpoint = new URL(typeof input === 'string' ? input : input.href)
  } catch {
    throw new Error('outbox HTTP endpoint is invalid')
  }
  if (endpoint.protocol !== 'https:') throw new Error('outbox HTTP endpoint must use HTTPS')
  if (endpoint.username || endpoint.password) throw new Error('outbox HTTP endpoint userinfo is forbidden')
  if (endpoint.search) throw new Error('outbox HTTP endpoint query parameters are forbidden')
  if (endpoint.href.includes('#')) throw new Error('outbox HTTP endpoint fragment is forbidden')

  if (allowedHosts !== undefined) {
    const normalized = new Set(allowedHosts.map(normalizeAllowedHost))
    if (!normalized.has(endpoint.hostname.toLowerCase())) {
      throw new Error('outbox HTTP endpoint host is not allowed')
    }
  }
  return endpoint
}

function normalizeAllowedHost(input: string) {
  if (
    typeof input !== 'string'
    || !input.trim()
    || input !== input.trim()
    || input.includes(':')
  ) {
    throw new Error('outbox HTTP allowed host is invalid')
  }
  let parsed: URL
  try {
    parsed = new URL(`https://${input}/`)
  } catch {
    throw new Error('outbox HTTP allowed host is invalid')
  }
  if (
    parsed.username
    || parsed.password
    || parsed.port
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('outbox HTTP allowed host is invalid')
  }
  return parsed.hostname.toLowerCase()
}

function copySecret(input: string | Uint8Array) {
  const secret = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  if (secret.byteLength < 32 || secret.byteLength > 4_096) {
    throw new Error('outbox HTTP HMAC secret is invalid')
  }
  return secret
}

function boundedTimeout(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error('outbox HTTP timeout is invalid')
  }
  return value
}

function validateRequest<TPayload>(request: OutboxPublishRequest<TPayload>) {
  opaqueHeader(request.eventId, 'eventId')
  opaqueHeader(request.topic, 'topic')
  opaqueString(request.tenantId, 'tenantId')
  opaqueString(request.workspaceId, 'workspaceId')
  opaqueString(request.aggregateId, 'aggregateId')
  if (!['query_run', 'conversation', 'workspace'].includes(request.aggregateType)) {
    throw new Error('aggregateType is invalid')
  }
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) throw new Error('attempt is invalid')
  if (!Number.isSafeInteger(request.fence) || request.fence < 1) throw new Error('fence is invalid')
}

function opaqueHeader(value: string, label: string) {
  opaqueString(value, label)
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid`)
}

function opaqueString(value: string, label: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new Error(`${label} is invalid`)
  }
}

function instant(value: string) {
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw new Error('timestamp is invalid')
  return new Date(milliseconds).toISOString()
}

function failure(code: string, retryable: boolean): OutboxPublishResult {
  return { ok: false, failure: { code, retryable } }
}
