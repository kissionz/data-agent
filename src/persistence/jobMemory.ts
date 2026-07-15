import type {
  CancelRunJobResult,
  ClaimRunJobInput,
  CompleteRunJobInput,
  EnqueueRunJobInput,
  EnqueueRunJobResult,
  FailRunJobInput,
  LeaseMutationInput,
  RenewRunJobLeaseInput,
  RetryRunJobInput,
  RunJobAttemptView,
  RunJobFailure,
  RunJobLease,
  RunJobMutationResult,
  RunJobQueue,
  RunJobView,
} from './jobPorts'

interface ActiveLease {
  attempt: number
  fence: number
  workerId: string
  token: string
  expiresAt: string
}

interface TerminalMutation {
  kind: 'completed' | 'failed' | 'retry_scheduled'
  attempt: number
  fence: number
  workerId: string
  leaseToken: string
  fingerprint: string
}

interface StoredRunJob<TPayload, TResult> extends RunJobView<TPayload, TResult> {
  lease?: ActiveLease
  terminalMutation?: TerminalMutation
}

export interface InMemoryRunJobQueueOptions {
  leaseToken?: () => string
}

export function createInMemoryRunJobQueue<TPayload = unknown, TResult = unknown>(
  options: InMemoryRunJobQueueOptions = {},
): RunJobQueue<TPayload, TResult> {
  const jobs = new Map<string, StoredRunJob<TPayload, TResult>>()
  const cancellationListeners = new Map<string, Set<() => void>>()
  let tokenSequence = 0
  const nextLeaseToken = options.leaseToken ?? (() => {
    tokenSequence += 1
    return `run_lease_${String(tokenSequence).padStart(8, '0')}`
  })

  function enqueue(input: EnqueueRunJobInput<TPayload>): EnqueueRunJobResult<TPayload, TResult> {
    assertNonEmpty(input.runId, 'runId')
    assertNonEmpty(input.tenantId, 'tenantId')
    assertNonEmpty(input.workspaceId, 'workspaceId')
    assertNonEmpty(input.payloadFingerprint, 'payloadFingerprint')
    instant(input.enqueuedAt, 'enqueuedAt')
    const availableAt = input.availableAt ?? input.enqueuedAt
    instant(availableAt, 'availableAt')
    const maxAttempts = input.maxAttempts ?? 3
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts must be a positive integer')

    const existing = jobs.get(input.runId)
    if (existing) {
      const sameIdentity = existing.tenantId === input.tenantId
        && existing.workspaceId === input.workspaceId
        && existing.payloadFingerprint === input.payloadFingerprint
      return sameIdentity
        ? { ok: true, created: false, job: view(existing) }
        : { ok: false, reason: 'idempotency_conflict', job: view(existing) }
    }

    const created: StoredRunJob<TPayload, TResult> = {
      runId: input.runId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      payloadFingerprint: input.payloadFingerprint,
      payload: clone(input.payload),
      status: 'queued',
      attempt: 0,
      maxAttempts,
      fence: 0,
      enqueuedAt: input.enqueuedAt,
      availableAt,
      attempts: [],
    }
    jobs.set(input.runId, created)
    return { ok: true, created: true, job: view(created) }
  }

  function claimNext(input: ClaimRunJobInput): RunJobLease<TPayload> | undefined {
    assertNonEmpty(input.workerId, 'workerId')
    const nowMs = instant(input.now, 'now')
    assertLeaseMs(input.leaseMs)

    const ordered = [...jobs.values()].filter((job) => !input.runId || job.runId === input.runId).sort((left, right) => {
      const byAvailability = instant(left.availableAt, 'availableAt') - instant(right.availableAt, 'availableAt')
      if (byAvailability !== 0) return byAvailability
      const byEnqueue = instant(left.enqueuedAt, 'enqueuedAt') - instant(right.enqueuedAt, 'enqueuedAt')
      return byEnqueue !== 0 ? byEnqueue : left.runId.localeCompare(right.runId)
    })

    for (const job of ordered) {
      const expiredLease = job.status === 'leased' && job.lease && instant(job.lease.expiresAt, 'leaseExpiresAt') <= nowMs
      const waiting = (job.status === 'queued' || job.status === 'retry_wait')
        && instant(job.availableAt, 'availableAt') <= nowMs
      if (!expiredLease && !waiting) continue

      if (expiredLease) {
        closeAttempt(job, job.attempt, input.now, 'lease_expired', leaseExpiredFailure())
        job.lastFailure = leaseExpiredFailure()
        job.lease = undefined
      }
      if (job.attempt >= job.maxAttempts) {
        job.status = 'failed'
        job.failedAt = input.now
        job.lastFailure = job.lastFailure ?? leaseExpiredFailure()
        continue
      }

      job.attempt += 1
      job.fence += 1
      const expiresAt = new Date(nowMs + input.leaseMs).toISOString()
      const token = nextLeaseToken()
      assertNonEmpty(token, 'leaseToken')
      job.status = 'leased'
      job.leaseOwner = input.workerId
      job.leaseExpiresAt = expiresAt
      job.lease = {
        attempt: job.attempt,
        fence: job.fence,
        workerId: input.workerId,
        token,
        expiresAt,
      }
      job.terminalMutation = undefined
      job.attempts.push({
        attempt: job.attempt,
        fence: job.fence,
        workerId: input.workerId,
        startedAt: input.now,
        leaseExpiresAt: expiresAt,
      })
      return {
        runId: job.runId,
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        payload: clone(job.payload),
        payloadFingerprint: job.payloadFingerprint,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        fence: job.fence,
        workerId: input.workerId,
        leaseToken: token,
        claimedAt: input.now,
        leaseExpiresAt: expiresAt,
      }
    }
    return undefined
  }

  function renewLease(input: RenewRunJobLeaseInput): RunJobMutationResult<TPayload, TResult> {
    const nowMs = instant(input.now, 'now')
    assertLeaseMs(input.leaseMs)
    const checked = checkLease(input, nowMs)
    if (!checked.ok) return checked.result
    const expiresAt = new Date(nowMs + input.leaseMs).toISOString()
    checked.job.lease!.expiresAt = expiresAt
    checked.job.leaseExpiresAt = expiresAt
    const attempt = currentAttempt(checked.job)
    attempt.leaseExpiresAt = expiresAt
    return { ok: true, applied: true, job: view(checked.job) }
  }

  function cancel(runId: string, cancelledAt: string): CancelRunJobResult<TPayload, TResult> {
    instant(cancelledAt, 'cancelledAt')
    const job = jobs.get(runId)
    if (!job) return { ok: false, reason: 'not_found' }
    if (job.status === 'cancelled') return { ok: true, applied: false, job: view(job) }
    if (job.status === 'completed' || job.status === 'failed') {
      return { ok: false, reason: 'terminal_conflict', job: view(job) }
    }

    job.cancelRequestedAt = job.cancelRequestedAt ?? cancelledAt
    job.cancelledAt = cancelledAt
    job.status = 'cancelled'
    if (job.lease) closeAttempt(job, job.lease.attempt, cancelledAt, 'cancelled')
    clearLease(job)
    for (const listener of cancellationListeners.get(runId) ?? []) {
      try {
        listener()
      } catch {
        // Cancellation fencing is already committed; observers cannot roll it back.
      }
    }
    cancellationListeners.delete(runId)
    return { ok: true, applied: true, job: view(job) }
  }

  function complete(input: CompleteRunJobInput<TResult>): RunJobMutationResult<TPayload, TResult> {
    instant(input.completedAt, 'completedAt')
    assertNonEmpty(input.resultFingerprint, 'resultFingerprint')
    const job = jobs.get(input.runId)
    if (job?.status === 'completed' && matchesTerminal(job, input, 'completed', input.resultFingerprint)) {
      return { ok: true, applied: false, job: view(job) }
    }
    const checked = checkLease(input, instant(input.completedAt, 'completedAt'))
    if (!checked.ok) return checked.result

    checked.job.status = 'completed'
    checked.job.completedAt = input.completedAt
    checked.job.resultFingerprint = input.resultFingerprint
    checked.job.result = clone(input.result)
    closeAttempt(checked.job, input.attempt, input.completedAt, 'completed')
    checked.job.terminalMutation = terminal(input, 'completed', input.resultFingerprint)
    clearLease(checked.job)
    return { ok: true, applied: true, job: view(checked.job) }
  }

  function fail(input: FailRunJobInput): RunJobMutationResult<TPayload, TResult> {
    instant(input.failedAt, 'failedAt')
    const fingerprint = failureFingerprint(input.failure)
    const job = jobs.get(input.runId)
    if (job?.status === 'failed' && matchesTerminal(job, input, 'failed', fingerprint)) {
      return { ok: true, applied: false, job: view(job) }
    }
    const checked = checkLease(input, instant(input.failedAt, 'failedAt'))
    if (!checked.ok) return checked.result

    checked.job.status = 'failed'
    checked.job.failedAt = input.failedAt
    checked.job.lastFailure = clone(input.failure)
    closeAttempt(checked.job, input.attempt, input.failedAt, 'failed', input.failure)
    checked.job.terminalMutation = terminal(input, 'failed', fingerprint)
    clearLease(checked.job)
    return { ok: true, applied: true, job: view(checked.job) }
  }

  function retry(input: RetryRunJobInput): RunJobMutationResult<TPayload, TResult> {
    const failedAtMs = instant(input.failedAt, 'failedAt')
    const availableAtMs = instant(input.availableAt, 'availableAt')
    if (availableAtMs < failedAtMs) throw new Error('availableAt cannot be before failedAt')
    const fingerprint = `${failureFingerprint(input.failure)}:${input.availableAt}`
    const job = jobs.get(input.runId)
    if (job?.status === 'retry_wait' && matchesTerminal(job, input, 'retry_scheduled', fingerprint)) {
      return { ok: true, applied: false, job: view(job) }
    }
    const checked = checkLease(input, failedAtMs)
    if (!checked.ok) return checked.result
    if (!input.failure.retryable) {
      return { ok: false, reason: 'failure_not_retryable', job: view(checked.job) }
    }
    if (checked.job.attempt >= checked.job.maxAttempts) {
      return { ok: false, reason: 'attempts_exhausted', job: view(checked.job) }
    }

    checked.job.status = 'retry_wait'
    checked.job.availableAt = input.availableAt
    checked.job.lastFailure = clone(input.failure)
    closeAttempt(checked.job, input.attempt, input.failedAt, 'retry_scheduled', input.failure)
    checked.job.terminalMutation = terminal(input, 'retry_scheduled', fingerprint)
    clearLease(checked.job)
    return { ok: true, applied: true, job: view(checked.job) }
  }

  function getJob(runId: string) {
    const job = jobs.get(runId)
    return job ? view(job) : undefined
  }

  function isLeaseCurrent(lease: LeaseMutationInput, now: string) {
    const job = jobs.get(lease.runId)
    const activeLease = job?.lease
    if (!job || !activeLease || !sameLease(activeLease, lease)) return false
    return job.status === 'leased' && instant(activeLease.expiresAt, 'leaseExpiresAt') > instant(now, 'now')
  }

  function onCancelled(runId: string, listener: () => void) {
    const job = jobs.get(runId)
    if (job?.status === 'cancelled') {
      listener()
      return () => undefined
    }
    const listeners = cancellationListeners.get(runId) ?? new Set<() => void>()
    listeners.add(listener)
    cancellationListeners.set(runId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) cancellationListeners.delete(runId)
    }
  }

  function checkLease(
    input: LeaseMutationInput,
    atMs: number,
  ): { ok: true; job: StoredRunJob<TPayload, TResult> } | { ok: false; result: RunJobMutationResult<TPayload, TResult> } {
    const job = jobs.get(input.runId)
    if (!job) return { ok: false, result: { ok: false, reason: 'not_found' } }
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { ok: false, result: { ok: false, reason: 'terminal_conflict', job: view(job) } }
    }
    const activeLease = job.lease
    if (job.status !== 'leased' || !activeLease || !sameLease(activeLease, input)) {
      return { ok: false, result: { ok: false, reason: 'stale_lease', job: view(job) } }
    }
    if (instant(activeLease.expiresAt, 'leaseExpiresAt') <= atMs) {
      return { ok: false, result: { ok: false, reason: 'lease_expired', job: view(job) } }
    }
    return { ok: true, job }
  }

  return { enqueue, claimNext, renewLease, cancel, complete, fail, retry, getJob, isLeaseCurrent, onCancelled }
}

function sameLease(lease: ActiveLease | undefined, input: LeaseMutationInput) {
  return Boolean(lease
    && lease.attempt === input.attempt
    && lease.fence === input.fence
    && lease.workerId === input.workerId
    && lease.token === input.leaseToken)
}

function terminal(
  input: LeaseMutationInput,
  kind: TerminalMutation['kind'],
  fingerprint: string,
): TerminalMutation {
  return {
    kind,
    attempt: input.attempt,
    fence: input.fence,
    workerId: input.workerId,
    leaseToken: input.leaseToken,
    fingerprint,
  }
}

function matchesTerminal<TPayload, TResult>(
  job: StoredRunJob<TPayload, TResult>,
  input: LeaseMutationInput,
  kind: TerminalMutation['kind'],
  fingerprint: string,
) {
  const mutation = job.terminalMutation
  return Boolean(mutation
    && mutation.kind === kind
    && mutation.attempt === input.attempt
    && mutation.fence === input.fence
    && mutation.workerId === input.workerId
    && mutation.leaseToken === input.leaseToken
    && mutation.fingerprint === fingerprint)
}

function clearLease<TPayload, TResult>(job: StoredRunJob<TPayload, TResult>) {
  job.lease = undefined
  job.leaseOwner = undefined
  job.leaseExpiresAt = undefined
}

function currentAttempt<TPayload, TResult>(job: StoredRunJob<TPayload, TResult>) {
  const attempt = job.attempts.at(-1)
  if (!attempt || attempt.attempt !== job.attempt) throw new Error('Run job attempt history is inconsistent')
  return attempt
}

function closeAttempt<TPayload, TResult>(
  job: StoredRunJob<TPayload, TResult>,
  attemptNumber: number,
  endedAt: string,
  outcome: RunJobAttemptView['outcome'],
  failure?: RunJobFailure,
) {
  let attempt: RunJobAttemptView | undefined
  for (let index = job.attempts.length - 1; index >= 0; index -= 1) {
    if (job.attempts[index].attempt === attemptNumber) {
      attempt = job.attempts[index]
      break
    }
  }
  if (!attempt || attempt.outcome) return
  attempt.endedAt = endedAt
  attempt.outcome = outcome
  attempt.failure = failure ? clone(failure) : undefined
}

function view<TPayload, TResult>(job: StoredRunJob<TPayload, TResult>): RunJobView<TPayload, TResult> {
  const { lease: _lease, terminalMutation: _terminalMutation, ...publicJob } = job
  return clone(publicJob)
}

function failureFingerprint(failure: RunJobFailure) {
  return [failure.code, failure.message, String(failure.retryable), failure.debugReference ?? ''].join(':')
}

function leaseExpiredFailure(): RunJobFailure {
  return {
    code: 'LEASE_EXPIRED',
    message: 'Worker lease expired before the attempt reached a terminal state.',
    retryable: true,
  }
}

function assertLeaseMs(value: number) {
  if (!Number.isInteger(value) || value < 1) throw new Error('leaseMs must be a positive integer')
}

function assertNonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} cannot be empty`)
}

function instant(value: string, name: string) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO instant`)
  return parsed
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}
