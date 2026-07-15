import type {
  LeaseMutationInput,
  RunJobFailure,
  RunJobLease,
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
  isLeaseCurrent(now: string): boolean
  renew(now: string, leaseMs: number): boolean
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
  now?: () => string
  classifyThrownError?: (error: unknown, at: string) => RunWorkerHandlerResult<TResult>
  /** Runs synchronously after the fenced queue mutation wins. */
  onCommitted?: (commit: RunWorkerCommit<TPayload, TResult>) => void
}

export interface RunWorkerCommit<TPayload, TResult> {
  lease: RunJobLease<TPayload>
  outcome: RunWorkerHandlerResult<TResult>
  job: RunJobView<TPayload, TResult>
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

  async function runOnce(runId?: string): Promise<RunWorkerCycleResult> {
    const claimedAt = now()
    const lease = options.queue.claimNext({
      workerId: options.workerId,
      now: claimedAt,
      leaseMs: options.leaseMs,
      runId,
    })
    if (!lease) return { status: 'idle' }

    const identity = leaseIdentity(lease)
    const cancellation = new AbortController()
    const unsubscribeCancellation = options.queue.onCancelled(lease.runId, () => cancellation.abort())
    const context: RunWorkerContext = {
      attempt: lease.attempt,
      maxAttempts: lease.maxAttempts,
      fence: lease.fence,
      leaseExpiresAt: lease.leaseExpiresAt,
      signal: cancellation.signal,
      isLeaseCurrent(at) {
        return options.queue.isLeaseCurrent(identity, at)
      },
      renew(at, leaseMs) {
        return options.queue.renewLease({ ...identity, now: at, leaseMs }).ok
      },
    }

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
      unsubscribeCancellation()
    }

    const mutation = outcome.type === 'completed'
      ? options.queue.complete({
          ...identity,
          completedAt: outcome.at,
          result: outcome.result,
          resultFingerprint: outcome.resultFingerprint,
        })
      : outcome.type === 'retry'
        ? options.queue.retry({
            ...identity,
            failedAt: outcome.failedAt,
            availableAt: outcome.availableAt,
            failure: outcome.failure,
          })
        : options.queue.fail({
            ...identity,
            failedAt: outcome.failedAt,
            failure: outcome.failure,
          })

    if (mutation.ok) {
      if (mutation.applied) options.onCommitted?.({ lease, outcome, job: mutation.job })
      return {
        status: outcome.type === 'retry' ? 'retry_scheduled' : outcome.type,
        runId: lease.runId,
        attempt: lease.attempt,
      }
    }
    const current = options.queue.getJob(lease.runId)
    return {
      status: current?.status === 'cancelled' ? 'cancelled' : 'lost_lease',
      runId: lease.runId,
      attempt: lease.attempt,
    }
  }

  return { runOnce }
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
