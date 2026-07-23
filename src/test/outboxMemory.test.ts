import { describe, expect, it } from 'vitest'
import { createInMemoryDurableOutbox } from '../persistence/outboxMemory'
import {
  calculateOutboxRetryDelayMs,
  type OutboxEnqueueInput,
  type OutboxMessageLease,
} from '../persistence/outboxPorts'

const at = '2026-07-23T10:00:00.000Z'

function message(
  patch: Partial<OutboxEnqueueInput<Record<string, unknown>>> = {},
): OutboxEnqueueInput<Record<string, unknown>> {
  return {
    eventId: 'event_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    aggregateType: 'query_run',
    aggregateId: 'run_1',
    topic: 'query.run.completed.v1',
    payload: { runId: 'run_1', rowCount: 3 },
    occurredAt: at,
    maxAttempts: 3,
    ...patch,
  }
}

function identity(lease: OutboxMessageLease) {
  return {
    eventId: lease.eventId,
    attempt: lease.attempt,
    fence: lease.fence,
    publisherId: lease.publisherId,
    leaseToken: lease.leaseToken,
  }
}

const key = { tenantId: 'tenant_1', workspaceId: 'workspace_1', eventId: 'event_1' }

describe('in-memory durable outbox', () => {
  it('enqueues the full event envelope idempotently and never exposes payload or lease token in views', () => {
    const outbox = createInMemoryDurableOutbox<Record<string, unknown>>()
    const payload = { b: 2, nested: { privateValue: 'payload-private' }, a: 1 }
    const created = outbox.enqueue(message({ payload }))
    payload.nested.privateValue = 'mutated'

    expect(created).toMatchObject({
      ok: true,
      created: true,
      message: {
        eventId: 'event_1',
        aggregateType: 'query_run',
        aggregateId: 'run_1',
        status: 'pending',
        occurredAt: at,
        availableAt: at,
      },
    })
    expect(JSON.stringify(created)).not.toContain('payload-private')
    expect(JSON.stringify(created)).not.toContain('leaseToken')

    const sameCanonicalPayload = outbox.enqueue(message({
      payload: { a: 1, nested: { privateValue: 'payload-private' }, b: 2 },
      occurredAt: '2026-07-23T18:00:00+08:00',
    }))
    expect(sameCanonicalPayload).toMatchObject({ ok: true, created: false })

    expect(outbox.enqueue(message({ topic: 'other.topic' }))).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
    })
    expect(outbox.enqueue(message({ availableAt: '2026-07-23T10:01:00.000Z' }))).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
    })
    expect(outbox.enqueue(message({ maxAttempts: 4 }))).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
    })
    const crossScope = outbox.enqueue(message({ tenantId: 'tenant_other' }))
    expect(crossScope).toEqual({ ok: false, reason: 'idempotency_conflict' })
    expect(JSON.stringify(crossScope)).not.toContain('tenant_1')
  })

  it('reclaims expired leases for at-least-once delivery and rejects the old fence ack', () => {
    const outbox = createInMemoryDurableOutbox<Record<string, unknown>>()
    outbox.enqueue(message({ payload: { privateValue: 'deliver-me' } }))
    const first = outbox.claimNext({ publisherId: 'publisher_a', now: at, leaseMs: 1_000 })!
    expect(first).toMatchObject({
      attempt: 1,
      fence: 1,
      publisherId: 'publisher_a',
      payload: { privateValue: 'deliver-me' },
      occurredAt: at,
    })

    const second = outbox.claimNext({
      publisherId: 'publisher_b',
      now: '2026-07-23T10:00:01.000Z',
      leaseMs: 1_000,
    })!
    expect(second).toMatchObject({ attempt: 2, fence: 2, publisherId: 'publisher_b' })

    expect(outbox.ack({
      ...identity(first),
      publishedAt: '2026-07-23T10:00:01.100Z',
      publicationFingerprint: 'pub:first',
    })).toMatchObject({ ok: false, reason: 'stale_lease' })

    const acknowledged = outbox.ack({
      ...identity(second),
      publishedAt: '2026-07-23T10:00:01.100Z',
      publicationFingerprint: 'pub:second',
    })
    expect(acknowledged).toMatchObject({ ok: true, applied: true, message: { status: 'published' } })
    expect(outbox.ack({
      ...identity(second),
      publishedAt: '2026-07-23T10:00:01.100Z',
      publicationFingerprint: 'pub:second',
    })).toMatchObject({ ok: true, applied: false })
    expect(JSON.stringify(outbox.getMessage(key))).not.toContain('deliver-me')
    expect(JSON.stringify(outbox.getMessage(key))).not.toContain(second.leaseToken)
    expect(outbox.getMessage({ ...key, tenantId: 'other_tenant' })).toBeUndefined()
    expect(outbox.getMessage({ ...key, workspaceId: 'other_workspace' })).toBeUndefined()
  })

  it('applies caller-computed deterministic exponential retry times and makes retry idempotent', () => {
    expect(calculateOutboxRetryDelayMs(1, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(100)
    expect(calculateOutboxRetryDelayMs(2, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(200)
    expect(calculateOutboxRetryDelayMs(3, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(250)
    expect(calculateOutboxRetryDelayMs(54, { initialDelayMs: 100, maxDelayMs: 250 })).toBe(250)

    const outbox = createInMemoryDurableOutbox<Record<string, unknown>>()
    outbox.enqueue(message())
    const lease = outbox.claimNext({ publisherId: 'publisher_a', now: at, leaseMs: 1_000 })!
    const retry = {
      ...identity(lease),
      failedAt: '2026-07-23T10:00:00.100Z',
      availableAt: '2026-07-23T10:00:00.200Z',
      failure: { code: 'HTTP_503', retryable: true },
    }
    expect(outbox.retry(retry)).toMatchObject({
      ok: true,
      applied: true,
      message: { status: 'retry_wait', availableAt: retry.availableAt },
    })
    expect(outbox.retry(retry)).toMatchObject({ ok: true, applied: false })
    expect(outbox.claimNext({
      publisherId: 'publisher_b',
      now: '2026-07-23T10:00:00.199Z',
      leaseMs: 1_000,
    })).toBeUndefined()
    expect(outbox.claimNext({
      publisherId: 'publisher_b',
      now: retry.availableAt,
      leaseMs: 1_000,
    })).toMatchObject({ attempt: 2, fence: 2 })
  })

  it('requires explicit dead-letter for terminal failures and dead-letters an expired final lease', () => {
    const outbox = createInMemoryDurableOutbox<Record<string, unknown>>()
    outbox.enqueue(message({ maxAttempts: 1 }))
    const lease = outbox.claimNext({ publisherId: 'publisher_a', now: at, leaseMs: 1_000 })!
    const terminal = {
      ...identity(lease),
      failedAt: '2026-07-23T10:00:00.500Z',
      failure: { code: 'HTTP_400', retryable: false },
    }
    expect(outbox.retry({ ...terminal, availableAt: '2026-07-23T10:00:01.000Z' })).toMatchObject({
      ok: false,
      reason: 'failure_not_retryable',
    })
    expect(outbox.deadLetter(terminal)).toMatchObject({
      ok: true,
      applied: true,
      message: { status: 'dead_lettered', lastFailure: { code: 'HTTP_400', retryable: false } },
    })
    expect(outbox.deadLetter(terminal)).toMatchObject({ ok: true, applied: false })

    outbox.enqueue(message({ eventId: 'event_expired', maxAttempts: 1 }))
    outbox.claimNext({
      publisherId: 'publisher_a',
      eventId: 'event_expired',
      now: at,
      leaseMs: 1_000,
    })
    expect(outbox.claimNext({
      publisherId: 'publisher_b',
      eventId: 'event_expired',
      now: '2026-07-23T10:00:01.000Z',
      leaseMs: 1_000,
    })).toBeUndefined()
    expect(outbox.getMessage({ ...key, eventId: 'event_expired' })).toMatchObject({
      status: 'dead_lettered',
      lastFailure: { code: 'OUTBOX_LEASE_EXPIRED', retryable: true },
    })
  })

  it('rejects unbounded or non-JSON payloads and unsafe failure codes', () => {
    const outbox = createInMemoryDurableOutbox<Record<string, unknown>>()
    expect(() => outbox.enqueue(message({ payload: { missing: undefined } }))).toThrow('unsupported undefined')
    expect(() => outbox.enqueue(message({ payload: { infinite: Number.POSITIVE_INFINITY } }))).toThrow('finite')
    expect(() => outbox.enqueue(message({ payload: { invalidBigInt: 1n } }))).toThrow('unsupported bigint')
    expect(() => outbox.enqueue(message({ payload: { huge: 'x'.repeat(66_000) } }))).toThrow('64 KiB')
    let tooDeep: Record<string, unknown> = {}
    const deepRoot = tooDeep
    for (let depth = 0; depth < 34; depth += 1) {
      const child: Record<string, unknown> = {}
      tooDeep.child = child
      tooDeep = child
    }
    expect(() => outbox.enqueue(message({ payload: deepRoot }))).toThrow('depth limit')
    expect(() => outbox.enqueue(message({
      payload: { nodes: Array.from({ length: 10_001 }, () => null) },
    }))).toThrow('node limit')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => outbox.enqueue(message({ payload: cyclic }))).toThrow('cycles')
    let getterInvoked = false
    const accessorArray: unknown[] = []
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      configurable: true,
      get() {
        getterInvoked = true
        return 'secret'
      },
    })
    Object.defineProperty(accessorArray, 'length', { value: 1 })
    expect(() => outbox.enqueue(message({
      payload: { values: accessorArray },
    }))).toThrow('accessor')
    expect(getterInvoked).toBe(false)
    expect(() => outbox.enqueue(message({
      payload: { nested: [{ RAW_sql: 'select password from users' }] },
    }))).toThrow('forbidden sensitive field')
    expect(() => outbox.enqueue(message({
      payload: { metadata: { Access_Token: 'sensitive' } },
    }))).toThrow('forbidden sensitive field')
    expect(() => outbox.enqueue(message({
      payload: { delivery: { Client_Secret: 'sensitive' } },
    }))).toThrow('forbidden sensitive field')
    expect(() => outbox.enqueue(message({
      payload: { context: { userInput: 'show me every customer' } },
    }))).toThrow('forbidden sensitive field')
    expect(outbox.enqueue(message({
      eventId: 'event_public_references',
      payload: {
        resultId: 'result_public',
        queryStatus: 'succeeded',
        policyVersion: 'policy-v3',
      },
    }))).toMatchObject({ ok: true, created: true })
    expect(() => outbox.enqueue(message({
      eventId: 'event_invalid_schedule',
      availableAt: '2026-07-23T09:59:59.999Z',
    }))).toThrow('availableAt cannot be before occurredAt')

    outbox.enqueue(message())
    const lease = outbox.claimNext({ publisherId: 'publisher_a', now: at, leaseMs: 1_000 })!
    expect(() => outbox.retry({
      ...identity(lease),
      failedAt: '2026-07-23T10:00:00.100Z',
      availableAt: '2026-07-23T10:00:00.200Z',
      failure: { code: 'https://secret.example/token', retryable: true },
    })).toThrow('public low-cardinality code')
  })
})
