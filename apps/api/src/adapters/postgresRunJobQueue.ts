import { createHash, randomBytes } from 'node:crypto'
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
  RunJobMutationFailureReason,
  RunJobMutationResult,
  RunJobQueue,
  RunJobView,
} from '../../../../src/persistence/jobPorts'

interface PgResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface PostgresRunJobClientLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresRunJobPoolLike {
  connect(): Promise<PostgresRunJobClientLike>
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  end?(): Promise<void>
}

export interface PostgresRunJobQueueOptions {
  pool: PostgresRunJobPoolLike
  leaseToken?: () => string
  cancellationPollMs?: number
  closePool?: boolean
}

export interface PostgresRunJobQueue<TPayload = unknown, TResult = unknown> extends RunJobQueue<TPayload, TResult> {
  close(): Promise<void>
}

interface JobRow {
  run_id: string
  tenant_id: string
  workspace_id: string
  payload_fingerprint: string
  payload_json: unknown
  status: RunJobView['status']
  attempt: number | string
  max_attempts: number | string
  fence: number | string
  enqueued_at: string | Date
  available_at: string | Date
  lease_owner: string | null
  lease_token_hash: string | null
  lease_expires_at: string | Date | null
  cancel_requested_at: string | Date | null
  completed_at: string | Date | null
  failed_at: string | Date | null
  cancelled_at: string | Date | null
  last_failure_json: unknown
  result_fingerprint: string | null
  result_json: unknown
  terminal_kind: 'completed' | 'failed' | 'retry_scheduled' | null
  terminal_attempt: number | string | null
  terminal_fence: number | string | null
  terminal_worker_id: string | null
  terminal_lease_token_hash: string | null
  terminal_fingerprint: string | null
  previous_status?: RunJobView['status']
  previous_attempt?: number | string
}

interface AttemptRow {
  attempt: number | string
  fence: number | string
  worker_id: string
  started_at: string | Date
  lease_expires_at: string | Date
  ended_at: string | Date | null
  outcome: RunJobAttemptView['outcome'] | null
  failure_json: unknown
}

interface CancellationSubscription {
  listener: () => void
  fired: boolean
}

const leaseExpiredFailure: RunJobFailure = {
  code: 'LEASE_EXPIRED',
  message: 'Worker lease expired before the attempt reached a terminal state.',
  retryable: true,
}

export function createPostgresRunJobQueue<TPayload = unknown, TResult = unknown>(
  options: PostgresRunJobQueueOptions,
): PostgresRunJobQueue<TPayload, TResult> {
  const nextLeaseToken = options.leaseToken ?? (() => randomBytes(32).toString('base64url'))
  const cancellationPollMs = options.cancellationPollMs ?? 250
  if (!Number.isInteger(cancellationPollMs) || cancellationPollMs < 25) {
    throw new Error('cancellationPollMs must be an integer of at least 25ms')
  }
  const subscriptions = new Map<string, Set<CancellationSubscription>>()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let pollInFlight = false

  async function enqueue(input: EnqueueRunJobInput<TPayload>): Promise<EnqueueRunJobResult<TPayload, TResult>> {
    nonEmpty(input.runId, 'runId')
    nonEmpty(input.tenantId, 'tenantId')
    nonEmpty(input.workspaceId, 'workspaceId')
    nonEmpty(input.payloadFingerprint, 'payloadFingerprint')
    const enqueuedAt = instant(input.enqueuedAt, 'enqueuedAt')
    const availableAt = instant(input.availableAt ?? input.enqueuedAt, 'availableAt')
    const maxAttempts = input.maxAttempts ?? 3
    positiveInteger(maxAttempts, 'maxAttempts')
    const payloadJson = stringifyJson(input.payload, 'payload')

    return transaction(options.pool, async (client) => {
      const inserted = await client.query<JobRow>(`insert into chatbi_run_jobs (
  run_id, tenant_id, workspace_id, payload_fingerprint, payload_json, status,
  attempt, max_attempts, fence, enqueued_at, available_at, created_at, updated_at
) values (
  $1, $2, $3, $4, $5::jsonb, 'queued', 0, $6, 0, $7::timestamptz, $8::timestamptz, $7::timestamptz, $7::timestamptz
) on conflict (run_id) do nothing
returning *`, [
        input.runId,
        input.tenantId,
        input.workspaceId,
        input.payloadFingerprint,
        payloadJson,
        maxAttempts,
        enqueuedAt,
        availableAt,
      ])
      const job = await loadJob<TPayload, TResult>(client, input.runId)
      if (!job) throw new Error('enqueued run job could not be loaded')
      const sameIdentity = job.tenantId === input.tenantId
        && job.workspaceId === input.workspaceId
        && job.payloadFingerprint === input.payloadFingerprint
      if (!sameIdentity) return { ok: false, reason: 'idempotency_conflict', job }
      return { ok: true, created: Boolean(inserted.rowCount), job }
    })
  }

  async function claimNext(input: ClaimRunJobInput): Promise<RunJobLease<TPayload> | undefined> {
    nonEmpty(input.workerId, 'workerId')
    const now = instant(input.now, 'now')
    positiveInteger(input.leaseMs, 'leaseMs')
    if (input.runId !== undefined) nonEmpty(input.runId, 'runId')
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString()
    const leaseToken = nextLeaseToken()
    nonEmpty(leaseToken, 'leaseToken')
    const tokenHash = hashToken(leaseToken)

    return transaction(options.pool, async (client) => {
      await expireExhaustedLeases(client, now)
      const claimed = await client.query<JobRow>(`with candidate as (
  select run_id, status as previous_status, attempt as previous_attempt
  from chatbi_run_jobs
  where ($1::text is null or run_id = $1)
    and attempt < max_attempts
    and (
      (status in ('queued', 'retry_wait') and available_at <= $2::timestamptz)
      or (status = 'leased' and lease_expires_at <= $2::timestamptz)
    )
  order by available_at asc, enqueued_at asc, run_id asc
  for update skip locked
  limit 1
), claimed as (
  update chatbi_run_jobs as job
  set status = 'leased',
      attempt = job.attempt + 1,
      fence = job.fence + 1,
      lease_owner = $3,
      lease_token_hash = $4,
      lease_expires_at = $5::timestamptz,
      last_failure_json = case
        when candidate.previous_status = 'leased' then $6::jsonb
        else job.last_failure_json
      end,
      terminal_kind = null,
      terminal_attempt = null,
      terminal_fence = null,
      terminal_worker_id = null,
      terminal_lease_token_hash = null,
      terminal_fingerprint = null,
      updated_at = $2::timestamptz
  from candidate
  where job.run_id = candidate.run_id
  returning job.*, candidate.previous_status, candidate.previous_attempt
)
select * from claimed`, [
        input.runId ?? null,
        now,
        input.workerId,
        tokenHash,
        leaseExpiresAt,
        stringifyJson(leaseExpiredFailure, 'failure'),
      ])
      const row = claimed.rows[0]
      if (!row) return undefined

      if (row.previous_status === 'leased') {
        await closeAttempt(client, row.run_id, integer(row.previous_attempt, 'previous_attempt'), now, 'lease_expired', leaseExpiredFailure)
      }
      const attempt = integer(row.attempt, 'attempt')
      const fence = integer(row.fence, 'fence')
      await client.query(`insert into chatbi_run_job_attempts (
  run_id, tenant_id, workspace_id, attempt, fence, worker_id, lease_token_hash,
  started_at, lease_expires_at
) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`, [
        row.run_id,
        row.tenant_id,
        row.workspace_id,
        attempt,
        fence,
        input.workerId,
        tokenHash,
        now,
        leaseExpiresAt,
      ])
      return {
        runId: row.run_id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        payload: parseJson<TPayload>(row.payload_json),
        payloadFingerprint: row.payload_fingerprint,
        attempt,
        maxAttempts: integer(row.max_attempts, 'max_attempts'),
        fence,
        workerId: input.workerId,
        leaseToken,
        claimedAt: now,
        leaseExpiresAt,
      }
    })
  }

  async function renewLease(input: RenewRunJobLeaseInput): Promise<RunJobMutationResult<TPayload, TResult>> {
    const now = instant(input.now, 'now')
    positiveInteger(input.leaseMs, 'leaseMs')
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseMs).toISOString()
    return transaction(options.pool, async (client) => {
      const row = await lockJob(client, input.runId)
      const invalid = mutationFailure<TPayload, TResult>(row, input, now)
      if (invalid) return invalid
      await client.query(`update chatbi_run_jobs
set lease_expires_at = $2::timestamptz, updated_at = $3::timestamptz
where run_id = $1`, [input.runId, leaseExpiresAt, now])
      await client.query(`update chatbi_run_job_attempts
set lease_expires_at = $3::timestamptz
where run_id = $1 and attempt = $2`, [input.runId, input.attempt, leaseExpiresAt])
      return appliedJob<TPayload, TResult>(client, input.runId)
    })
  }

  async function cancel(runId: string, cancelledAtInput: string): Promise<CancelRunJobResult<TPayload, TResult>> {
    nonEmpty(runId, 'runId')
    const cancelledAt = instant(cancelledAtInput, 'cancelledAt')
    const result = await transaction(options.pool, async (client) => {
      const row = await lockJob(client, runId)
      if (!row) return { ok: false, reason: 'not_found' } as const
      if (row.status === 'cancelled') {
        return { ok: true, applied: false, job: (await requiredJob<TPayload, TResult>(client, runId)) } as const
      }
      if (row.status === 'completed' || row.status === 'failed') {
        return { ok: false, reason: 'terminal_conflict', job: await requiredJob<TPayload, TResult>(client, runId) } as const
      }
      if (row.status === 'leased') {
        await closeAttempt(client, runId, integer(row.attempt, 'attempt'), cancelledAt, 'cancelled')
      }
      await client.query(`update chatbi_run_jobs
set status = 'cancelled',
    cancel_requested_at = coalesce(cancel_requested_at, $2::timestamptz),
    cancelled_at = coalesce(cancelled_at, $2::timestamptz),
    lease_owner = null,
    lease_token_hash = null,
    lease_expires_at = null,
    updated_at = $2::timestamptz
where run_id = $1`, [runId, cancelledAt])
      return { ok: true, applied: true, job: await requiredJob<TPayload, TResult>(client, runId) } as const
    })
    if (result.ok) fireCancellation(runId)
    return result
  }

  async function complete(input: CompleteRunJobInput<TResult>): Promise<RunJobMutationResult<TPayload, TResult>> {
    const completedAt = instant(input.completedAt, 'completedAt')
    nonEmpty(input.resultFingerprint, 'resultFingerprint')
    const resultJson = stringifyJson(input.result, 'result')
    const tokenHash = hashToken(input.leaseToken)
    return transaction(options.pool, async (client) => {
      const row = await lockJob(client, input.runId)
      if (matchesTerminal(row, input, tokenHash, 'completed', input.resultFingerprint)) {
        return { ok: true, applied: false, job: await requiredJob<TPayload, TResult>(client, input.runId) }
      }
      const invalid = mutationFailure<TPayload, TResult>(row, input, completedAt)
      if (invalid) return invalid
      await client.query(`update chatbi_run_jobs
set status = 'completed', completed_at = $2::timestamptz,
    result_fingerprint = $3, result_json = $4::jsonb,
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    terminal_kind = 'completed', terminal_attempt = $5, terminal_fence = $6,
    terminal_worker_id = $7, terminal_lease_token_hash = $8,
    terminal_fingerprint = $3, updated_at = $2::timestamptz
where run_id = $1`, [
        input.runId, completedAt, input.resultFingerprint, resultJson,
        input.attempt, input.fence, input.workerId, tokenHash,
      ])
      await closeAttempt(client, input.runId, input.attempt, completedAt, 'completed')
      return appliedJob<TPayload, TResult>(client, input.runId)
    })
  }

  async function fail(input: FailRunJobInput): Promise<RunJobMutationResult<TPayload, TResult>> {
    const failedAt = instant(input.failedAt, 'failedAt')
    const failureJson = stringifyJson(input.failure, 'failure')
    const fingerprint = failureFingerprint(input.failure)
    const tokenHash = hashToken(input.leaseToken)
    return transaction(options.pool, async (client) => {
      const row = await lockJob(client, input.runId)
      if (matchesTerminal(row, input, tokenHash, 'failed', fingerprint)) {
        return { ok: true, applied: false, job: await requiredJob<TPayload, TResult>(client, input.runId) }
      }
      const invalid = mutationFailure<TPayload, TResult>(row, input, failedAt)
      if (invalid) return invalid
      await client.query(`update chatbi_run_jobs
set status = 'failed', failed_at = $2::timestamptz, last_failure_json = $3::jsonb,
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    terminal_kind = 'failed', terminal_attempt = $4, terminal_fence = $5,
    terminal_worker_id = $6, terminal_lease_token_hash = $7,
    terminal_fingerprint = $8, updated_at = $2::timestamptz
where run_id = $1`, [
        input.runId, failedAt, failureJson, input.attempt, input.fence,
        input.workerId, tokenHash, fingerprint,
      ])
      await closeAttempt(client, input.runId, input.attempt, failedAt, 'failed', input.failure)
      return appliedJob<TPayload, TResult>(client, input.runId)
    })
  }

  async function retry(input: RetryRunJobInput): Promise<RunJobMutationResult<TPayload, TResult>> {
    const failedAt = instant(input.failedAt, 'failedAt')
    const availableAt = instant(input.availableAt, 'availableAt')
    if (Date.parse(availableAt) < Date.parse(failedAt)) throw new Error('availableAt cannot be before failedAt')
    const failureJson = stringifyJson(input.failure, 'failure')
    const fingerprint = `${failureFingerprint(input.failure)}:${availableAt}`
    const tokenHash = hashToken(input.leaseToken)
    return transaction(options.pool, async (client) => {
      const row = await lockJob(client, input.runId)
      if (matchesTerminal(row, input, tokenHash, 'retry_scheduled', fingerprint)) {
        return { ok: true, applied: false, job: await requiredJob<TPayload, TResult>(client, input.runId) }
      }
      const invalid = mutationFailure<TPayload, TResult>(row, input, failedAt)
      if (invalid) return invalid
      if (!input.failure.retryable) {
        return { ok: false, reason: 'failure_not_retryable', job: await requiredJob<TPayload, TResult>(client, input.runId) }
      }
      if (integer(row!.attempt, 'attempt') >= integer(row!.max_attempts, 'max_attempts')) {
        return { ok: false, reason: 'attempts_exhausted', job: await requiredJob<TPayload, TResult>(client, input.runId) }
      }
      await client.query(`update chatbi_run_jobs
set status = 'retry_wait', available_at = $2::timestamptz,
    last_failure_json = $3::jsonb,
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    terminal_kind = 'retry_scheduled', terminal_attempt = $4, terminal_fence = $5,
    terminal_worker_id = $6, terminal_lease_token_hash = $7,
    terminal_fingerprint = $8, updated_at = $9::timestamptz
where run_id = $1`, [
        input.runId, availableAt, failureJson, input.attempt, input.fence,
        input.workerId, tokenHash, fingerprint, failedAt,
      ])
      await closeAttempt(client, input.runId, input.attempt, failedAt, 'retry_scheduled', input.failure)
      return appliedJob<TPayload, TResult>(client, input.runId)
    })
  }

  async function getJob(runId: string): Promise<RunJobView<TPayload, TResult> | undefined> {
    nonEmpty(runId, 'runId')
    const client = await options.pool.connect()
    try {
      return await loadJob<TPayload, TResult>(client, runId)
    } finally {
      client.release()
    }
  }

  async function isLeaseCurrent(lease: LeaseMutationInput, nowInput: string): Promise<boolean> {
    const now = instant(nowInput, 'now')
    const result = await options.pool.query<{ current: boolean }>(`select exists (
  select 1 from chatbi_run_jobs
  where run_id = $1 and status = 'leased' and attempt = $2 and fence = $3
    and lease_owner = $4 and lease_token_hash = $5 and lease_expires_at > $6::timestamptz
) as current`, [lease.runId, lease.attempt, lease.fence, lease.workerId, hashToken(lease.leaseToken), now])
    return result.rows[0]?.current === true
  }

  async function onCancelled(runId: string, listener: () => void): Promise<() => void> {
    nonEmpty(runId, 'runId')
    const subscription: CancellationSubscription = { listener, fired: false }
    const listeners = subscriptions.get(runId) ?? new Set<CancellationSubscription>()
    listeners.add(subscription)
    subscriptions.set(runId, listeners)
    ensurePoller()
    const job = await getJob(runId)
    if (job?.status === 'cancelled') fireCancellation(runId)
    return () => removeSubscription(runId, subscription)
  }

  function ensurePoller() {
    if (pollTimer || subscriptions.size === 0) return
    pollTimer = setInterval(() => { void pollCancellations() }, cancellationPollMs)
    pollTimer.unref?.()
  }

  async function pollCancellations() {
    if (pollInFlight || subscriptions.size === 0) return
    pollInFlight = true
    try {
      const runIds = [...subscriptions.keys()]
      const result = await options.pool.query<{ run_id: string }>(
        `select run_id from chatbi_run_jobs where run_id = any($1::text[]) and status = 'cancelled'`,
        [runIds],
      )
      result.rows.forEach((row) => fireCancellation(row.run_id))
    } catch {
      // Polling is a wake-up optimization. Lease fencing remains authoritative.
    } finally {
      pollInFlight = false
    }
  }

  function fireCancellation(runId: string) {
    const listeners = subscriptions.get(runId)
    if (!listeners) return
    subscriptions.delete(runId)
    for (const subscription of listeners) {
      if (subscription.fired) continue
      subscription.fired = true
      try {
        subscription.listener()
      } catch {
        // Cancellation is already durable and cannot be rolled back by observers.
      }
    }
    stopPollerIfIdle()
  }

  function removeSubscription(runId: string, subscription: CancellationSubscription) {
    const listeners = subscriptions.get(runId)
    listeners?.delete(subscription)
    if (listeners?.size === 0) subscriptions.delete(runId)
    stopPollerIfIdle()
  }

  function stopPollerIfIdle() {
    if (subscriptions.size > 0 || !pollTimer) return
    clearInterval(pollTimer)
    pollTimer = undefined
  }

  async function close() {
    subscriptions.clear()
    stopPollerIfIdle()
    if (options.closePool) await options.pool.end?.()
  }

  return { enqueue, claimNext, renewLease, cancel, complete, fail, retry, getJob, isLeaseCurrent, onCancelled, close }
}

async function expireExhaustedLeases(client: PostgresRunJobClientLike, now: string) {
  const failureJson = stringifyJson(leaseExpiredFailure, 'failure')
  await client.query(`with expired as (
  update chatbi_run_jobs
  set status = 'failed', failed_at = $1::timestamptz,
      last_failure_json = $2::jsonb,
      lease_owner = null, lease_token_hash = null, lease_expires_at = null,
      updated_at = $1::timestamptz
  where status = 'leased' and lease_expires_at <= $1::timestamptz and attempt >= max_attempts
  returning run_id, attempt
)
update chatbi_run_job_attempts as attempt
set ended_at = $1::timestamptz, outcome = 'lease_expired', failure_json = $2::jsonb
from expired
where attempt.run_id = expired.run_id and attempt.attempt = expired.attempt and attempt.ended_at is null`, [now, failureJson])
}

async function lockJob(client: PostgresRunJobClientLike, runId: string): Promise<JobRow | undefined> {
  const result = await client.query<JobRow>('select * from chatbi_run_jobs where run_id = $1 for update', [runId])
  return result.rows[0]
}

function mutationFailure<TPayload, TResult>(
  row: JobRow | undefined,
  input: LeaseMutationInput,
  at: string,
): RunJobMutationResult<TPayload, TResult> | undefined {
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
    return { ok: false, reason: 'terminal_conflict' }
  }
  if (
    row.status !== 'leased'
    || integer(row.attempt, 'attempt') !== input.attempt
    || integer(row.fence, 'fence') !== input.fence
    || row.lease_owner !== input.workerId
    || row.lease_token_hash !== hashToken(input.leaseToken)
  ) {
    return { ok: false, reason: 'stale_lease' }
  }
  if (!row.lease_expires_at || Date.parse(iso(row.lease_expires_at)) <= Date.parse(at)) {
    return { ok: false, reason: 'lease_expired' }
  }
  return undefined
}

function matchesTerminal(
  row: JobRow | undefined,
  input: LeaseMutationInput,
  tokenHash: string,
  kind: NonNullable<JobRow['terminal_kind']>,
  fingerprint: string,
) {
  const expectedStatus = kind === 'completed' ? 'completed' : kind === 'failed' ? 'failed' : 'retry_wait'
  return Boolean(row
    && row.status === expectedStatus
    && row.terminal_kind === kind
    && integer(row.terminal_attempt, 'terminal_attempt') === input.attempt
    && integer(row.terminal_fence, 'terminal_fence') === input.fence
    && row.terminal_worker_id === input.workerId
    && row.terminal_lease_token_hash === tokenHash
    && row.terminal_fingerprint === fingerprint)
}

async function appliedJob<TPayload, TResult>(
  client: PostgresRunJobClientLike,
  runId: string,
): Promise<RunJobMutationResult<TPayload, TResult>> {
  return { ok: true, applied: true, job: await requiredJob<TPayload, TResult>(client, runId) }
}

async function requiredJob<TPayload, TResult>(client: PostgresRunJobClientLike, runId: string) {
  const job = await loadJob<TPayload, TResult>(client, runId)
  if (!job) throw new Error('run job disappeared during transaction')
  return job
}

async function loadJob<TPayload, TResult>(
  client: PostgresRunJobClientLike,
  runId: string,
): Promise<RunJobView<TPayload, TResult> | undefined> {
  const jobs = await client.query<JobRow>('select * from chatbi_run_jobs where run_id = $1', [runId])
  const row = jobs.rows[0]
  if (!row) return undefined
  const attempts = await client.query<AttemptRow>(`select attempt, fence, worker_id, started_at, lease_expires_at,
  ended_at, outcome, failure_json
from chatbi_run_job_attempts where run_id = $1 order by attempt asc`, [runId])
  const view: RunJobView<TPayload, TResult> = {
    runId: row.run_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    payloadFingerprint: row.payload_fingerprint,
    payload: parseJson<TPayload>(row.payload_json),
    status: row.status,
    attempt: integer(row.attempt, 'attempt'),
    maxAttempts: integer(row.max_attempts, 'max_attempts'),
    fence: integer(row.fence, 'fence'),
    enqueuedAt: iso(row.enqueued_at),
    availableAt: iso(row.available_at),
    attempts: attempts.rows.map(mapAttempt),
  }
  assignIso(view, 'leaseExpiresAt', row.lease_expires_at)
  assignIso(view, 'cancelRequestedAt', row.cancel_requested_at)
  assignIso(view, 'completedAt', row.completed_at)
  assignIso(view, 'failedAt', row.failed_at)
  assignIso(view, 'cancelledAt', row.cancelled_at)
  if (row.lease_owner) view.leaseOwner = row.lease_owner
  if (row.last_failure_json !== null) view.lastFailure = parseJson<RunJobFailure>(row.last_failure_json)
  if (row.result_fingerprint) {
    view.resultFingerprint = row.result_fingerprint
    view.result = parseJson<TResult>(row.result_json)
  }
  return view
}

function mapAttempt(row: AttemptRow): RunJobAttemptView {
  const attempt: RunJobAttemptView = {
    attempt: integer(row.attempt, 'attempt'),
    fence: integer(row.fence, 'fence'),
    workerId: row.worker_id,
    startedAt: iso(row.started_at),
    leaseExpiresAt: iso(row.lease_expires_at),
  }
  if (row.ended_at) attempt.endedAt = iso(row.ended_at)
  if (row.outcome) attempt.outcome = row.outcome
  if (row.failure_json !== null) attempt.failure = parseJson<RunJobFailure>(row.failure_json)
  return attempt
}

async function closeAttempt(
  client: PostgresRunJobClientLike,
  runId: string,
  attempt: number,
  endedAt: string,
  outcome: NonNullable<RunJobAttemptView['outcome']>,
  failure?: RunJobFailure,
) {
  await client.query(`update chatbi_run_job_attempts
set ended_at = $3::timestamptz, outcome = $4, failure_json = $5::jsonb
where run_id = $1 and attempt = $2 and ended_at is null`, [
    runId,
    attempt,
    endedAt,
    outcome,
    failure ? stringifyJson(failure, 'failure') : null,
  ])
}

async function transaction<T>(pool: PostgresRunJobPoolLike, work: (client: PostgresRunJobClientLike) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  let transactionStarted = false
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    transactionStarted = true
    const result = await work(client)
    await client.query('COMMIT')
    transactionStarted = false
    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('rollback failed')
      }
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}

function hashToken(token: string) {
  nonEmpty(token, 'leaseToken')
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function failureFingerprint(failure: RunJobFailure) {
  return [failure.code, failure.message, String(failure.retryable), failure.debugReference ?? ''].join(':')
}

function stringifyJson(value: unknown, name: string) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error(`${name} must be JSON serializable`)
  return json
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : structuredClone(value)) as T
}

function integer(value: unknown, name: string) {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is missing`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} is not a safe non-negative integer`)
  return number
}

function iso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('database returned an invalid timestamp')
  return date.toISOString()
}

function instant(value: string, name: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid ISO instant`)
  return new Date(value).toISOString()
}

function assignIso<T extends object, K extends keyof T>(target: T, key: K, value: string | Date | null) {
  if (value !== null) target[key] = iso(value) as T[K]
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function nonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} cannot be empty`)
}
