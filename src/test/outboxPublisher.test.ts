import { describe, expect, it, vi } from 'vitest'
import {
  createDurableOutboxPublisher,
  type OutboxTransport,
} from '../application/outboxPublisher'
import { createInMemoryDurableOutbox } from '../persistence/outboxMemory'
import type { OutboxEnqueueInput } from '../persistence/outboxPorts'

const times = [
  '2026-07-23T11:00:00.000Z',
  '2026-07-23T11:00:00.100Z',
  '2026-07-23T11:00:00.200Z',
]

function enqueueInput(
  patch: Partial<OutboxEnqueueInput<{ privateValue: string }>> = {},
): OutboxEnqueueInput<{ privateValue: string }> {
  return {
    eventId: 'event_private',
    tenantId: 'tenant_private',
    workspaceId: 'workspace_private',
    aggregateType: 'query_run',
    aggregateId: 'run_private',
    topic: 'query.run.completed.v1',
    payload: { privateValue: 'payload-private' },
    occurredAt: times[0],
    maxAttempts: 3,
    ...patch,
  }
}

function clock(values = times) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

const key = {
  tenantId: 'tenant_private',
  workspaceId: 'workspace_private',
  eventId: 'event_private',
}

describe('durable outbox publisher', () => {
  it('publishes and fenced-acks one event without returning its identity or payload', async () => {
    const outbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    outbox.enqueue(enqueueInput())
    const publish = vi.fn(async () => ({
      ok: true as const,
      publicationFingerprint: 'broker:offset:42',
    }))
    const publisher = createDurableOutboxPublisher({
      outbox,
      transport: { publish },
      publisherId: 'publisher_1',
      leaseMs: 5_000,
      now: clock(),
    })

    const result = await publisher.runOnce()
    expect(result).toEqual({ status: 'published', attempt: 1 })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'event_private',
      aggregateType: 'query_run',
      payload: { privateValue: 'payload-private' },
      occurredAt: times[0],
      attempt: 1,
      fence: 1,
      signal: expect.any(AbortSignal),
    }))
    expect(outbox.getMessage(key)).toMatchObject({
      status: 'published',
      publicationFingerprint: 'broker:offset:42',
    })
    await expect(publisher.runOnce()).resolves.toEqual({ status: 'idle' })
  })

  it('uses deterministic exponential backoff and dead-letters after max attempts', async () => {
    const outbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    outbox.enqueue(enqueueInput({ maxAttempts: 2 }))
    const transport: OutboxTransport<{ privateValue: string }> = {
      async publish() {
        return { ok: false, failure: { code: 'BROKER_UNAVAILABLE', retryable: true } }
      },
    }
    const first = createDurableOutboxPublisher({
      outbox,
      transport,
      publisherId: 'publisher_1',
      leaseMs: 5_000,
      retryPolicy: { initialDelayMs: 1_000, maxDelayMs: 8_000 },
      now: clock([
        '2026-07-23T11:00:00.000Z',
        '2026-07-23T11:00:00.100Z',
      ]),
    })

    await expect(first.runOnce()).resolves.toEqual({ status: 'retry_scheduled', attempt: 1 })
    expect(outbox.getMessage(key)).toMatchObject({
      status: 'retry_wait',
      availableAt: '2026-07-23T11:00:01.100Z',
    })

    const second = createDurableOutboxPublisher({
      outbox,
      transport,
      publisherId: 'publisher_2',
      leaseMs: 5_000,
      retryPolicy: { initialDelayMs: 1_000, maxDelayMs: 8_000 },
      now: clock([
        '2026-07-23T11:00:01.100Z',
        '2026-07-23T11:00:01.200Z',
      ]),
    })
    await expect(second.runOnce()).resolves.toEqual({ status: 'dead_lettered', attempt: 2 })
    expect(outbox.getMessage(key)).toMatchObject({
      status: 'dead_lettered',
      lastFailure: { code: 'BROKER_UNAVAILABLE', retryable: true },
    })
  })

  it('classifies thrown transport errors without persisting or returning their message', async () => {
    const outbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    outbox.enqueue(enqueueInput())
    const publisher = createDurableOutboxPublisher({
      outbox,
      transport: {
        async publish() {
          throw new Error('https://user:password@broker/private payload-private')
        },
      },
      publisherId: 'publisher_1',
      leaseMs: 5_000,
      now: clock(),
    })

    const result = await publisher.runOnce()
    expect(result).toEqual({ status: 'retry_scheduled', attempt: 1 })
    const serialized = JSON.stringify({ result, message: outbox.getMessage(key) })
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('payload-private')
    expect(serialized).toContain('OUTBOX_PUBLISH_ERROR')
  })

  it('dead-letters non-retryable failures and reports a late ack as lost lease', async () => {
    const terminalOutbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    terminalOutbox.enqueue(enqueueInput())
    const terminal = createDurableOutboxPublisher({
      outbox: terminalOutbox,
      transport: {
        async publish() {
          return { ok: false, failure: { code: 'SCHEMA_REJECTED', retryable: false } }
        },
      },
      publisherId: 'publisher_1',
      leaseMs: 5_000,
      now: clock(),
    })
    await expect(terminal.runOnce()).resolves.toEqual({ status: 'dead_lettered', attempt: 1 })

    const lateOutbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    lateOutbox.enqueue(enqueueInput())
    const publisher = createDurableOutboxPublisher({
      outbox: lateOutbox,
      transport: {
        async publish() {
          // Simulate time passing beyond the lease before ack.
          return { ok: true, publicationFingerprint: 'broker:42' }
        },
      },
      publisherId: 'publisher_late',
      leaseMs: 50,
      now: clock([
        '2026-07-23T11:00:00.000Z',
        '2026-07-23T11:00:00.100Z',
      ]),
    })
    await expect(publisher.runOnce()).resolves.toEqual({ status: 'lost_lease', attempt: 1 })
    expect(lateOutbox.getMessage(key)).toMatchObject({ status: 'leased' })
  })

  it('propagates cooperative abort to the active transport', async () => {
    const outbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    outbox.enqueue(enqueueInput())
    let observed: AbortSignal | undefined
    const publisher = createDurableOutboxPublisher({
      outbox,
      transport: {
        publish(request) {
          observed = request.signal
          return new Promise((resolve) => {
            request.signal.addEventListener('abort', () => {
              resolve({ ok: false, failure: { code: 'PUBLISH_ABORTED', retryable: true } })
            }, { once: true })
          })
        },
      },
      publisherId: 'publisher_1',
      leaseMs: 5_000,
      now: clock(),
    })

    const cycle = publisher.runOnce()
    await Promise.resolve()
    expect(observed?.aborted).toBe(false)
    publisher.abortActive()
    await expect(cycle).resolves.toEqual({ status: 'retry_scheduled', attempt: 1 })
    expect(observed?.aborted).toBe(true)
  })

  it('rejects unsafe classifier codes instead of storing secret-bearing pseudo-codes', async () => {
    const outbox = createInMemoryDurableOutbox<{ privateValue: string }>()
    outbox.enqueue(enqueueInput())
    const publisher = createDurableOutboxPublisher({
      outbox,
      transport: { async publish() { throw new Error('secret') } },
      classifyThrownError: () => ({ code: 'https://secret.example', retryable: true }),
      publisherId: 'publisher_1',
      leaseMs: 5_000,
      now: clock(),
    })
    await expect(publisher.runOnce()).rejects.toThrow('public low-cardinality code')
    expect(outbox.getMessage(key)).toMatchObject({ status: 'leased' })
  })
})
