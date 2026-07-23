import type {
  LeaseMutationInput,
  MaybePromise,
  RunJobFailure,
  RunJobLease,
  RunJobMutationResult,
  RunJobQueue,
  RunJobView,
} from '../persistence/jobPorts'

export type RunWorkerHandlerResult<TResult> =
  | { type: 'completed'; result: TResult; resultFingerprint: string; at: string }
  | { type: 'retry'; failure: RunJobFailure; failedAt: string; availableAt: string }
  | { type: 'failed'; failure: RunJobFailure; failedAt: string }

export interface RunWorkerContext {
  attempt: number
  maxAttempts: number
  fence: number
  leaseExpiresAt: string
  signal: AbortSignal
  isLeaseCurrent(now: string): Promise<boolean>
  renew(now: string, leaseMs: number): Promise<boolean>
}

export interface RunWorkerHandler<TPayload, TResult> {
  execute(
    payload: TPayload,
    context: RunWorkerContext,
  ): RunWorkerHandlerResult<TResult> | Promise<RunWorkerHandlerResult<TResult>>
}

export interface RunWorkerOptions<TPayload, TResult> {
  queue: RunJobQueue<TPayload, TResult>
  handler: RunWorkerHandler<TPayload, TResult>
  workerId: string
  leaseMs: number
  heartbeatMs?: number
  now?: () => string
  classifyThrownError?: (error: unknown, at: string) => RunWorkerHandlerResult<TResult>
  /**
   * Durable transaction authority. When supplied it fully replaces the queue's
   * complete/fail/retry mutation for this attempt.
   */
  commitAttempt?: (
    input: RunWorkerCommitAttemptInput<TPayload, TResult>,
  ) => MaybePromise<RunJobMutationResult<TPayload, TResult>>
  /** Best-effort notification/cache hook after the durable mutation wins. */
  onCommitted?: (commit: RunWorkerCommit<TPayload, TResult>) => MaybePromise<void>
  /** Best-effort telemetry for onCommitted failures; its own failures are swallowed. */
  onPostCommitError?: (
    error: unknown,
    commit: RunWorkerCommit<TPayload, TResult>,
  ) => MaybePromise<void>
}

export interface RunWorkerCommitAttemptInput<TPayload, TResult> {
  lease: RunJobLease<TPayload>
  outcome: RunWorkerHandlerResult<TResult>
}

export interface RunWorkerCommit<TPayload, TResult> {
  lease: RunJobLease<TPayload>
  outcome: RunWorkerHandlerResult<TResult>
  job: RunJobView<TPayload, TResult>
}

export class RunWorkerCommitAttemptError extends Error {
  readonly code = 'RUN_WORKER_COMMIT_FAILED'

  constructor(cause: unknown) {
    super('Atomic run attempt commit failed.', { cause })
    this.name = 'RunWorkerCommitAttemptError'
  }
}

export type RunWorkerCycleResult =
  | { status: 'idle' }
  | { status: 'completed' | 'retry_scheduled' | 'failed'; runId: string; attempt: number }
  | { status: 'cancelled' | 'lost_lease'; runId: string; attempt: number }

/**
 * A small single-cycle worker shared by inline demos and background runtimes.
 * Queue fencing, rather than handler cooperation, is the final authority: a
 * cancelled or superseded attempt can never publish its outcome.
 */
export function createRunWorker<TPayload, TResult>(options: RunWorkerOptions<TPayload, TResult>) {
  const now = options.now ?? (() => new Date().toISOString())
  const heartbeatMs = resolveHeartbeatMs(options.leaseMs, options.heartbeatMs)
  let activeCancellation: AbortController | undefined

  async function runOnce(runId?: string): Promise<RunWorkerCycleResult> {
    const claimedAt = now()
    const lease = await options.queue.claimNext({
      workerId: options.workerId,
      now: claimedAt,
      leaseMs: options.leaseMs,
      runId,
    })
    if (!lease) return { status: 'idle' }

    const identity = leaseIdentity(lease)
    const cancellation = new AbortController()
    activeCancellation = cancellation
    let unsubscribeCancellation: () => MaybePromise<void>
    try {
      unsubscribeCancellation = await options.queue.onCancelled(lease.runId, () => cancellation.abort())
    } catch (error) {
      if (activeCancellation === cancellation) activeCancellation = undefined
      throw error
    }
    let heartbeatStopped = false
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeatInFlight: Promise<void> | undefined
    let renewInFlight: Promise<boolean> | undefined
    let leaseLost = false

    function clearHeartbeatTimer() {
      if (heartbeatTimer === undefined) return
      clearTimeout(heartbeatTimer)
      heartbeatTimer = undefined
    }

    function markLeaseLost() {
      if (leaseLost) return
      leaseLost = true
      clearHeartbeatTimer()
      cancellation.abort()
    }

    function renewLease(at: string, leaseMs: number): Promise<boolean> {
      if (leaseLost) return Promise.resolve(false)
      if (renewInFlight) return renewInFlight
      const operation = (async () => {
        try {
          const renewed = await options.queue.renewLease({ ...identity, now: at, leaseMs })
          if (!renewed.ok) {
            markLeaseLost()
            return false
          }
          return true
        } catch {
          markLeaseLost()
          return false
        }
      })()
      renewInFlight = operation
      void operation.finally(() => {
        if (renewInFlight === operation) renewInFlight = undefined
      })
      return operation
    }

    function scheduleHeartbeat() {
      if (heartbeatStopped || leaseLost) return
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined
        const heartbeat = (async () => {
          const renewed = await renewLease(now(), options.leaseMs)
          if (renewed && !heartbeatStopped && !leaseLost) scheduleHeartbeat()
        })()
        heartbeatInFlight = heartbeat
        void heartbeat.finally(() => {
          if (heartbeatInFlight === heartbeat) heartbeatInFlight = undefined
        })
      }, heartbeatMs)
      ;(heartbeatTimer as unknown as { unref?: () => void }).unref?.()
    }

    async function stopHeartbeat() {
      heartbeatStopped = true
      clearHeartbeatTimer()
      const pending = [heartbeatInFlight, renewInFlight].filter(Boolean) as Promise<unknown>[]
      if (pending.length > 0) await Promise.all(pending)
    }

    const context: RunWorkerContext = {
      attempt: lease.attempt,
      maxAttempts: lease.maxAttempts,
      fence: lease.fence,
      leaseExpiresAt: lease.leaseExpiresAt,
      signal: cancellation.signal,
      async isLeaseCurrent(at) {
        return await options.queue.isLeaseCurrent(identity, at)
      },
      async renew(at, leaseMs) {
        return await renewLease(at, leaseMs)
      },
    }

    scheduleHeartbeat()
    let outcome: RunWorkerHandlerResult<TResult>
    try {
      outcome = await options.handler.execute(lease.payload, context)
    } catch (error) {
      const failedAt = now()
      outcome = options.classifyThrownError?.(error, failedAt) ?? {
        type: 'failed',
        failedAt,
        failure: {
          code: 'WORKER_UNHANDLED_ERROR',
          message: error instanceof Error ? error.message : 'Unhandled worker error',
          retryable: false,
        },
      }
    } finally {
      await stopHeartbeat()
      await unsubscribeCancellation()
      if (activeCancellation === cancellation) activeCancellation = undefined
    }

    if (leaseLost) return await leaseLossResult(options.queue, lease)

    let mutation: RunJobMutationResult<TPayload, TResult>
    if (options.commitAttempt) {
      try {
        mutation = await options.commitAttempt({ lease, outcome })
      } catch (error) {
        // Never fall back after an ambiguous durable commit; the hook must be
        // idempotent so a supervisor can safely retry or reconcile the attempt.
        throw new RunWorkerCommitAttemptError(error)
      }
    } else {
      mutation = outcome.type === 'completed'
        ? await options.queue.complete({
            ...identity,
            completedAt: outcome.at,
            result: outcome.result,
            resultFingerprint: outcome.resultFingerprint,
          })
        : outcome.type === 'retry'
          ? await options.queue.retry({
              ...identity,
              failedAt: outcome.failedAt,
              availableAt: outcome.availableAt,
              failure: outcome.failure,
            })
          : await options.queue.fail({
              ...identity,
              failedAt: outcome.failedAt,
              failure: outcome.failure,
            })
    }

    if (mutation.ok) {
      if (mutation.applied && options.onCommitted) {
        const commit = { lease, outcome, job: mutation.job }
        try {
          await options.onCommitted(commit)
        } catch (error) {
          try {
            await options.onPostCommitError?.(error, commit)
          } catch {
            // Durable state already won. Telemetry/cache failures cannot replay it.
          }
        }
      }
      return {
        status: outcome.type === 'retry' ? 'retry_scheduled' : outcome.type,
        runId: lease.runId,
        attempt: lease.attempt,
      }
    }
    return await leaseLossResult(options.queue, lease)
  }

  return {
    runOnce,
    abortActive() {
      activeCancellation?.abort()
    },
  }
}

async function leaseLossResult<TPayload, TResult>(
  queue: RunJobQueue<TPayload, TResult>,
  lease: RunJobLease<TPayload>,
): Promise<RunWorkerCycleResult> {
  try {
    const current = await queue.getJob(lease.runId)
    return {
      status: current?.status === 'cancelled' ? 'cancelled' : 'lost_lease',
      runId: lease.runId,
      attempt: lease.attempt,
    }
  } catch {
    return { status: 'lost_lease', runId: lease.runId, attempt: lease.attempt }
  }
}

function resolveHeartbeatMs(leaseMs: number, configured?: number) {
  if (!Number.isInteger(leaseMs) || leaseMs < 2) throw new Error('leaseMs must be an integer greater than one')
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured < 1 || configured >= leaseMs) {
      throw new Error('heartbeatMs must be a positive integer smaller than leaseMs')
    }
    return configured
  }
  const minimumHeartbeatMs = 100
  return Math.min(Math.max(minimumHeartbeatMs, Math.floor(leaseMs / 3)), leaseMs - 1)
}

function leaseIdentity<TPayload>(lease: RunJobLease<TPayload>): LeaseMutationInput {
  return {
    runId: lease.runId,
    attempt: lease.attempt,
    fence: lease.fence,
    workerId: lease.workerId,
    leaseToken: lease.leaseToken,
  }
}
