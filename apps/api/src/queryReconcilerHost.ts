import type {
  DurableQueryReconciler,
  QueryReconciliationBatchReport,
} from '../../../src/persistence/queryReconcilerPorts'

export interface QueryReconcilerHostOptions {
  reconciler: DurableQueryReconciler
  intervalMs?: number
  batchLimit?: number
  now?: () => string
}

export interface QueryReconcilerBatchSummary {
  scanned: number
  repaired: number
  alerted: number
  at: string
}

export interface QueryReconcilerErrorSummary {
  name: string
  at: string
}

export interface QueryReconcilerReadiness {
  running: boolean
  draining: boolean
  active: boolean
  initialized: boolean
  lastBatch?: QueryReconcilerBatchSummary
  lastError?: QueryReconcilerErrorSummary
}

export interface QueryReconcilerStopResult {
  drained: boolean
  timedOut: boolean
}

export interface QueryReconcilerHost {
  start(): void
  runOnce(): Promise<QueryReconciliationBatchReport>
  stop(options?: { drainMs?: number }): Promise<QueryReconcilerStopResult>
  readiness(): QueryReconcilerReadiness
}

/**
 * Periodic single-flight host for the durable reconciler. Findings stay in the
 * explicit runOnce result; readiness contains aggregate counts only.
 */
export function createQueryReconcilerHost(options: QueryReconcilerHostOptions): QueryReconcilerHost {
  const intervalMs = options.intervalMs ?? 60_000
  const batchLimit = options.batchLimit ?? 100
  positiveInteger(intervalMs, 'intervalMs')
  positiveInteger(batchLimit, 'batchLimit')
  if (batchLimit > 500) throw new Error('batchLimit cannot exceed 500')
  const now = options.now ?? (() => new Date().toISOString())

  let running = false
  let draining = false
  let active = false
  let initialized = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let activeCycle: Promise<QueryReconciliationBatchReport> | undefined
  let stopOperation: Promise<QueryReconcilerStopResult> | undefined
  let lastBatch: QueryReconcilerBatchSummary | undefined
  let lastError: QueryReconcilerErrorSummary | undefined

  function clearTimer() {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }

  function safeError(error: unknown): QueryReconcilerErrorSummary {
    return {
      name: error instanceof Error && error.name ? error.name : 'UnknownError',
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

  function runCycle(): Promise<QueryReconciliationBatchReport> {
    if (activeCycle) return activeCycle
    if (draining) return Promise.reject({ name: 'QueryReconcilerDraining', at: now() })
    active = true
    const operation = (async () => {
      try {
        const report = await options.reconciler.reconcileBatch({ now: now(), limit: batchLimit })
        lastBatch = {
          scanned: report.scanned,
          repaired: report.repaired,
          alerted: report.alerted,
          at: now(),
        }
        initialized = true
        lastError = undefined
        return report
      } catch (error) {
        const summary = safeError(error)
        lastError = summary
        // Reject with the safe summary only; never retain cause/message/stack.
        throw { ...summary }
      } finally {
        active = false
        activeCycle = undefined
        if (draining) draining = false
        else scheduleNext(intervalMs)
      }
    })()
    activeCycle = operation
    return operation
  }

  function start() {
    if (draining) throw new Error('query reconciler host is draining')
    if (running) return
    running = true
    scheduleNext(0)
  }

  function runOnce() {
    clearTimer()
    return runCycle()
  }

  async function stop(stopOptions: { drainMs?: number } = {}): Promise<QueryReconcilerStopResult> {
    if (stopOperation) return await stopOperation
    const drainMs = stopOptions.drainMs ?? 30_000
    if (!Number.isInteger(drainMs) || drainMs < 0) throw new Error('drainMs must be a non-negative integer')
    const operation = (async () => {
      running = false
      clearTimer()
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
      return { drained: false, timedOut: true }
    })()
    stopOperation = operation
    try {
      return await operation
    } finally {
      if (stopOperation === operation) stopOperation = undefined
    }
  }

  function readiness(): QueryReconcilerReadiness {
    return {
      running,
      draining,
      active,
      initialized,
      ...(lastBatch ? { lastBatch: { ...lastBatch } } : {}),
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
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}
