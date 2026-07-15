export type RunJobStatus =
  | 'queued'
  | 'leased'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type MaybePromise<T> = T | Promise<T>
export type RunJobCancellationSubscription = () => MaybePromise<void>

export type RunJobAttemptOutcome =
  | 'completed'
  | 'failed'
  | 'retry_scheduled'
  | 'cancelled'
  | 'lease_expired'

export interface RunJobFailure {
  code: string
  message: string
  retryable: boolean
  debugReference?: string
}

export interface RunJobAttemptView {
  attempt: number
  fence: number
  workerId: string
  startedAt: string
  leaseExpiresAt: string
  endedAt?: string
  outcome?: RunJobAttemptOutcome
  failure?: RunJobFailure
}

export interface RunJobView<TPayload = unknown, TResult = unknown> {
  runId: string
  tenantId: string
  workspaceId: string
  payloadFingerprint: string
  payload: TPayload
  status: RunJobStatus
  attempt: number
  maxAttempts: number
  fence: number
  enqueuedAt: string
  availableAt: string
  leaseOwner?: string
  leaseExpiresAt?: string
  cancelRequestedAt?: string
  completedAt?: string
  failedAt?: string
  cancelledAt?: string
  lastFailure?: RunJobFailure
  resultFingerprint?: string
  result?: TResult
  attempts: RunJobAttemptView[]
}

export interface EnqueueRunJobInput<TPayload> {
  runId: string
  tenantId: string
  workspaceId: string
  payloadFingerprint: string
  payload: TPayload
  enqueuedAt: string
  availableAt?: string
  maxAttempts?: number
}

export type EnqueueRunJobResult<TPayload, TResult> =
  | { ok: true; created: boolean; job: RunJobView<TPayload, TResult> }
  | { ok: false; reason: 'idempotency_conflict'; job: RunJobView<TPayload, TResult> }

export interface ClaimRunJobInput {
  workerId: string
  now: string
  leaseMs: number
  /** Restricts inline draining to the just-enqueued run. */
  runId?: string
}

export interface RunJobLease<TPayload = unknown> {
  runId: string
  tenantId: string
  workspaceId: string
  payload: TPayload
  payloadFingerprint: string
  attempt: number
  maxAttempts: number
  fence: number
  workerId: string
  leaseToken: string
  claimedAt: string
  leaseExpiresAt: string
}

export interface LeaseMutationInput {
  runId: string
  attempt: number
  fence: number
  workerId: string
  leaseToken: string
}

export type RunJobMutationFailureReason =
  | 'not_found'
  | 'stale_lease'
  | 'lease_expired'
  | 'terminal_conflict'
  | 'invalid_state'
  | 'attempts_exhausted'
  | 'failure_not_retryable'

export type RunJobMutationResult<TPayload, TResult> =
  | { ok: true; applied: boolean; job: RunJobView<TPayload, TResult> }
  | { ok: false; reason: RunJobMutationFailureReason; job?: RunJobView<TPayload, TResult> }

export type CancelRunJobResult<TPayload, TResult> =
  | { ok: true; applied: boolean; job: RunJobView<TPayload, TResult> }
  | { ok: false; reason: 'not_found' | 'terminal_conflict'; job?: RunJobView<TPayload, TResult> }

export interface CompleteRunJobInput<TResult> extends LeaseMutationInput {
  completedAt: string
  resultFingerprint: string
  result: TResult
}

export interface FailRunJobInput extends LeaseMutationInput {
  failedAt: string
  failure: RunJobFailure
}

export interface RetryRunJobInput extends LeaseMutationInput {
  failedAt: string
  availableAt: string
  failure: RunJobFailure
}

export interface RenewRunJobLeaseInput extends LeaseMutationInput {
  now: string
  leaseMs: number
}

/**
 * Internal run-work queue contract. It intentionally contains no Node-specific
 * types so the same deterministic adapter can exercise inline browser demos.
 * Lease tokens are only returned from claim and must never enter PublicRunView.
 */
export interface RunJobQueue<TPayload = unknown, TResult = unknown> {
  enqueue(input: EnqueueRunJobInput<TPayload>): MaybePromise<EnqueueRunJobResult<TPayload, TResult>>
  claimNext(input: ClaimRunJobInput): MaybePromise<RunJobLease<TPayload> | undefined>
  renewLease(input: RenewRunJobLeaseInput): MaybePromise<RunJobMutationResult<TPayload, TResult>>
  cancel(runId: string, cancelledAt: string): MaybePromise<CancelRunJobResult<TPayload, TResult>>
  complete(input: CompleteRunJobInput<TResult>): MaybePromise<RunJobMutationResult<TPayload, TResult>>
  fail(input: FailRunJobInput): MaybePromise<RunJobMutationResult<TPayload, TResult>>
  retry(input: RetryRunJobInput): MaybePromise<RunJobMutationResult<TPayload, TResult>>
  getJob(runId: string): MaybePromise<RunJobView<TPayload, TResult> | undefined>
  isLeaseCurrent(lease: LeaseMutationInput, now: string): MaybePromise<boolean>
  /**
   * Fires when the job becomes cancelled; registration after cancellation must
   * fire immediately. Durable adapters may implement this with notify + read,
   * polling, or another at-least-once observation mechanism.
   */
  onCancelled(runId: string, listener: () => void): MaybePromise<RunJobCancellationSubscription>
}

/** Keeps local/browser fixtures source-compatible while production adapters await the base port. */
export interface SynchronousRunJobQueue<TPayload = unknown, TResult = unknown>
  extends RunJobQueue<TPayload, TResult> {
  enqueue(input: EnqueueRunJobInput<TPayload>): EnqueueRunJobResult<TPayload, TResult>
  claimNext(input: ClaimRunJobInput): RunJobLease<TPayload> | undefined
  renewLease(input: RenewRunJobLeaseInput): RunJobMutationResult<TPayload, TResult>
  cancel(runId: string, cancelledAt: string): CancelRunJobResult<TPayload, TResult>
  complete(input: CompleteRunJobInput<TResult>): RunJobMutationResult<TPayload, TResult>
  fail(input: FailRunJobInput): RunJobMutationResult<TPayload, TResult>
  retry(input: RetryRunJobInput): RunJobMutationResult<TPayload, TResult>
  getJob(runId: string): RunJobView<TPayload, TResult> | undefined
  isLeaseCurrent(lease: LeaseMutationInput, now: string): boolean
  onCancelled(runId: string, listener: () => void): RunJobCancellationSubscription
}
