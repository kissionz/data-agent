import { describe, expect, it, vi } from 'vitest'
import {
  createRunWorker,
  RunWorkerCommitAttemptError,
  type RunWorkerHandlerResult,
} from '../application/runWorker'
import { createInMemoryRunJobQueue } from '../persistence/jobMemory'
import type { RunJobLease, RunJobQueue, SynchronousRunJobQueue } from '../persistence/jobPorts'

interface Payload { question: string }
interface Result { rows: number }

const t0 = '2026-07-15T09:00:00.000Z'
const t1 = '2026-07-15T09:00:01.000Z'
const t2 = '2026-07-15T09:00:02.000Z'
const t3 = '2026-07-15T09:00:03.000Z'

function enqueue(queue: SynchronousRunJobQueue<Payload, Result>, runId = 'run_1', maxAttempts = 3) {
  return queue.enqueue({
    runId,
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    payloadFingerprint: `fingerprint_${runId}`,
    payload: { question: '过去 12 个月净收入趋势' },
    enqueuedAt: t0,
    maxAttempts,
  })
}

function identity(lease: RunJobLease<Payload>) {
  return {
    runId: lease.runId,
    attempt: lease.attempt,
    fence: lease.fence,
    workerId: lease.workerId,
    leaseToken: lease.leaseToken,
  }
}

describe('in-memory run job queue', () => {
  it('enqueues idempotently and rejects a changed payload identity', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    expect(enqueue(queue)).toMatchObject({ ok: true, created: true })
    expect(enqueue(queue)).toMatchObject({ ok: true, created: false })

    expect(queue.enqueue({
      runId: 'run_1',
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      payloadFingerprint: 'different',
      payload: { question: '另一个问题' },
      enqueuedAt: t0,
    })).toMatchObject({ ok: false, reason: 'idempotency_conflict' })
  })

  it('allows only one worker to claim a live lease', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue)

    const first = queue.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 2_000 })
    const second = queue.claimNext({ workerId: 'worker_b', now: t1, leaseMs: 2_000 })

    expect(first).toMatchObject({ attempt: 1, fence: 1, workerId: 'worker_a' })
    expect(second).toBeUndefined()
  })

  it('can restrict an inline claim to the just-enqueued run', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue, 'run_older')
    enqueue(queue, 'run_inline')

    const claimed = queue.claimNext({ workerId: 'inline', now: t0, leaseMs: 2_000, runId: 'run_inline' })

    expect(claimed?.runId).toBe('run_inline')
    expect(queue.getJob('run_older')?.status).toBe('queued')
  })

  it('reclaims an expired lease and fences the old worker from completion', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>({ leaseToken: (() => {
      let sequence = 0
      return () => `lease_${++sequence}`
    })() })
    enqueue(queue)
    const oldLease = queue.claimNext({ workerId: 'worker_old', now: t0, leaseMs: 1_000 })!
    const currentLease = queue.claimNext({ workerId: 'worker_new', now: t1, leaseMs: 2_000 })!

    expect(currentLease).toMatchObject({ attempt: 2, fence: 2, workerId: 'worker_new' })
    expect(queue.complete({
      ...identity(oldLease),
      completedAt: t1,
      resultFingerprint: 'old_result',
      result: { rows: 1 },
    })).toMatchObject({ ok: false, reason: 'stale_lease' })
    expect(queue.complete({
      ...identity(currentLease),
      completedAt: t2,
      resultFingerprint: 'new_result',
      result: { rows: 12 },
    })).toMatchObject({ ok: true, applied: true })
    expect(queue.getJob('run_1')).toMatchObject({
      status: 'completed',
      result: { rows: 12 },
      attempts: [
        { attempt: 1, outcome: 'lease_expired' },
        { attempt: 2, outcome: 'completed' },
      ],
    })
  })

  it('renews only the current unexpired lease', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue)
    const lease = queue.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 2_000 })!

    expect(queue.renewLease({ ...identity(lease), now: t1, leaseMs: 5_000 })).toMatchObject({
      ok: true,
      job: { leaseExpiresAt: '2026-07-15T09:00:06.000Z' },
    })
    expect(queue.renewLease({ ...identity(lease), leaseToken: 'stale', now: t2, leaseMs: 5_000 })).toMatchObject({
      ok: false,
      reason: 'stale_lease',
    })
  })

  it('cancels queued work idempotently so it can never be claimed', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue)

    expect(queue.cancel('run_1', t1)).toMatchObject({ ok: true, applied: true, job: { status: 'cancelled' } })
    expect(queue.cancel('run_1', t2)).toMatchObject({
      ok: true,
      applied: false,
      job: { cancelRequestedAt: t1, cancelledAt: t1 },
    })
    expect(queue.claimNext({ workerId: 'worker_a', now: t3, leaseMs: 1_000 })).toBeUndefined()
  })

  it('makes cancel and complete races deterministic in either ordering', () => {
    const cancelFirst = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(cancelFirst)
    const cancelledLease = cancelFirst.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 5_000 })!
    expect(cancelFirst.cancel('run_1', t1)).toMatchObject({ ok: true, job: { status: 'cancelled' } })
    expect(cancelFirst.complete({
      ...identity(cancelledLease),
      completedAt: t2,
      resultFingerprint: 'late',
      result: { rows: 12 },
    })).toMatchObject({ ok: false, reason: 'terminal_conflict' })

    const completeFirst = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(completeFirst)
    const completedLease = completeFirst.claimNext({ workerId: 'worker_b', now: t0, leaseMs: 5_000 })!
    expect(completeFirst.complete({
      ...identity(completedLease),
      completedAt: t1,
      resultFingerprint: 'winner',
      result: { rows: 12 },
    })).toMatchObject({ ok: true })
    expect(completeFirst.cancel('run_1', t2)).toMatchObject({ ok: false, reason: 'terminal_conflict' })
    expect(completeFirst.getJob('run_1')).toMatchObject({ status: 'completed', resultFingerprint: 'winner' })
  })

  it('schedules retries with a new attempt and enforces max attempts', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue, 'run_1', 2)
    const first = queue.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 5_000 })!
    expect(queue.retry({
      ...identity(first),
      failedAt: t1,
      availableAt: t2,
      failure: { code: 'NETWORK_TIMEOUT', message: 'timeout', retryable: true },
    })).toMatchObject({ ok: true, job: { status: 'retry_wait' } })
    expect(queue.claimNext({ workerId: 'worker_b', now: t1, leaseMs: 5_000 })).toBeUndefined()

    const second = queue.claimNext({ workerId: 'worker_b', now: t2, leaseMs: 5_000 })!
    expect(second.attempt).toBe(2)
    expect(queue.retry({
      ...identity(second),
      failedAt: t3,
      availableAt: '2026-07-15T09:00:04.000Z',
      failure: { code: 'NETWORK_TIMEOUT', message: 'timeout', retryable: true },
    })).toMatchObject({ ok: false, reason: 'attempts_exhausted' })
    expect(queue.fail({
      ...identity(second),
      failedAt: t3,
      failure: { code: 'NETWORK_TIMEOUT', message: 'retry budget exhausted', retryable: false },
    })).toMatchObject({ ok: true, job: { status: 'failed' } })
  })

  it('makes duplicate completion from the winning lease idempotent', () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue)
    const lease = queue.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 5_000 })!
    const completion = {
      ...identity(lease),
      completedAt: t1,
      resultFingerprint: 'result_v1',
      result: { rows: 12 },
    }
    expect(queue.complete(completion)).toMatchObject({ ok: true, applied: true })
    expect(queue.complete(completion)).toMatchObject({ ok: true, applied: false })
  })
})

describe('run worker', () => {
  it('uses the fenced queue contract to complete an inline worker cycle', async () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue)
    const worker = createRunWorker({
      queue,
      workerId: 'inline_demo',
      leaseMs: 5_000,
      now: () => t0,
      handler: {
        async execute(payload, context) {
          expect(payload.question).toContain('净收入')
          await expect(context.isLeaseCurrent(t1)).resolves.toBe(true)
          return { type: 'completed', result: { rows: 12 }, resultFingerprint: 'fixture_result', at: t1 }
        },
      },
    })

    await expect(worker.runOnce()).resolves.toEqual({ status: 'completed', runId: 'run_1', attempt: 1 })
    expect(queue.getJob('run_1')).toMatchObject({ status: 'completed', result: { rows: 12 } })
  })

  it('cannot publish a handler result after cancellation wins the race', async () => {
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory)
    const queue = asynchronousQueue(memory)
    let releaseHandler!: () => void
    let markHandlerStarted!: () => void
    let workerSignal: AbortSignal | undefined
    const waiting = new Promise<void>((resolve) => { releaseHandler = resolve })
    const handlerStarted = new Promise<void>((resolve) => { markHandlerStarted = resolve })
    const worker = createRunWorker({
      queue,
      workerId: 'worker_async',
      leaseMs: 5_000,
      now: () => t0,
      handler: {
        async execute(_payload, context) {
          workerSignal = context.signal
          markHandlerStarted()
          await waiting
          return { type: 'completed', result: { rows: 12 }, resultFingerprint: 'late_result', at: t2 }
        },
      },
    })

    const cycle = worker.runOnce()
    await handlerStarted
    await expect(queue.cancel('run_1', t1)).resolves.toMatchObject({ ok: true, job: { status: 'cancelled' } })
    expect(workerSignal?.aborted).toBe(true)
    releaseHandler()

    await expect(cycle).resolves.toEqual({ status: 'cancelled', runId: 'run_1', attempt: 1 })
    await expect(queue.getJob('run_1')).resolves.toMatchObject({ status: 'cancelled' })
    expect((await queue.getJob('run_1'))?.result).toBeUndefined()
  })

  it('exposes a cooperative abort for runtime shutdown', async () => {
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory)
    const queue = asynchronousQueue(memory)
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    let workerSignal: AbortSignal | undefined
    const worker = createRunWorker({
      queue,
      workerId: 'worker_shutdown',
      leaseMs: 5_000,
      now: () => t0,
      handler: {
        execute(_payload, context) {
          workerSignal = context.signal
          markStarted()
          return new Promise((resolve) => {
            context.signal.addEventListener('abort', () => resolve({
              type: 'failed',
              failure: { code: 'SHUTDOWN_ABORTED', message: 'shutdown', retryable: true },
              failedAt: t1,
            }), { once: true })
          })
        },
      },
    })

    const cycle = worker.runOnce()
    await started
    worker.abortActive()

    expect(workerSignal?.aborted).toBe(true)
    await expect(cycle).resolves.toEqual({ status: 'failed', runId: 'run_1', attempt: 1 })
  })

  it('can abort while the durable cancellation subscription is still pending', async () => {
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory)
    const base = asynchronousQueue(memory)
    let markSubscriptionStarted!: () => void
    let releaseSubscription!: () => void
    const subscriptionStarted = new Promise<void>((resolve) => { markSubscriptionStarted = resolve })
    const subscriptionGate = new Promise<void>((resolve) => { releaseSubscription = resolve })
    const queue: RunJobQueue<Payload, Result> = {
      ...base,
      async onCancelled(runId, listener) {
        markSubscriptionStarted()
        await subscriptionGate
        return await base.onCancelled(runId, listener)
      },
    }
    let observedSignal: AbortSignal | undefined
    const worker = createRunWorker({
      queue,
      workerId: 'worker_shutdown_subscription',
      leaseMs: 5_000,
      now: () => t0,
      handler: {
        execute(_payload, context) {
          observedSignal = context.signal
          return {
            type: 'failed',
            failure: { code: 'SHUTDOWN_ABORTED', message: 'shutdown', retryable: true },
            failedAt: t1,
          }
        },
      },
    })

    const cycle = worker.runOnce()
    await subscriptionStarted
    worker.abortActive()
    releaseSubscription()

    await expect(cycle).resolves.toEqual({ status: 'failed', runId: 'run_1', attempt: 1 })
    expect(observedSignal?.aborted).toBe(true)
  })

  it('awaits every operation supplied by an asynchronous production-shaped queue', async () => {
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    const queue = asynchronousQueue(memory)
    await queue.enqueue({
      runId: 'run_async',
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      payloadFingerprint: 'fingerprint_async',
      payload: { question: '过去 12 个月净收入趋势' },
      enqueuedAt: t0,
    })
    const worker = createRunWorker({
      queue,
      workerId: 'pg_worker_shape',
      leaseMs: 5_000,
      now: () => t0,
      handler: {
        async execute(_payload, context) {
          await expect(context.isLeaseCurrent(t1)).resolves.toBe(true)
          await expect(context.renew(t1, 5_000)).resolves.toBe(true)
          return { type: 'completed', result: { rows: 12 }, resultFingerprint: 'async_result', at: t2 }
        },
      },
    })

    await expect(worker.runOnce('run_async')).resolves.toEqual({
      status: 'completed',
      runId: 'run_async',
      attempt: 1,
    })
    await expect(queue.getJob('run_async')).resolves.toMatchObject({
      status: 'completed',
      resultFingerprint: 'async_result',
    })
  })

  it('preserves lease fencing through an asynchronous queue boundary', async () => {
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory, 'run_async_fence')
    const queue = asynchronousQueue(memory)
    const oldLease = await queue.claimNext({
      workerId: 'worker_old',
      runId: 'run_async_fence',
      now: t0,
      leaseMs: 1_000,
    })
    const currentLease = await queue.claimNext({
      workerId: 'worker_current',
      runId: 'run_async_fence',
      now: t1,
      leaseMs: 5_000,
    })
    if (!oldLease || !currentLease) throw new Error('expected both lease generations')

    await expect(queue.complete({
      ...identity(oldLease),
      completedAt: t2,
      resultFingerprint: 'stale_result',
      result: { rows: 1 },
    })).resolves.toMatchObject({ ok: false, reason: 'stale_lease' })
    await expect(queue.complete({
      ...identity(currentLease),
      completedAt: t2,
      resultFingerprint: 'current_result',
      result: { rows: 12 },
    })).resolves.toMatchObject({ ok: true, applied: true })
  })

  it.each([
    {
      name: 'completion',
      outcome: {
        type: 'completed',
        result: { rows: 12 },
        resultFingerprint: 'atomic_result',
        at: t1,
      } as RunWorkerHandlerResult<Result>,
      cycleStatus: 'completed',
      jobStatus: 'completed',
    },
    {
      name: 'retry',
      outcome: {
        type: 'retry',
        failure: { code: 'QUERY_TIMEOUT', message: 'timeout', retryable: true },
        failedAt: t1,
        availableAt: t2,
      } as RunWorkerHandlerResult<Result>,
      cycleStatus: 'retry_scheduled',
      jobStatus: 'retry_wait',
    },
    {
      name: 'failure',
      outcome: {
        type: 'failed',
        failure: { code: 'QUERY_FAILED', message: 'failed', retryable: false },
        failedAt: t1,
      } as RunWorkerHandlerResult<Result>,
      cycleStatus: 'failed',
      jobStatus: 'failed',
    },
  ] as const)('uses commitAttempt as the sole atomic authority for $name', async ({ outcome, cycleStatus, jobStatus }) => {
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory, `run_atomic_${outcome.type}`)
    const base = asynchronousQueue(memory)
    const complete = vi.fn(base.complete)
    const retry = vi.fn(base.retry)
    const fail = vi.fn(base.fail)
    const queue: RunJobQueue<Payload, Result> = { ...base, complete, retry, fail }
    const commitAttempt = vi.fn(async (input: { lease: RunJobLease<Payload>; outcome: RunWorkerHandlerResult<Result> }) => {
      const leased = await base.getJob(input.lease.runId)
      if (!leased) throw new Error('expected leased job')
      return { ok: true as const, applied: true, job: { ...leased, status: jobStatus } }
    })
    const onCommitted = vi.fn()
    const worker = createRunWorker({
      queue,
      workerId: 'worker_atomic',
      leaseMs: 5_000,
      now: () => t0,
      commitAttempt,
      onCommitted,
      handler: { execute: () => outcome },
    })

    await expect(worker.runOnce(`run_atomic_${outcome.type}`)).resolves.toEqual({
      status: cycleStatus,
      runId: `run_atomic_${outcome.type}`,
      attempt: 1,
    })
    expect(commitAttempt).toHaveBeenCalledWith({
      lease: expect.objectContaining({
        runId: `run_atomic_${outcome.type}`,
        attempt: 1,
        fence: 1,
        leaseToken: expect.any(String),
        payload: { question: '过去 12 个月净收入趋势' },
      }),
      outcome,
    })
    expect(complete).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(onCommitted).toHaveBeenCalledWith(expect.objectContaining({
      outcome,
      job: expect.objectContaining({ status: jobStatus }),
    }))
  })

  it.each([
    { cancelled: true, expected: 'cancelled' },
    { cancelled: false, expected: 'lost_lease' },
  ] as const)('maps an atomic commit conflict to $expected without notification', async ({ cancelled, expected }) => {
    const runId = `run_atomic_conflict_${expected}`
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory, runId)
    const queue = asynchronousQueue(memory)
    const onCommitted = vi.fn()
    const commitAttempt = vi.fn(async () => {
      if (cancelled) await queue.cancel(runId, t1)
      const job = await queue.getJob(runId)
      return { ok: false as const, reason: 'terminal_conflict' as const, ...(job ? { job } : {}) }
    })
    const worker = createRunWorker({
      queue,
      workerId: 'worker_atomic_conflict',
      leaseMs: 5_000,
      now: () => t0,
      commitAttempt,
      onCommitted,
      handler: {
        execute: () => ({
          type: 'completed',
          result: { rows: 12 },
          resultFingerprint: 'conflicting_result',
          at: t1,
        }),
      },
    })

    await expect(worker.runOnce(runId)).resolves.toEqual({ status: expected, runId, attempt: 1 })
    expect(commitAttempt).toHaveBeenCalledOnce()
    expect(onCommitted).not.toHaveBeenCalled()
  })

  it('propagates a safe commit error without falling back or publishing', async () => {
    const runId = 'run_atomic_throw'
    const memory = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(memory, runId)
    const base = asynchronousQueue(memory)
    const complete = vi.fn(base.complete)
    const retry = vi.fn(base.retry)
    const fail = vi.fn(base.fail)
    const queue: RunJobQueue<Payload, Result> = { ...base, complete, retry, fail }
    const internalError = new Error('password=warehouse-secret')
    const onCommitted = vi.fn()
    const worker = createRunWorker({
      queue,
      workerId: 'worker_atomic_throw',
      leaseMs: 5_000,
      now: () => t0,
      commitAttempt: async () => { throw internalError },
      onCommitted,
      handler: {
        execute: () => ({
          type: 'completed',
          result: { rows: 12 },
          resultFingerprint: 'ambiguous_result',
          at: t1,
        }),
      },
    })

    const rejection = await worker.runOnce(runId).catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(RunWorkerCommitAttemptError)
    expect(rejection).toMatchObject({
      code: 'RUN_WORKER_COMMIT_FAILED',
      message: 'Atomic run attempt commit failed.',
      cause: internalError,
    })
    expect(String(rejection)).not.toContain('warehouse-secret')
    expect(complete).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(onCommitted).not.toHaveBeenCalled()
    await expect(queue.getJob(runId)).resolves.toMatchObject({ status: 'leased' })
  })

  it('treats onCommitted as best-effort after either durable authority succeeds', async () => {
    const telemetryError = new Error('cache refresh failed')
    const onCommitted = vi.fn(async () => { throw telemetryError })
    const onPostCommitError = vi.fn(async () => { throw new Error('telemetry unavailable') })

    for (const authority of ['queue', 'hook'] as const) {
      const runId = `run_notification_${authority}`
      const memory = createInMemoryRunJobQueue<Payload, Result>()
      enqueue(memory, runId)
      const queue = asynchronousQueue(memory)
      const worker = createRunWorker({
        queue,
        workerId: `worker_notification_${authority}`,
        leaseMs: 5_000,
        now: () => t0,
        ...(authority === 'hook'
          ? {
              commitAttempt: async ({ lease }: { lease: RunJobLease<Payload> }) => {
                const job = await queue.getJob(lease.runId)
                if (!job) throw new Error('expected leased job')
                return { ok: true as const, applied: true, job: { ...job, status: 'completed' as const } }
              },
            }
          : {}),
        onCommitted,
        onPostCommitError,
        handler: {
          execute: () => ({
            type: 'completed',
            result: { rows: 12 },
            resultFingerprint: `notification_${authority}`,
            at: t1,
          }),
        },
      })

      await expect(worker.runOnce(runId)).resolves.toEqual({ status: 'completed', runId, attempt: 1 })
    }

    expect(onCommitted).toHaveBeenCalledTimes(2)
    expect(onPostCommitError).toHaveBeenCalledTimes(2)
    expect(onPostCommitError).toHaveBeenNthCalledWith(1, telemetryError, expect.objectContaining({
      lease: expect.objectContaining({ runId: 'run_notification_queue' }),
    }))
    expect(onPostCommitError).toHaveBeenNthCalledWith(2, telemetryError, expect.objectContaining({
      lease: expect.objectContaining({ runId: 'run_notification_hook' }),
    }))
  })

  it('automatically renews a long-running handler and clears the heartbeat before completion', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(t0))
      const memory = createInMemoryRunJobQueue<Payload, Result>()
      enqueue(memory, 'run_heartbeat')
      const base = asynchronousQueue(memory)
      const renewLease = vi.fn(base.renewLease)
      const queue: RunJobQueue<Payload, Result> = { ...base, renewLease }
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const worker = createRunWorker({
        queue,
        workerId: 'worker_heartbeat',
        leaseMs: 600,
        now: () => new Date(Date.now()).toISOString(),
        handler: {
          async execute() {
            markStarted()
            await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
            return {
              type: 'completed',
              result: { rows: 12 },
              resultFingerprint: 'heartbeat_result',
              at: new Date(Date.now()).toISOString(),
            }
          },
        },
      })

      const cycle = worker.runOnce('run_heartbeat')
      await started
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(cycle).resolves.toEqual({ status: 'completed', runId: 'run_heartbeat', attempt: 1 })
      expect(renewLease.mock.calls.length).toBeGreaterThanOrEqual(4)
      const callsAfterCompletion = renewLease.mock.calls.length
      await vi.advanceTimersByTimeAsync(1_000)
      expect(renewLease).toHaveBeenCalledTimes(callsAfterCompletion)
      await expect(queue.getJob('run_heartbeat')).resolves.toMatchObject({
        status: 'completed',
        resultFingerprint: 'heartbeat_result',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['failure', 'exception'] as const)(
    'aborts and fences terminal publication when heartbeat renewal ends in %s',
    async (mode) => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date(t0))
        const memory = createInMemoryRunJobQueue<Payload, Result>()
        enqueue(memory, `run_renew_${mode}`)
        const base = asynchronousQueue(memory)
        const complete = vi.fn(base.complete)
        const onCommitted = vi.fn()
        const commitAttempt = vi.fn(async () => {
          throw new Error('lease-lost commit must not run')
        })
        const queue: RunJobQueue<Payload, Result> = {
          ...base,
          complete,
          async renewLease() {
            if (mode === 'exception') throw new Error('database heartbeat unavailable')
            const job = await base.getJob(`run_renew_${mode}`)
            return { ok: false, reason: 'stale_lease', ...(job ? { job } : {}) }
          },
        }
        let workerSignal: AbortSignal | undefined
        let markStarted!: () => void
        const started = new Promise<void>((resolve) => { markStarted = resolve })
        const worker = createRunWorker<Payload, Result>({
          queue,
          workerId: `worker_renew_${mode}`,
          leaseMs: 500,
          heartbeatMs: 100,
          now: () => new Date(Date.now()).toISOString(),
          commitAttempt,
          onCommitted,
          handler: {
            execute(_payload, context) {
              workerSignal = context.signal
              markStarted()
              return new Promise((resolve) => {
                context.signal.addEventListener('abort', () => resolve({
                  type: 'completed',
                  result: { rows: 99 },
                  resultFingerprint: 'must_not_publish',
                  at: new Date(Date.now()).toISOString(),
                }), { once: true })
              })
            },
          },
        })

        const cycle = worker.runOnce(`run_renew_${mode}`)
        await started
        await vi.advanceTimersByTimeAsync(100)

        expect(workerSignal?.aborted).toBe(true)
        await expect(cycle).resolves.toEqual({
          status: 'lost_lease',
          runId: `run_renew_${mode}`,
          attempt: 1,
        })
        expect(complete).not.toHaveBeenCalled()
        expect(commitAttempt).not.toHaveBeenCalled()
        expect(onCommitted).not.toHaveBeenCalled()
        await expect(queue.getJob(`run_renew_${mode}`)).resolves.toMatchObject({ status: 'leased' })
        expect((await queue.getJob(`run_renew_${mode}`))?.result).toBeUndefined()
      } finally {
        vi.useRealTimers()
      }
    },
  )

  it('never overlaps heartbeat renewals when the queue is slow', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(t0))
      const memory = createInMemoryRunJobQueue<Payload, Result>()
      enqueue(memory, 'run_slow_heartbeat')
      const base = asynchronousQueue(memory)
      const pendingRenewals: Array<() => void> = []
      let activeRenewals = 0
      let maxActiveRenewals = 0
      const renewLease = vi.fn((input: Parameters<SynchronousRunJobQueue<Payload, Result>['renewLease']>[0]) => {
        activeRenewals += 1
        maxActiveRenewals = Math.max(maxActiveRenewals, activeRenewals)
        return new Promise<Awaited<ReturnType<RunJobQueue<Payload, Result>['renewLease']>>>((resolve) => {
          pendingRenewals.push(() => {
            activeRenewals -= 1
            resolve(memory.renewLease(input))
          })
        })
      })
      const queue: RunJobQueue<Payload, Result> = { ...base, renewLease }
      const handlerGate = deferred<void>()
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => { markStarted = resolve })
      const worker = createRunWorker({
        queue,
        workerId: 'worker_slow_heartbeat',
        leaseMs: 500,
        heartbeatMs: 100,
        now: () => new Date(Date.now()).toISOString(),
        handler: {
          async execute() {
            markStarted()
            await handlerGate.promise
            return {
              type: 'completed',
              result: { rows: 12 },
              resultFingerprint: 'slow_heartbeat_result',
              at: new Date(Date.now()).toISOString(),
            }
          },
        },
      })

      const cycle = worker.runOnce('run_slow_heartbeat')
      await started
      await vi.advanceTimersByTimeAsync(400)
      expect(renewLease).toHaveBeenCalledTimes(1)
      expect(maxActiveRenewals).toBe(1)

      pendingRenewals.shift()?.()
      await vi.advanceTimersByTimeAsync(100)
      expect(renewLease).toHaveBeenCalledTimes(2)
      expect(maxActiveRenewals).toBe(1)
      pendingRenewals.shift()?.()
      await vi.advanceTimersByTimeAsync(0)
      handlerGate.resolve()

      await expect(cycle).resolves.toEqual({
        status: 'completed',
        runId: 'run_slow_heartbeat',
        attempt: 1,
      })
      expect(maxActiveRenewals).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function asynchronousQueue<TPayload, TResult>(
  queue: SynchronousRunJobQueue<TPayload, TResult>,
): RunJobQueue<TPayload, TResult> {
  return {
    async enqueue(input) { return queue.enqueue(input) },
    async claimNext(input) { return queue.claimNext(input) },
    async renewLease(input) { return queue.renewLease(input) },
    async cancel(runId, cancelledAt) { return queue.cancel(runId, cancelledAt) },
    async complete(input) { return queue.complete(input) },
    async fail(input) { return queue.fail(input) },
    async retry(input) { return queue.retry(input) },
    async getJob(runId) { return queue.getJob(runId) },
    async isLeaseCurrent(lease, now) { return queue.isLeaseCurrent(lease, now) },
    async onCancelled(runId, listener) {
      const unsubscribe = queue.onCancelled(runId, listener)
      return async () => unsubscribe()
    },
  }
}
