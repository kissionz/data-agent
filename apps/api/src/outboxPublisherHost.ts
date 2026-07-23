import type {
  DurableOutboxPublisher,
  OutboxPublisherCycleResult,
} from '../../../src/application/outboxPublisher'

export interface OutboxPublisherHostOptions {
  publisher: DurableOutboxPublisher
  pollIntervalMs?: number
  now?: () => string
}

export interface OutboxPublisherCycleSummary {
  status: OutboxPublisherCycleResult['status']
  at: string
}

export interface OutboxPublisherErrorSummary {
  name: string
  code?: string
  at: string
}

export interface OutboxPublisherReadiness {
  running: boolean
  draining: boolean
  active: boolean
  initialized: boolean
  deliveryDegraded: boolean
  consecutiveDeliveryFailures: number
  deadLetteredSinceStart: number
  lastPublishedAt?: string
  lastDeliveryFailure?: {
    status: 'retry_scheduled' | 'dead_lettered' | 'lost_lease'
    at: string
  }
  lastCycle?: OutboxPublisherCycleSummary
  lastError?: OutboxPublisherErrorSummary
}

export interface OutboxPublisherStopResult {
  drained: boolean
  timedOut: boolean
}

export interface OutboxPublisherHost {
  start(): void
  runOnce(): Promise<OutboxPublisherCycleResult>
  stop(options?: { drainMs?: number }): Promise<OutboxPublisherStopResult>
  readiness(): OutboxPublisherReadiness
}

/**
 * Single-flight polling host. Readiness retains only status, error class, and
 * timestamps: event identity, payload, transport response, and error messages
 * never enter the operational surface.
 */
export function createOutboxPublisherHost(options: OutboxPublisherHostOptions): OutboxPublisherHost {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  positiveInteger(pollIntervalMs, 'pollIntervalMs')
  const now = options.now ?? (() => new Date().toISOString())

  let running = false
  let draining = false
  let active = false
  let initialized = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeCycle: Promise<OutboxPublisherCycleResult> | undefined
  let stopOperation: Promise<OutboxPublisherStopResult> | undefined
  let lastCycle: OutboxPublisherCycleSummary | undefined
  let lastError: OutboxPublisherErrorSummary | undefined
  let deliveryDegraded = false
  let consecutiveDeliveryFailures = 0
  let deadLetteredSinceStart = 0
  let lastPublishedAt: string | undefined
  let lastDeliveryFailure: OutboxPublisherReadiness['lastDeliveryFailure']

  function clearPollTimer() {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  function safeError(error: unknown): OutboxPublisherErrorSummary {
    const code = error && typeof error === 'object' && 'code' in error
      && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : undefined
    return {
      name: safeErrorName(error),
      ...(code ? { code } : {}),
      at: now(),
    }
  }

  function scheduleNext(delayMs: number) {
    if (!running || draining || active || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (!running || draining || active) return
      void runCycle().catch(() => undefined)
    }, delayMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  function runCycle(): Promise<OutboxPublisherCycleResult> {
    if (activeCycle) return activeCycle
    if (draining) return Promise.reject({ name: 'OutboxPublisherDraining', at: now() })
    active = true
    const operation = (async () => {
      try {
        const result = await options.publisher.runOnce()
        initialized = true
        const completedAt = now()
        lastCycle = { status: result.status, at: completedAt }
        if (result.status === 'published') {
          consecutiveDeliveryFailures = 0
          lastPublishedAt = completedAt
          // A successful retry proves transient delivery recovery. Dead letters
          // remain latched because they require explicit operator remediation.
          if (deadLetteredSinceStart === 0) deliveryDegraded = false
        } else if (
          result.status === 'retry_scheduled'
          || result.status === 'dead_lettered'
          || result.status === 'lost_lease'
        ) {
          deliveryDegraded = true
          consecutiveDeliveryFailures += 1
          if (result.status === 'dead_lettered') deadLetteredSinceStart += 1
          lastDeliveryFailure = { status: result.status, at: completedAt }
        }
        lastError = undefined
        return result
      } catch (error) {
        const summary = safeError(error)
        lastError = summary
        throw { ...summary }
      } finally {
        active = false
        activeCycle = undefined
        if (draining) draining = false
        else scheduleNext(pollIntervalMs)
      }
    })()
    activeCycle = operation
    return operation
  }

  function start() {
    if (draining) throw new Error('outbox publisher host is draining')
    if (running) return
    running = true
    scheduleNext(0)
  }

  function runOnce() {
    clearPollTimer()
    return runCycle()
  }

  async function stop(stopOptions: { drainMs?: number } = {}): Promise<OutboxPublisherStopResult> {
    if (stopOperation) return await stopOperation
    const drainMs = stopOptions.drainMs ?? 30_000
    if (!Number.isSafeInteger(drainMs) || drainMs < 0) {
      throw new Error('drainMs must be a non-negative safe integer')
    }
    const operation = (async () => {
      running = false
      clearPollTimer()
      const cycle = activeCycle
      if (!cycle) {
        draining = false
        return { drained: true, timedOut: false }
      }
      draining = true
      const completed = await waitForCycle(cycle, drainMs)
      if (completed) {
        draining = false
        return { drained: true, timedOut: false }
      }

      // Best-effort cooperative cancellation. The lease remains the authority:
      // ignored or ambiguous aborts are safely reclaimed and may be delivered again.
      options.publisher.abortActive()
      await Promise.resolve()
      if (!active) {
        draining = false
        return { drained: true, timedOut: true }
      }
      return { drained: false, timedOut: true }
    })()
    stopOperation = operation
    try {
      return await operation
    } finally {
      if (stopOperation === operation) stopOperation = undefined
    }
  }

  function readiness(): OutboxPublisherReadiness {
    return {
      running,
      draining,
      active,
      initialized,
      deliveryDegraded,
      consecutiveDeliveryFailures,
      deadLetteredSinceStart,
      ...(lastPublishedAt ? { lastPublishedAt } : {}),
      ...(lastDeliveryFailure ? { lastDeliveryFailure: { ...lastDeliveryFailure } } : {}),
      ...(lastCycle ? { lastCycle: { ...lastCycle } } : {}),
      ...(lastError ? { lastError: { ...lastError } } : {}),
    }
  }

  return { start, runOnce, stop, readiness }
}

async function waitForCycle(cycle: Promise<unknown>, drainMs: number): Promise<boolean> {
  if (drainMs === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), drainMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  const settled = cycle.then(() => true, () => true)
  const completed = await Promise.race([settled, timeout])
  if (timer !== undefined) clearTimeout(timer)
  return completed
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}

function safeErrorName(error: unknown) {
  if (!(error instanceof Error)) return 'UnknownError'
  return error.name === 'AbortError' || error.name === 'TimeoutError'
    || error.name === 'OutboxPublisherMutationError'
    ? error.name
    : 'Error'
}
