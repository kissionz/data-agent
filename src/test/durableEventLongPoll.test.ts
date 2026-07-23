import { describe, expect, it, vi } from 'vitest'
import {
  DurableEventPollAbortedError,
  longPollDurableEvents,
} from '../../apps/api/src/durableEventLongPoll'
import { createInMemoryRunEventStore } from '../persistence/resultMemory'

const scope = { tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: 'run_event_poll' }
const at = '2026-07-15T18:00:00.000Z'

describe('durable event finite long poll', () => {
  it('returns an available bounded batch without waiting', async () => {
    const store = createInMemoryRunEventStore<{ type: string; index: number }>()
    for (let index = 1; index <= 3; index += 1) {
      store.append({
        ...scope,
        eventId: `evt_${index}`,
        expectedSequence: index - 1,
        event: { type: 'run.event', index },
        occurredAt: at,
      })
    }

    const result = await longPollDurableEvents({ ...scope, store, afterSequence: 0, limit: 2, waitMs: 100 })

    expect(result).toMatchObject({ timedOut: false, events: [{ sequence: 1 }, { sequence: 2 }] })
  })

  it('observes an event appended during the finite wait', async () => {
    const store = createInMemoryRunEventStore<{ type: string }>()
    const append = setTimeout(() => {
      store.append({
        ...scope,
        eventId: 'evt_later',
        expectedSequence: 0,
        event: { type: 'run.ready' },
        occurredAt: at,
      })
    }, 10)

    const result = await longPollDurableEvents({
      ...scope,
      store,
      afterSequence: 0,
      limit: 100,
      waitMs: 100,
      pollIntervalMs: 5,
    })
    clearTimeout(append)

    expect(result).toMatchObject({ timedOut: false, events: [{ eventId: 'evt_later', sequence: 1 }] })
    expect(result.waitedMs).toBeLessThan(100)
  })

  it('times out within its bounded window when no event is published', async () => {
    const store = createInMemoryRunEventStore()
    const startedAt = Date.now()

    const result = await longPollDurableEvents({
      ...scope,
      store,
      afterSequence: 0,
      limit: 100,
      waitMs: 15,
      pollIntervalMs: 5,
    })

    expect(result).toMatchObject({ timedOut: true, events: [] })
    expect(Date.now() - startedAt).toBeLessThan(250)
  })

  it('reports actual bounded snapshot latency when waitMs is zero', async () => {
    let clock = 100
    const result = await longPollDurableEvents({
      ...scope,
      store: {
        append: () => { throw new Error('not used') },
        listAfter() {
          clock += 7
          return []
        },
        currentSequence: () => 0,
      },
      afterSequence: 0,
      limit: 100,
      waitMs: 0,
      now: () => clock,
    })

    expect(result).toEqual({ events: [], timedOut: true, waitedMs: 7 })
  })

  it('cancels its timer and abort listener when the client disconnects', async () => {
    const store = createInMemoryRunEventStore()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const abort = setTimeout(() => controller.abort(), 10)

    await expect(longPollDurableEvents({
      ...scope,
      store,
      afterSequence: 0,
      limit: 100,
      waitMs: 1000,
      pollIntervalMs: 100,
      signal: controller.signal,
    })).rejects.toBeInstanceOf(DurableEventPollAbortedError)
    clearTimeout(abort)

    expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('applies the total deadline to an uncooperative store read', async () => {
    let observedSignal: AbortSignal | undefined
    const startedAt = Date.now()

    const result = await longPollDurableEvents({
      ...scope,
      store: {
        append: () => { throw new Error('not used') },
        listAfter(input) {
          observedSignal = input.signal
          return new Promise<never>(() => undefined)
        },
        currentSequence: () => 0,
      },
      afterSequence: 0,
      limit: 100,
      waitMs: 20,
      pollIntervalMs: 5,
    })

    expect(result).toMatchObject({ timedOut: true, events: [] })
    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(observedSignal?.aborted).toBe(true)
  })

  it('aborts an in-flight store read immediately on disconnect', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const polling = longPollDurableEvents({
      ...scope,
      store: {
        append: () => { throw new Error('not used') },
        listAfter(input) {
          observedSignal = input.signal
          return new Promise<never>(() => undefined)
        },
        currentSequence: () => 0,
      },
      afterSequence: 0,
      limit: 100,
      waitMs: 1000,
      signal: controller.signal,
    })

    await vi.waitFor(() => expect(observedSignal).toBeDefined())
    controller.abort()

    await expect(polling).rejects.toBeInstanceOf(DurableEventPollAbortedError)
    expect(observedSignal?.aborted).toBe(true)
  })
})
