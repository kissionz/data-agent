import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createPostgresRunJobQueue } from '../../apps/api/src/adapters/postgresRunJobQueue'
import type { RunJobLease } from '../../src/persistence/jobPorts'

interface Payload { question: string; constraints: { tenantId: string; workspaceId: string } }
interface Result { rows: number; values: number[] }

const databaseUrl = process.env.CHATBI_TEST_POSTGRES_ADMIN_URL
  ?? 'postgresql://chatbi_admin:chatbi_admin@127.0.0.1:55432/chatbi_test'
const t0 = '2026-07-15T09:00:00.000Z'
const t1 = '2026-07-15T09:00:01.000Z'
const t2 = '2026-07-15T09:00:02.000Z'
const t3 = '2026-07-15T09:00:03.000Z'

function enqueueInput(runId: string, enqueuedAt = t0, maxAttempts = 3) {
  return {
    runId,
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    payloadFingerprint: `fingerprint_${runId}`,
    payload: {
      question: '过去 12 个月净收入趋势',
      constraints: { tenantId: 'tenant_demo', workspaceId: 'workspace_sales' },
    },
    enqueuedAt,
    maxAttempts,
  }
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

describe('PostgreSQL durable RunJobQueue real integration', () => {
  let admin: Pool
  let poolA: Pool
  let poolB: Pool
  let queueA: ReturnType<typeof createPostgresRunJobQueue<Payload, Result>>
  let queueB: ReturnType<typeof createPostgresRunJobQueue<Payload, Result>>

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 })
    poolA = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    poolB = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    queueA = createPostgresRunJobQueue<Payload, Result>({ pool: poolA, cancellationPollMs: 50 })
    queueB = createPostgresRunJobQueue<Payload, Result>({ pool: poolB, cancellationPollMs: 50 })
    await admin.query('select 1 from chatbi_run_jobs limit 1')
  })

  beforeEach(async () => {
    await admin.query('truncate table chatbi_run_job_attempts, chatbi_run_jobs')
  })

  afterAll(async () => {
    await queueA?.close()
    await queueB?.close()
    await Promise.all([admin?.end(), poolA?.end(), poolB?.end()])
  })

  it('persists tenant/workspace-scoped payload JSON across adapter instances', async () => {
    expect(await queueA.enqueue(enqueueInput('run_persisted'))).toMatchObject({ ok: true, created: true })
    expect(await queueA.enqueue(enqueueInput('run_persisted'))).toMatchObject({ ok: true, created: false })

    const restored = await queueB.getJob('run_persisted')

    expect(restored).toMatchObject({
      runId: 'run_persisted',
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      payloadFingerprint: 'fingerprint_run_persisted',
      payload: {
        question: '过去 12 个月净收入趋势',
        constraints: { tenantId: 'tenant_demo', workspaceId: 'workspace_sales' },
      },
      status: 'queued',
    })
    expect(await queueB.enqueue({
      ...enqueueInput('run_persisted'),
      tenantId: 'tenant_other',
    })).toMatchObject({ ok: false, reason: 'idempotency_conflict' })
  })

  it('uses SKIP LOCKED so a locked oldest job does not block the next claim', async () => {
    await queueA.enqueue(enqueueInput('run_oldest', t0))
    await queueA.enqueue(enqueueInput('run_next', t1))
    const locker = await admin.connect()
    try {
      await locker.query('begin')
      await locker.query("select run_id from chatbi_run_jobs where run_id = 'run_oldest' for update")

      const lease = await queueB.claimNext({ workerId: 'worker_b', now: t2, leaseMs: 5_000 })

      expect(lease).toMatchObject({ runId: 'run_next', attempt: 1, fence: 1, workerId: 'worker_b' })
    } finally {
      await locker.query('rollback')
      locker.release()
    }
  })

  it('reclaims an expired lease with a new opaque token and fences every old terminal mutation', async () => {
    await queueA.enqueue(enqueueInput('run_reclaimed'))
    const oldLease = (await queueA.claimNext({ workerId: 'worker_old', now: t0, leaseMs: 1_000 }))!
    const currentLease = (await queueB.claimNext({ workerId: 'worker_new', now: t1, leaseMs: 5_000 }))!

    expect(currentLease).toMatchObject({ attempt: 2, fence: 2, workerId: 'worker_new' })
    expect(currentLease.leaseToken).not.toBe(oldLease.leaseToken)
    expect(currentLease.leaseToken.length).toBeGreaterThan(20)
    const storedLease = await admin.query<{ lease_token_hash: string }>(
      "select lease_token_hash from chatbi_run_jobs where run_id = 'run_reclaimed'",
    )
    expect(storedLease.rows[0].lease_token_hash).not.toBe(currentLease.leaseToken)

    await expect(queueA.complete({
      ...identity(oldLease), completedAt: t2, resultFingerprint: 'old', result: { rows: 1, values: [1] },
    })).resolves.toMatchObject({ ok: false, reason: 'stale_lease' })
    await expect(queueA.fail({
      ...identity(oldLease), failedAt: t2, failure: { code: 'OLD', message: 'old', retryable: false },
    })).resolves.toMatchObject({ ok: false, reason: 'stale_lease' })
    await expect(queueA.retry({
      ...identity(oldLease), failedAt: t2, availableAt: t3,
      failure: { code: 'OLD', message: 'old', retryable: true },
    })).resolves.toMatchObject({ ok: false, reason: 'stale_lease' })

    expect(await queueB.complete({
      ...identity(currentLease),
      completedAt: t2,
      resultFingerprint: 'result_v2',
      result: { rows: 3, values: [1184000, 1268000, 1326000] },
    })).toMatchObject({ ok: true, applied: true })
    expect(await queueA.getJob('run_reclaimed')).toMatchObject({
      status: 'completed',
      resultFingerprint: 'result_v2',
      result: { rows: 3, values: [1184000, 1268000, 1326000] },
      attempts: [
        { attempt: 1, fence: 1, outcome: 'lease_expired' },
        { attempt: 2, fence: 2, outcome: 'completed' },
      ],
    })
  })

  it('renews only the current lease and prevents premature reclaim', async () => {
    await queueA.enqueue(enqueueInput('run_renewed'))
    const lease = (await queueA.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 1_000 }))!

    expect(await queueA.renewLease({ ...identity(lease), now: '2026-07-15T09:00:00.500Z', leaseMs: 5_000 }))
      .toMatchObject({ ok: true, job: { leaseExpiresAt: '2026-07-15T09:00:05.500Z' } })
    expect(await queueB.claimNext({ workerId: 'worker_b', now: t2, leaseMs: 1_000 })).toBeUndefined()
    expect(await queueB.isLeaseCurrent(identity(lease), t2)).toBe(true)
    expect(await queueB.renewLease({ ...identity(lease), leaseToken: 'stale', now: t2, leaseMs: 1_000 }))
      .toMatchObject({ ok: false, reason: 'stale_lease' })
  })

  it('delivers cross-adapter cancellation, keeps cancel idempotent and makes the job unclaimable', async () => {
    await queueA.enqueue(enqueueInput('run_cancelled'))
    const cancelled = new Promise<void>((resolve) => {
      void queueA.onCancelled('run_cancelled', resolve)
    })

    expect(await queueB.cancel('run_cancelled', t1)).toMatchObject({ ok: true, applied: true })
    await expect(Promise.race([
      cancelled.then(() => 'cancelled'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
    ])).resolves.toBe('cancelled')
    expect(await queueA.cancel('run_cancelled', t2)).toMatchObject({
      ok: true,
      applied: false,
      job: { cancelRequestedAt: t1, cancelledAt: t1 },
    })
    expect(await queueB.claimNext({ workerId: 'worker_b', now: t3, leaseMs: 1_000, runId: 'run_cancelled' }))
      .toBeUndefined()
  })

  it('persists retry JSON, respects availability and enforces the attempt budget', async () => {
    await queueA.enqueue(enqueueInput('run_retry', t0, 2))
    const first = (await queueA.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 5_000 }))!
    const failure = { code: 'WAREHOUSE_TIMEOUT', message: 'retry later', retryable: true }

    expect(await queueA.retry({ ...identity(first), failedAt: t1, availableAt: t2, failure }))
      .toMatchObject({ ok: true, job: { status: 'retry_wait', lastFailure: failure } })
    expect(await queueB.claimNext({ workerId: 'worker_b', now: t1, leaseMs: 5_000, runId: 'run_retry' }))
      .toBeUndefined()
    const second = (await queueB.claimNext({ workerId: 'worker_b', now: t2, leaseMs: 5_000, runId: 'run_retry' }))!
    expect(second).toMatchObject({ attempt: 2, fence: 2 })
    expect(await queueB.retry({ ...identity(second), failedAt: t3, availableAt: '2026-07-15T09:00:04.000Z', failure }))
      .toMatchObject({ ok: false, reason: 'attempts_exhausted' })
  })
})
