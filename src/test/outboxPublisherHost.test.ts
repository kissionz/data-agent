import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOutboxPublisherHost } from '../../apps/api/src/outboxPublisherHost'
import type { OutboxPublisherCycleResult } from '../application/outboxPublisher'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const at = '2026-07-23T12:00:00.000Z'

afterEach(() => {
  vi.useRealTimers()
})

describe('outbox publisher host', () => {
  it('runs automatic and manual triggers single-flight and exposes safe summaries only', async () => {
    vi.useFakeTimers()
    const active = deferred<OutboxPublisherCycleResult>()
    const runOnce = vi.fn(() => active.promise)
    const host = createOutboxPublisherHost({
      publisher: { runOnce, abortActive: vi.fn() },
      pollIntervalMs: 50,
      now: () => at,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    const manualA = host.runOnce()
    const manualB = host.runOnce()
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(manualA).toBe(manualB)
    await vi.advanceTimersByTimeAsync(500)
    expect(runOnce).toHaveBeenCalledTimes(1)

    active.resolve({ status: 'published', attempt: 7 })
    await expect(Promise.all([manualA, manualB])).resolves.toEqual([
      { status: 'published', attempt: 7 },
      { status: 'published', attempt: 7 },
    ])
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness()).toEqual({
      running: true,
      draining: false,
      active: false,
      initialized: true,
      deliveryDegraded: false,
      consecutiveDeliveryFailures: 0,
      deadLetteredSinceStart: 0,
      lastPublishedAt: at,
      lastCycle: { status: 'published', at },
    })
    expect(JSON.stringify(host.readiness())).not.toContain('attempt')
    await host.stop({ drainMs: 0 })
  })

  it('drains a cooperative active publish and marks timeout without leaking data', async () => {
    vi.useFakeTimers()
    const active = deferred<OutboxPublisherCycleResult>()
    const abortActive = vi.fn(() => active.resolve({ status: 'retry_scheduled', attempt: 1 }))
    const host = createOutboxPublisherHost({
      publisher: { runOnce: () => active.promise, abortActive },
      now: () => at,
    })

    const cycle = host.runOnce()
    const stopping = host.stop({ drainMs: 100 })
    expect(host.readiness()).toMatchObject({ running: false, draining: true, active: true })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stopping).resolves.toEqual({ drained: true, timedOut: true })
    await expect(cycle).resolves.toEqual({ status: 'retry_scheduled', attempt: 1 })
    expect(abortActive).toHaveBeenCalledTimes(1)
    expect(host.readiness()).toMatchObject({ draining: false, active: false })
  })

  it('returns at the deadline when transport ignores abort and remains draining until settlement', async () => {
    vi.useFakeTimers()
    const active = deferred<OutboxPublisherCycleResult>()
    const abortActive = vi.fn()
    const host = createOutboxPublisherHost({
      publisher: { runOnce: () => active.promise, abortActive },
      now: () => at,
    })

    const cycle = host.runOnce()
    const stopping = host.stop({ drainMs: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(stopping).resolves.toEqual({ drained: false, timedOut: true })
    expect(abortActive).toHaveBeenCalledTimes(1)
    expect(host.readiness()).toMatchObject({ draining: true, active: true })
    expect(host.runOnce()).toBe(cycle)

    active.resolve({ status: 'published', attempt: 1 })
    await expect(cycle).resolves.toEqual({ status: 'published', attempt: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness()).toMatchObject({ draining: false, active: false })
  })

  it('sanitizes errors to allowlisted name/code and recovers on the next poll', async () => {
    vi.useFakeTimers()
    const unsafe = Object.assign(new Error('password=secret payload-private'), {
      name: 'SecretDatabaseCredentialError',
      code: 'OUTBOX_PUBLISHER_MUTATION_FAILED',
      payload: { secret: 'payload-private' },
    })
    const runOnce = vi.fn()
      .mockRejectedValueOnce(unsafe)
      .mockResolvedValue({ status: 'idle' })
    const host = createOutboxPublisherHost({
      publisher: { runOnce, abortActive: vi.fn() },
      pollIntervalMs: 25,
      now: () => at,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness().lastError).toEqual({
      name: 'Error',
      code: 'OUTBOX_PUBLISHER_MUTATION_FAILED',
      at,
    })
    const serialized = JSON.stringify(host.readiness())
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('payload-private')

    await vi.advanceTimersByTimeAsync(25)
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(host.readiness()).toMatchObject({ initialized: true, lastCycle: { status: 'idle' } })
    expect(host.readiness().lastError).toBeUndefined()
    await host.stop({ drainMs: 0 })
  })

  it('rejects manual failures with the same safe summary', async () => {
    const error = new Error('broker://user:secret@host')
    error.name = 'BrokerPasswordError'
    const host = createOutboxPublisherHost({
      publisher: {
        async runOnce() { throw error },
        abortActive() {},
      },
      now: () => at,
    })

    await expect(host.runOnce()).rejects.toEqual({ name: 'Error', at })
    expect(JSON.stringify(host.readiness())).not.toContain('secret')
    expect(JSON.stringify(host.readiness())).not.toContain('BrokerPasswordError')
  })

  it('fails readiness on delivery failures, recovers transient retries, and latches dead letters', async () => {
    const runOnce = vi.fn()
      .mockResolvedValueOnce({ status: 'retry_scheduled', attempt: 1 })
      .mockResolvedValueOnce({ status: 'published', attempt: 2 })
      .mockResolvedValueOnce({ status: 'dead_lettered', attempt: 1 })
      .mockResolvedValueOnce({ status: 'published', attempt: 1 })
    const host = createOutboxPublisherHost({
      publisher: { runOnce, abortActive() {} },
      now: () => at,
    })

    await host.runOnce()
    expect(host.readiness()).toMatchObject({
      deliveryDegraded: true,
      consecutiveDeliveryFailures: 1,
      deadLetteredSinceStart: 0,
      lastDeliveryFailure: { status: 'retry_scheduled', at },
    })

    await host.runOnce()
    expect(host.readiness()).toMatchObject({
      deliveryDegraded: false,
      consecutiveDeliveryFailures: 0,
      lastPublishedAt: at,
    })

    await host.runOnce()
    expect(host.readiness()).toMatchObject({
      deliveryDegraded: true,
      consecutiveDeliveryFailures: 1,
      deadLetteredSinceStart: 1,
      lastDeliveryFailure: { status: 'dead_lettered', at },
    })

    await host.runOnce()
    expect(host.readiness()).toMatchObject({
      deliveryDegraded: true,
      consecutiveDeliveryFailures: 0,
      deadLetteredSinceStart: 1,
      lastPublishedAt: at,
    })
  })
})
