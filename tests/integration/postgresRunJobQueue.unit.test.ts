import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  createPostgresRunJobQueue,
  type PostgresRunJobClientLike,
  type PostgresRunJobPoolLike,
} from '../../apps/api/src/adapters/postgresRunJobQueue'

interface Call {
  text: string
  values?: readonly unknown[]
}

const t0 = '2026-07-15T09:00:00.000Z'
const t1 = '2026-07-15T09:00:01.000Z'
const t2 = '2026-07-15T09:00:02.000Z'

function tokenHash(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function row(patch: Record<string, unknown> = {}) {
  return {
    run_id: 'run_1',
    tenant_id: 'tenant_demo',
    workspace_id: 'workspace_sales',
    payload_fingerprint: 'payload_v1',
    payload_json: { question: '过去 12 个月净收入趋势' },
    status: 'queued',
    attempt: 0,
    max_attempts: 3,
    fence: 0,
    enqueued_at: t0,
    available_at: t0,
    lease_owner: null,
    lease_token_hash: null,
    lease_expires_at: null,
    cancel_requested_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_failure_json: null,
    result_fingerprint: null,
    result_json: null,
    terminal_kind: null,
    terminal_attempt: null,
    terminal_fence: null,
    terminal_worker_id: null,
    terminal_lease_token_hash: null,
    terminal_fingerprint: null,
    ...patch,
  }
}

class ScriptedClient implements PostgresRunJobClientLike {
  readonly calls: Call[] = []
  released = false
  releaseError: Error | boolean | undefined

  constructor(
    private readonly handler: (text: string, values?: readonly unknown[]) => Promise<{
      rows: unknown[]
      rowCount: number | null
    }>,
  ) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return await this.handler(text, values) as { rows: Row[]; rowCount: number | null }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseError = error
  }
}

class ScriptedPool implements PostgresRunJobPoolLike {
  connectCount = 0
  readonly directCalls: Call[] = []

  constructor(readonly client: ScriptedClient) {}

  async connect() {
    this.connectCount += 1
    return this.client
  }

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.directCalls.push({ text, values })
    return { rows: [] as Row[], rowCount: 0 }
  }
}

function empty() {
  return Promise.resolve({ rows: [], rowCount: 0 })
}

function leaseIdentity(token = 'lease_current') {
  return {
    runId: 'run_1',
    attempt: 1,
    fence: 1,
    workerId: 'worker_a',
    leaseToken: token,
  }
}

describe('PostgreSQL durable RunJobQueue unit boundary', () => {
  it('claims with one transaction, FOR UPDATE SKIP LOCKED and UPDATE RETURNING while keeping the token opaque', async () => {
    const rawToken = 'opaque_lease_token_never_persisted'
    const hashedToken = tokenHash(rawToken)
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('with candidate as')) {
        return {
          rows: [row({
            status: 'leased',
            attempt: 1,
            fence: 1,
            lease_owner: 'worker_a',
            lease_token_hash: hashedToken,
            lease_expires_at: t2,
            previous_status: 'queued',
            previous_attempt: 0,
          })],
          rowCount: 1,
        }
      }
      return empty()
    })
    const pool = new ScriptedPool(client)
    const queue = createPostgresRunJobQueue<{ question: string }, { rows: number }>({
      pool,
      leaseToken: () => rawToken,
    })

    const lease = await queue.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 2_000 })

    expect(lease).toMatchObject({
      runId: 'run_1',
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      attempt: 1,
      fence: 1,
      workerId: 'worker_a',
      leaseToken: rawToken,
      leaseExpiresAt: t2,
    })
    const claim = client.calls.find((call) => call.text.startsWith('with candidate as'))!
    expect(claim.text.toLowerCase()).toContain('for update skip locked')
    expect(claim.text.toLowerCase()).toContain('update chatbi_run_jobs')
    expect(claim.text.toLowerCase()).toContain('returning job.*')
    expect(claim.values).toContain(hashedToken)
    expect(claim.values).not.toContain(rawToken)
    expect(client.calls[0].text).toBe('BEGIN')
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    expect(client.released).toBe(true)
  })

  it('preserves tenant/workspace identity on an enqueue idempotency conflict', async () => {
    const existing = row({ tenant_id: 'tenant_other', workspace_id: 'workspace_other' })
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_run_jobs')) return { rows: [], rowCount: 0 }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') return { rows: [existing], rowCount: 1 }
      return empty()
    })
    const queue = createPostgresRunJobQueue<{ question: string }, unknown>({ pool: new ScriptedPool(client) })

    const result = await queue.enqueue({
      runId: 'run_1',
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      payloadFingerprint: 'payload_v1',
      payload: { question: 'question' },
      enqueuedAt: t0,
    })

    expect(result).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
      job: { tenantId: 'tenant_other', workspaceId: 'workspace_other' },
    })
    const insert = client.calls.find((call) => call.text.startsWith('insert into chatbi_run_jobs'))!
    expect(insert.values?.slice(0, 5)).toEqual([
      'run_1', 'tenant_demo', 'workspace_sales', 'payload_v1', JSON.stringify({ question: 'question' }),
    ])
  })

  it.each(['complete', 'fail', 'retry'] as const)('rejects an old lease before %s can mutate durable state', async (mutation) => {
    const current = row({
      status: 'leased',
      attempt: 2,
      fence: 2,
      lease_owner: 'worker_new',
      lease_token_hash: tokenHash('new_token'),
      lease_expires_at: '2026-07-15T09:00:10.000Z',
    })
    const client = new ScriptedClient(async (text) => {
      if (text.endsWith('for update')) return { rows: [current], rowCount: 1 }
      return empty()
    })
    const queue = createPostgresRunJobQueue({ pool: new ScriptedPool(client) })
    const old = leaseIdentity('old_token')
    const result = mutation === 'complete'
      ? await queue.complete({ ...old, completedAt: t1, resultFingerprint: 'old', result: { rows: 1 } })
      : mutation === 'fail'
        ? await queue.fail({ ...old, failedAt: t1, failure: { code: 'OLD', message: 'old', retryable: false } })
        : await queue.retry({
            ...old,
            failedAt: t1,
            availableAt: t2,
            failure: { code: 'OLD', message: 'old', retryable: true },
          })

    expect(result).toMatchObject({ ok: false, reason: 'stale_lease' })
    expect(client.calls.some((call) => /^update chatbi_run_jobs/.test(call.text))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    expect(client.released).toBe(true)
  })

  it('renews only the exact attempt/fence/worker/token lease', async () => {
    const token = 'lease_current'
    const leased = row({
      status: 'leased',
      attempt: 1,
      fence: 1,
      lease_owner: 'worker_a',
      lease_token_hash: tokenHash(token),
      lease_expires_at: t2,
    })
    const renewed = { ...leased, lease_expires_at: '2026-07-15T09:00:06.000Z' }
    let updated = false
    const client = new ScriptedClient(async (text) => {
      if (text.endsWith('for update')) return { rows: [leased], rowCount: 1 }
      if (text.startsWith('update chatbi_run_jobs')) { updated = true; return empty() }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') return { rows: [updated ? renewed : leased], rowCount: 1 }
      return empty()
    })
    const queue = createPostgresRunJobQueue({ pool: new ScriptedPool(client) })

    const result = await queue.renewLease({ ...leaseIdentity(token), now: t1, leaseMs: 5_000 })

    expect(result).toMatchObject({ ok: true, applied: true, job: { leaseExpiresAt: '2026-07-15T09:00:06.000Z' } })
    expect(client.calls.some((call) => call.text.includes('update chatbi_run_job_attempts'))).toBe(true)
  })

  it('stores result JSON and makes the winning completion idempotent', async () => {
    const token = 'lease_current'
    let state = row({
      status: 'leased',
      attempt: 1,
      fence: 1,
      lease_owner: 'worker_a',
      lease_token_hash: tokenHash(token),
      lease_expires_at: t2,
    })
    const client = new ScriptedClient(async (text, values) => {
      if (text.endsWith('for update')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('update chatbi_run_jobs')) {
        state = row({
          status: 'completed',
          attempt: 1,
          fence: 1,
          completed_at: t1,
          result_fingerprint: 'result_v1',
          result_json: JSON.parse(String(values?.[3])),
          terminal_kind: 'completed',
          terminal_attempt: 1,
          terminal_fence: 1,
          terminal_worker_id: 'worker_a',
          terminal_lease_token_hash: tokenHash(token),
          terminal_fingerprint: 'result_v1',
        })
        return empty()
      }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') return { rows: [state], rowCount: 1 }
      return empty()
    })
    const queue = createPostgresRunJobQueue<{ question: string }, { rows: number; values: number[] }>({
      pool: new ScriptedPool(client),
    })
    const completion = {
      ...leaseIdentity(token),
      completedAt: t1,
      resultFingerprint: 'result_v1',
      result: { rows: 3, values: [1, 2, 3] },
    }

    expect(await queue.complete(completion)).toMatchObject({
      ok: true,
      applied: true,
      job: { status: 'completed', result: { rows: 3, values: [1, 2, 3] } },
    })
    expect(await queue.complete(completion)).toMatchObject({ ok: true, applied: false })
    const resultWrite = client.calls.find((call) => call.text.startsWith('update chatbi_run_jobs'))!
    expect(resultWrite.values?.[3]).toBe(JSON.stringify(completion.result))
  })

  it('cancels idempotently, closes the active attempt and wakes a registered observer once', async () => {
    let state = row({
      status: 'leased',
      attempt: 1,
      fence: 1,
      lease_owner: 'worker_a',
      lease_token_hash: tokenHash('lease_current'),
      lease_expires_at: t2,
    })
    const client = new ScriptedClient(async (text) => {
      if (text.endsWith('for update')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('update chatbi_run_jobs')) {
        state = row({
          status: 'cancelled',
          attempt: 1,
          fence: 1,
          cancel_requested_at: t1,
          cancelled_at: t1,
        })
        return empty()
      }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') return { rows: [state], rowCount: 1 }
      return empty()
    })
    const queue = createPostgresRunJobQueue({ pool: new ScriptedPool(client), cancellationPollMs: 10_000 })
    const listener = vi.fn()
    const unsubscribe = await queue.onCancelled('run_1', listener)

    expect(await queue.cancel('run_1', t1)).toMatchObject({ ok: true, applied: true, job: { status: 'cancelled' } })
    expect(await queue.cancel('run_1', t2)).toMatchObject({ ok: true, applied: false, job: { cancelledAt: t1 } })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(client.calls.some((call) => call.text.includes("outcome = $4") && call.values?.includes('cancelled'))).toBe(true)
    unsubscribe()
    await queue.close()
  })

  it('rolls back and releases when the atomic claim statement fails', async () => {
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('with candidate as')) throw new Error('database detail must stay inside adapter boundary')
      return empty()
    })
    const queue = createPostgresRunJobQueue({ pool: new ScriptedPool(client), leaseToken: () => 'opaque' })

    await expect(queue.claimNext({ workerId: 'worker_a', now: t0, leaseMs: 2_000 })).rejects.toThrow()
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('ships scoped control-plane tables and claim indexes', () => {
    const migration = readFileSync(new URL('../../scripts/postgres/control-plane.sql', import.meta.url), 'utf8')
    expect(migration).toContain('create table if not exists chatbi_run_jobs')
    expect(migration).toContain('create table if not exists chatbi_run_job_attempts')
    expect(migration).toContain('tenant_id text not null')
    expect(migration).toContain('workspace_id text not null')
    expect(migration).toContain('lease_token_hash text')
    expect(migration).toContain('chatbi_run_jobs_claim_idx')
  })
})
