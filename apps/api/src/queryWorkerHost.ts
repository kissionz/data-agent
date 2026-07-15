import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { RunWorkerCycleResult } from '../../../src/application/runWorker'

type MaybePromise<T> = T | Promise<T>

export interface QueryWorkerCycleRunner {
  runOnce(): Promise<RunWorkerCycleResult>
}

export interface QueryWorkerHostOptions {
  createRunner(workerId: string): QueryWorkerCycleRunner
  workerId?: string
  workerIdFactory?: () => string
  pollIntervalMs?: number
  now?: () => string
  abortActive?: () => MaybePromise<void>
  close?: () => MaybePromise<void>
}

export interface QueryWorkerCycleSummary {
  status: RunWorkerCycleResult['status']
  at: string
  attempt?: number
}

export interface QueryWorkerErrorSummary {
  kind: 'cycle' | 'abort' | 'close'
  name: string
  at: string
}

export interface QueryWorkerReadiness {
  workerId: string
  running: boolean
  draining: boolean
  active: boolean
  lastCycle?: QueryWorkerCycleSummary
  lastError?: QueryWorkerErrorSummary
}

export interface QueryWorkerStopResult {
  drained: boolean
  timedOut: boolean
}

export interface QueryWorkerHost {
  readonly workerId: string
  start(): void
  runOnce(): Promise<RunWorkerCycleResult>
  stop(options?: { drainMs?: number }): Promise<QueryWorkerStopResult>
  readiness(): QueryWorkerReadiness
}

/**
 * Creates a process-unique worker identity without embedding credentials or
 * other deployment configuration in operational status responses.
 */
export function createDefaultQueryWorkerId(): string {
  return `query-worker:${hostname()}:${process.pid}:${randomUUID()}`
}

/**
 * Hosts a single query worker runner. The next poll is scheduled only after the
 * current cycle settles, so slow database calls can never create overlapping
 * claims in one process.
 */
export function createQueryWorkerHost(options: QueryWorkerHostOptions): QueryWorkerHost {
  const pollIntervalMs = options.pollIntervalMs ?? 250
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error('pollIntervalMs must be a positive integer')
  }

  const now = options.now ?? (() => new Date().toISOString())
  const workerId = options.workerId ?? (options.workerIdFactory ?? createDefaultQueryWorkerId)()
  if (!workerId.trim()) throw new Error('workerId must not be empty')
  const runner = options.createRunner(workerId)

  let running = false
  let draining = false
  let active = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeCycle: Promise<RunWorkerCycleResult> | undefined
  let stopOperation: Promise<QueryWorkerStopResult> | undefined
  let closeOperation: Promise<void> | undefined
  let lastCycle: QueryWorkerCycleSummary | undefined
  let lastError: QueryWorkerErrorSummary | undefined

  function clearPollTimer() {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  function safeError(kind: QueryWorkerErrorSummary['kind'], error: unknown): QueryWorkerErrorSummary {
    return {
      kind,
      name: error instanceof Error && error.name ? error.name : 'UnknownError',
      at: now(),
    }
  }

  async function closeAfterDrain() {
    if (closed) return
    if (active) return
    if (closeOperation) return await closeOperation
    closeOperation = (async () => {
      try {
        await options.close?.()
        closed = true
      } catch (error) {
        lastError = safeError('close', error)
        throw error
      } finally {
        closeOperation = undefined
      }
    })()
    await closeOperation
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

  function runCycle(): Promise<RunWorkerCycleResult> {
    if (activeCycle) return activeCycle
    if (closed) return Promise.reject(new Error('query worker host is closed'))
    if (draining) return Promise.reject(new Error('query worker host is draining'))
    active = true
    const operation = (async () => {
      try {
        const result = await runner.runOnce()
        lastCycle = {
          status: result.status,
          at: now(),
          ...('attempt' in result ? { attempt: result.attempt } : {}),
        }
        lastError = undefined
        return result
      } catch (error) {
        // A transient adapter/queue error must not tear down the poll loop.
        lastError = safeError('cycle', error)
        throw error
      } finally {
        active = false
        activeCycle = undefined
        if (draining) {
          void closeAfterDrain()
            .then(() => {
              draining = false
            })
            .catch(() => undefined)
        } else {
          scheduleNext(pollIntervalMs)
        }
      }
    })()
    activeCycle = operation
    return operation
  }

  function start() {
    if (closed) throw new Error('query worker host is closed')
    if (draining) throw new Error('query worker host is draining')
    if (running) return
    running = true
    scheduleNext(0)
  }

  function runOnce() {
    clearPollTimer()
    return runCycle()
  }

  async function stop(stopOptions: { drainMs?: number } = {}): Promise<QueryWorkerStopResult> {
    if (closed && !active) return { drained: true, timedOut: false }
    if (stopOperation) return await stopOperation
    const drainMs = stopOptions.drainMs ?? 30_000
    if (!Number.isInteger(drainMs) || drainMs < 0) throw new Error('drainMs must be a non-negative integer')

    const operation = (async () => {
      running = false
      draining = true
      clearPollTimer()

      const cycle = activeCycle
      if (!cycle) {
        await closeAfterDrain()
        draining = false
        return { drained: true, timedOut: false }
      }

      const completed = await waitForCycle(cycle, drainMs)
      if (completed) {
        await closeAfterDrain()
        draining = false
        return { drained: true, timedOut: false }
      }

      try {
        await options.abortActive?.()
      } catch (error) {
        lastError = safeError('abort', error)
      }

      // A cooperative abort commonly settles the cycle in the same turn.
      await Promise.resolve()
      if (!active) {
        await closeAfterDrain()
        draining = false
        return { drained: true, timedOut: true }
      }

      // stop() observes its deadline even if an adapter ignores cancellation.
      // The cycle's finally block will close resources once it eventually drains.
      return { drained: false, timedOut: true }
    })()
    stopOperation = operation
    try {
      return await operation
    } finally {
      if (stopOperation === operation) stopOperation = undefined
    }
  }

  function readiness(): QueryWorkerReadiness {
    return {
      workerId,
      running,
      draining,
      active,
      ...(lastCycle ? { lastCycle: { ...lastCycle } } : {}),
      ...(lastError ? { lastError: { ...lastError } } : {}),
    }
  }

  return { workerId, start, runOnce, stop, readiness }
}

async function waitForCycle(cycle: Promise<unknown>, drainMs: number): Promise<boolean> {
  if (drainMs === 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), drainMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  // A failed cycle is still settled and must not prevent graceful resource close.
  const completed = cycle.then(() => true, () => true)
  const result = await Promise.race([completed, timeout])
  if (timer !== undefined) clearTimeout(timer)
  return result
}
