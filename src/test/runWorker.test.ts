import { describe, expect, it } from 'vitest'
import { createRunWorker } from '../application/runWorker'
import { createInMemoryRunJobQueue } from '../persistence/jobMemory'
import type { RunJobLease } from '../persistence/jobPorts'

interface Payload { question: string }
interface Result { rows: number }

const t0 = '2026-07-15T09:00:00.000Z'
const t1 = '2026-07-15T09:00:01.000Z'
const t2 = '2026-07-15T09:00:02.000Z'
const t3 = '2026-07-15T09:00:03.000Z'

function enqueue(queue: ReturnType<typeof createInMemoryRunJobQueue<Payload, Result>>, runId = 'run_1', maxAttempts = 3) {
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
        execute(payload, context) {
          expect(payload.question).toContain('净收入')
          expect(context.isLeaseCurrent(t1)).toBe(true)
          return { type: 'completed', result: { rows: 12 }, resultFingerprint: 'fixture_result', at: t1 }
        },
      },
    })

    await expect(worker.runOnce()).resolves.toEqual({ status: 'completed', runId: 'run_1', attempt: 1 })
    expect(queue.getJob('run_1')).toMatchObject({ status: 'completed', result: { rows: 12 } })
  })

  it('cannot publish a handler result after cancellation wins the race', async () => {
    const queue = createInMemoryRunJobQueue<Payload, Result>()
    enqueue(queue)
    let releaseHandler!: () => void
    let workerSignal: AbortSignal | undefined
    const waiting = new Promise<void>((resolve) => { releaseHandler = resolve })
    const worker = createRunWorker({
      queue,
      workerId: 'worker_async',
      leaseMs: 5_000,
      now: () => t0,
      handler: {
        async execute(_payload, context) {
          workerSignal = context.signal
          await waiting
          return { type: 'completed', result: { rows: 12 }, resultFingerprint: 'late_result', at: t2 }
        },
      },
    })

    const cycle = worker.runOnce()
    await Promise.resolve()
    expect(queue.cancel('run_1', t1)).toMatchObject({ ok: true, job: { status: 'cancelled' } })
    expect(workerSignal?.aborted).toBe(true)
    releaseHandler()

    await expect(cycle).resolves.toEqual({ status: 'cancelled', runId: 'run_1', attempt: 1 })
    expect(queue.getJob('run_1')).toMatchObject({ status: 'cancelled' })
    expect(queue.getJob('run_1')?.result).toBeUndefined()
  })
})
