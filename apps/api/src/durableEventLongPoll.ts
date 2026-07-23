import type { RunEventStore, StoredRunEvent } from '../../../src/persistence/resultPorts'

export const DEFAULT_DURABLE_EVENT_WAIT_MS = 15_000
export const MAX_DURABLE_EVENT_WAIT_MS = 25_000
export const DEFAULT_DURABLE_EVENT_POLL_INTERVAL_MS = 500
export const DEFAULT_DURABLE_EVENT_READ_TIMEOUT_MS = 5_000

export class DurableEventPollAbortedError extends Error {
  constructor() {
    super('durable event poll aborted')
    this.name = 'DurableEventPollAbortedError'
  }
}

export interface DurableEventLongPollInput<TEvent = unknown> {
  store: RunEventStore<TEvent>
  tenantId: string
  workspaceId: string
  runId: string
  afterSequence: number
  limit: number
  waitMs: number
  signal?: AbortSignal
  pollIntervalMs?: number
  readTimeoutMs?: number
  now?: () => number
}

export interface DurableEventLongPollResult<TEvent = unknown> {
  events: StoredRunEvent<TEvent>[]
  timedOut: boolean
  waitedMs: number
}

/**
 * Finite long-poll primitive. It never owns an unbounded connection and every
 * timer/abort listener is removed when the call settles.
 */
export async function longPollDurableEvents<TEvent = unknown>(
  input: DurableEventLongPollInput<TEvent>,
): Promise<DurableEventLongPollResult<TEvent>> {
  assertPollInput(input)
  const now = input.now ?? monotonicNow
  const startedAt = now()
  // waitMs=0 still permits one bounded snapshot read. Positive waits are a
  // total wall-clock budget, including every persistence call.
  const budgetMs = input.waitMs === 0
    ? (input.readTimeoutMs ?? DEFAULT_DURABLE_EVENT_READ_TIMEOUT_MS)
    : input.waitMs
  const readTimeoutMs = input.readTimeoutMs ?? DEFAULT_DURABLE_EVENT_READ_TIMEOUT_MS
  const deadline = startedAt + budgetMs
  throwIfAborted(input.signal)

  let events: StoredRunEvent<TEvent>[]
  try {
    events = await boundedStoreRead(deadline, readTimeoutMs, now, input.signal, ({ signal, timeoutMs }) =>
      input.store.listAfter({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        afterSequence: input.afterSequence,
        limit: input.limit,
        signal,
        timeoutMs,
      }))
  } catch (error) {
    if (error instanceof DurableEventPollDeadlineError) {
      return { events: [], timedOut: true, waitedMs: Math.max(0, now() - startedAt) }
    }
    throw error
  }
  throwIfAborted(input.signal)
  if (events.length > 0) return { events, timedOut: false, waitedMs: Math.max(0, now() - startedAt) }
  if (input.waitMs === 0) {
    return { events: [], timedOut: true, waitedMs: Math.max(0, now() - startedAt) }
  }

  const interval = input.pollIntervalMs ?? DEFAULT_DURABLE_EVENT_POLL_INTERVAL_MS
  while (now() < deadline) {
    await abortableDelay(Math.min(interval, Math.max(0, deadline - now())), input.signal)
    throwIfAborted(input.signal)
    let currentSequence: number
    try {
      currentSequence = await boundedStoreRead(deadline, readTimeoutMs, now, input.signal, ({ signal, timeoutMs }) =>
        input.store.currentSequence({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          signal,
          timeoutMs,
        }))
    } catch (error) {
      if (error instanceof DurableEventPollDeadlineError) break
      throw error
    }
    throwIfAborted(input.signal)
    if (currentSequence <= input.afterSequence) continue
    try {
      events = await boundedStoreRead(deadline, readTimeoutMs, now, input.signal, ({ signal, timeoutMs }) =>
        input.store.listAfter({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          afterSequence: input.afterSequence,
          limit: input.limit,
          signal,
          timeoutMs,
        }))
    } catch (error) {
      if (error instanceof DurableEventPollDeadlineError) break
      throw error
    }
    throwIfAborted(input.signal)
    if (events.length > 0) {
      return { events, timedOut: false, waitedMs: Math.max(0, now() - startedAt) }
    }
  }
  return { events: [], timedOut: true, waitedMs: Math.max(0, now() - startedAt) }
}

class DurableEventPollDeadlineError extends Error {
  constructor() {
    super('durable event poll deadline exceeded')
    this.name = 'DurableEventPollDeadlineError'
  }
}

async function boundedStoreRead<T>(
  deadline: number,
  maxReadTimeoutMs: number,
  now: () => number,
  parentSignal: AbortSignal | undefined,
  read: (boundary: { signal: AbortSignal; timeoutMs: number }) => T | Promise<T>,
): Promise<T> {
  throwIfAborted(parentSignal)
  const remainingMs = Math.min(maxReadTimeoutMs, Math.max(0, Math.ceil(deadline - now())))
  if (remainingMs === 0) throw new DurableEventPollDeadlineError()

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  return await new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      parentSignal?.removeEventListener('abort', onAbort)
    }
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      operation()
    }
    const onAbort = () => finish(() => {
      reject(new DurableEventPollAbortedError())
      controller.abort()
    })
    parentSignal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish(() => {
      reject(new DurableEventPollDeadlineError())
      controller.abort()
    }), remainingMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()

    Promise.resolve()
      .then(() => read({ signal: controller.signal, timeoutMs: remainingMs }))
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(
          controller.signal.aborted && parentSignal?.aborted
            ? new DurableEventPollAbortedError()
            : error,
        )),
      )
    if (parentSignal?.aborted) onAbort()
  })
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new DurableEventPollAbortedError())
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DurableEventPollAbortedError()
}

function assertPollInput(input: DurableEventLongPollInput): void {
  if (!Number.isInteger(input.afterSequence) || input.afterSequence < 0) throw new Error('afterSequence must be a non-negative integer')
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error('event limit must be between 1 and 1000')
  if (!Number.isInteger(input.waitMs) || input.waitMs < 0 || input.waitMs > MAX_DURABLE_EVENT_WAIT_MS) {
    throw new Error(`event waitMs must be between 0 and ${MAX_DURABLE_EVENT_WAIT_MS}`)
  }
  const interval = input.pollIntervalMs ?? DEFAULT_DURABLE_EVENT_POLL_INTERVAL_MS
  if (!Number.isInteger(interval) || interval < 1 || interval > 5_000) throw new Error('event poll interval must be between 1 and 5000')
  const readTimeoutMs = input.readTimeoutMs ?? DEFAULT_DURABLE_EVENT_READ_TIMEOUT_MS
  if (!Number.isInteger(readTimeoutMs) || readTimeoutMs < 1 || readTimeoutMs > MAX_DURABLE_EVENT_WAIT_MS) {
    throw new Error(`event readTimeoutMs must be between 1 and ${MAX_DURABLE_EVENT_WAIT_MS}`)
  }
}

function monotonicNow(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}
