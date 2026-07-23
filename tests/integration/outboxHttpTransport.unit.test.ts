import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createOutboxHttpTransport,
  type OutboxHttpFetch,
} from '../../apps/api/src/outboxHttpTransport'
import type { OutboxPublishRequest } from '../../src/application/outboxPublisher'

const endpoint = 'https://events.example.test/v1/outbox'
const secret = 'test-only-hmac-secret-that-never-leaves-memory'
const timestamp = '2026-07-23T10:00:00.000Z'

function request(
  patch: Partial<OutboxPublishRequest<Record<string, unknown>>> = {},
): OutboxPublishRequest<Record<string, unknown>> {
  return {
    eventId: 'outbox_event_01',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    aggregateType: 'query_run',
    aggregateId: 'run_01',
    topic: 'query.run.submitted.v1',
    payload: { type: 'query.run.submitted', state: 'querying' },
    occurredAt: '2026-07-23T09:59:00.000Z',
    attempt: 1,
    fence: 1,
    signal: new AbortController().signal,
    ...patch,
  }
}

describe('Node-only outbox HTTP transport', () => {
  it.each([
    ['plain HTTP', 'http://events.example.test/hook', undefined, 'outbox HTTP endpoint must use HTTPS'],
    ['URL userinfo', 'https://user:password@events.example.test/hook', undefined, 'outbox HTTP endpoint userinfo is forbidden'],
    ['URL query', 'https://events.example.test/hook?token=private', undefined, 'outbox HTTP endpoint query parameters are forbidden'],
    ['URL fragment', 'https://events.example.test/hook#private', undefined, 'outbox HTTP endpoint fragment is forbidden'],
    ['empty URL fragment', 'https://events.example.test/hook#', undefined, 'outbox HTTP endpoint fragment is forbidden'],
    ['host outside allowlist', endpoint, ['other.example.test'], 'outbox HTTP endpoint host is not allowed'],
    ['URL-shaped allowlist entry', endpoint, ['https://events.example.test'], 'outbox HTTP allowed host is invalid'],
    ['userinfo allowlist entry', endpoint, ['trusted.test@events.example.test'], 'outbox HTTP allowed host is invalid'],
    ['port in allowlist entry', endpoint, ['events.example.test:443'], 'outbox HTTP allowed host is invalid'],
  ] as const)('rejects unsafe endpoint configuration: %s', (_case, target, allowedHosts, message) => {
    expect(() => createOutboxHttpTransport({
      endpoint: target,
      hmacSecret: secret,
      ...(allowedHosts ? { allowedHosts } : {}),
    })).toThrow(message)
  })

  it('rejects HMAC secrets shorter than 32 bytes', () => {
    expect(() => createOutboxHttpTransport({
      endpoint,
      hmacSecret: 'too-short',
    })).toThrow('HMAC secret')
  })

  it('sends a canonical signed POST with idempotency and schema headers', async () => {
    const calls: Array<{ input: string | URL; init: RequestInit }> = []
    const fetch: OutboxHttpFetch = vi.fn(async (input, init) => {
      calls.push({ input, init })
      return {
        status: 204,
        get body() { throw new Error('response body must not be read') },
        get text() { throw new Error('response text must not be read') },
      }
    })
    const transport = createOutboxHttpTransport<Record<string, unknown>>({
      endpoint,
      allowedHosts: ['events.example.test'],
      hmacSecret: secret,
      now: () => timestamp,
      fetch,
    })

    const first = await transport.publish(request({
      payload: { z: 2, nested: { beta: true, alpha: 'one' }, a: 1 },
    }))
    const second = await transport.publish(request({
      attempt: 2,
      fence: 2,
      payload: { a: 1, nested: { alpha: 'one', beta: true }, z: 2 },
    }))

    expect(first).toEqual(second)
    expect(first).toMatchObject({ ok: true, publicationFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) })
    expect(calls).toHaveLength(2)
    expect(calls[0].input).toBe(endpoint)
    expect(calls[0].init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal)
    const body = calls[0].init.body as string
    expect(calls[1].init.body).toBe(body)
    expect(JSON.parse(body)).toEqual({
      aggregateId: 'run_01',
      aggregateType: 'query_run',
      eventId: 'outbox_event_01',
      occurredAt: '2026-07-23T09:59:00.000Z',
      payload: { a: 1, nested: { alpha: 'one', beta: true }, z: 2 },
      schemaVersion: 'chatbi.outbox.v1',
      tenantId: 'tenant_demo',
      topic: 'query.run.submitted.v1',
      workspaceId: 'workspace_sales',
    })

    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('idempotency-key')).toBe('outbox_event_01')
    expect(headers.get('x-chatbi-event-id')).toBe('outbox_event_01')
    expect(headers.get('x-chatbi-topic')).toBe('query.run.submitted.v1')
    expect(headers.get('x-chatbi-timestamp')).toBe(timestamp)
    expect(headers.get('x-chatbi-schema-version')).toBe('chatbi.outbox.v1')
    expect(headers.get('x-chatbi-signature')).toBe(`sha256=${createHmac('sha256', secret)
      .update(`${timestamp}\noutbox_event_01\n`, 'utf8')
      .update(body, 'utf8')
      .digest('hex')}`)
    expect(first).toEqual({
      ok: true,
      publicationFingerprint: `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`,
    })
    expect(JSON.stringify({ transport, headers: Object.fromEntries(headers), body, first })).not.toContain(secret)
    expect(transport.endpointOrigin).toBe('https://events.example.test')
  })

  it.each([200, 201, 204, 299])('treats HTTP %s as success', async (status) => {
    const transport = createOutboxHttpTransport({
      endpoint,
      hmacSecret: secret,
      fetch: async () => ({ status }),
      now: () => timestamp,
    })
    await expect(transport.publish(request())).resolves.toMatchObject({ ok: true })
  })

  it.each([408, 425, 429, 500, 503, 599])('classifies HTTP %s as retryable', async (status) => {
    const transport = createOutboxHttpTransport({
      endpoint,
      hmacSecret: secret,
      fetch: async () => ({ status }),
      now: () => timestamp,
    })
    await expect(transport.publish(request())).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_RETRYABLE_STATUS', retryable: true },
    })
  })

  it.each([400, 401, 403, 404, 409, 422, 499])('classifies HTTP %s as non-retryable', async (status) => {
    const transport = createOutboxHttpTransport({
      endpoint,
      hmacSecret: secret,
      fetch: async () => ({ status }),
      now: () => timestamp,
    })
    await expect(transport.publish(request())).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_REJECTED', retryable: false },
    })
  })

  it('rejects injected redirects and invalid final statuses', async () => {
    const statuses = [301, 199, 600]
    const results = []
    for (const status of statuses) {
      const transport = createOutboxHttpTransport({
        endpoint,
        hmacSecret: secret,
        fetch: async () => ({ status }),
        now: () => timestamp,
      })
      results.push(await transport.publish(request()))
    }
    expect(results).toEqual([
      { ok: false, failure: { code: 'OUTBOX_HTTP_REDIRECT_REJECTED', retryable: false } },
      { ok: false, failure: { code: 'OUTBOX_HTTP_INVALID_STATUS', retryable: false } },
      { ok: false, failure: { code: 'OUTBOX_HTTP_INVALID_STATUS', retryable: false } },
    ])
  })

  it('classifies fetch exceptions without copying messages, URLs, or stacks', async () => {
    const transport = createOutboxHttpTransport({
      endpoint,
      hmacSecret: secret,
      fetch: async () => {
        throw new Error('postgresql://admin:password@private-db stack and response body secret')
      },
      now: () => timestamp,
    })

    const result = await transport.publish(request())

    expect(result).toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_NETWORK_ERROR', retryable: true },
    })
    expect(JSON.stringify(result)).not.toContain('password')
    expect(JSON.stringify(result)).not.toContain('private-db')
    expect(JSON.stringify(result)).not.toContain('stack')
  })

  it('propagates caller abort to fetch and returns a stable retryable failure', async () => {
    const caller = new AbortController()
    let fetchSignal: AbortSignal | undefined
    const transport = createOutboxHttpTransport({
      endpoint,
      hmacSecret: secret,
      timeoutMs: 5_000,
      fetch: async (_input, init) => {
        fetchSignal = init.signal as AbortSignal
        return await new Promise(() => {})
      },
      now: () => timestamp,
    })

    const publication = transport.publish(request({ signal: caller.signal }))
    await vi.waitFor(() => expect(fetchSignal).toBeDefined())
    caller.abort()

    await expect(publication).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_ABORTED', retryable: true },
    })
    expect(fetchSignal?.aborted).toBe(true)
  })

  it('enforces a hard timeout even when an injected fetch ignores abort', async () => {
    let fetchSignal: AbortSignal | undefined
    const transport = createOutboxHttpTransport({
      endpoint,
      hmacSecret: secret,
      timeoutMs: 10,
      fetch: async (_input, init) => {
        fetchSignal = init.signal as AbortSignal
        return await new Promise(() => {})
      },
      now: () => timestamp,
    })

    const result = await transport.publish(request())

    expect(result).toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_TIMEOUT', retryable: true },
    })
    expect(fetchSignal?.aborted).toBe(true)
  })

  it('rejects unsafe headers and non-JSON payloads before calling fetch', async () => {
    const fetch = vi.fn<OutboxHttpFetch>(async () => ({ status: 204 }))
    const transport = createOutboxHttpTransport<Record<string, unknown>>({
      endpoint,
      hmacSecret: secret,
      fetch,
      now: () => timestamp,
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const sparse = new Array(2)
    sparse[1] = 'present'
    let accessorReads = 0
    const accessorPayload = Object.defineProperty({}, 'safe', {
      enumerable: true,
      get() {
        accessorReads += 1
        return 'must-not-run'
      },
    })

    await expect(transport.publish(request({ eventId: 'event\r\nx-injected: yes' }))).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_INVALID_REQUEST', retryable: false },
    })
    await expect(transport.publish(request({ payload: cyclic }))).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_INVALID_REQUEST', retryable: false },
    })
    await expect(transport.publish(request({ payload: { sql: 'safe-looking-reference' } }))).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_INVALID_REQUEST', retryable: false },
    })
    await expect(transport.publish(request({ payload: { values: sparse } }))).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_INVALID_REQUEST', retryable: false },
    })
    await expect(transport.publish(request({ payload: accessorPayload }))).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_INVALID_REQUEST', retryable: false },
    })
    await expect(transport.publish(request({ payload: { value: 'x'.repeat(65 * 1024) } }))).resolves.toEqual({
      ok: false,
      failure: { code: 'OUTBOX_HTTP_INVALID_REQUEST', retryable: false },
    })
    expect(accessorReads).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
})
