import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createPostgresOutboxStore,
  enqueueWithClient,
  type PostgresOutboxClientLike,
  type PostgresOutboxPoolLike,
} from '../../apps/api/src/adapters/postgresOutboxStore'
import type {
  AckOutboxMessageInput,
  OutboxEnqueueInput,
  OutboxFailure,
} from '../../src/persistence/outboxPorts'

interface Call { text: string; values?: readonly unknown[] }
interface Result { rows: unknown[]; rowCount: number | null }

const occurredAt = '2026-07-23T08:00:00.000Z'
const leaseExpiresAt = '2026-07-23T08:01:00.000Z'

class ScriptedClient implements PostgresOutboxClientLike {
  readonly calls: Call[] = []
  released = false
  releaseArgument: Error | boolean | undefined

  constructor(private readonly handler: (text: string, values?: readonly unknown[]) => Promise<Result>) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return await this.handler(text, values) as { rows: Row[]; rowCount: number | null }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseArgument = error
  }
}

class ScriptedPool implements PostgresOutboxPoolLike {
  constructor(readonly client: ScriptedClient) {}
  async connect() { return this.client }
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    return await this.client.query<Row>(text, values)
  }
}

function empty(): Promise<Result> {
  return Promise.resolve({ rows: [], rowCount: 0 })
}

function eventRow(patch: Record<string, unknown> = {}) {
  return {
    event_id: 'outbox_evt_1',
    tenant_id: 'tenant_1',
    workspace_id: 'workspace_1',
    aggregate_type: 'query_run',
    aggregate_id: 'run_1',
    topic: 'query.attempt.completed.v1',
    payload_fingerprint: 'a'.repeat(64),
    payload_json: {
      schemaVersion: 'query_control_plane.v1',
      type: 'query.attempt.completed',
      runId: 'run_1',
      resultId: 'result_1',
      queryStatus: 'succeeded',
    },
    status: 'pending',
    attempt: 0,
    max_attempts: 5,
    fence: 0,
    occurred_at: occurredAt,
    available_at: occurredAt,
    lease_owner: null,
    lease_token_hash: null,
    lease_expires_at: null,
    published_at: null,
    dead_lettered_at: null,
    publication_fingerprint: null,
    last_failure_json: null,
    terminal_kind: null,
    terminal_attempt: null,
    terminal_fence: null,
    terminal_publisher_id: null,
    terminal_lease_token_hash: null,
    terminal_fingerprint: null,
    created_at: occurredAt,
    updated_at: occurredAt,
    ...patch,
  }
}

function attemptRow(patch: Record<string, unknown> = {}) {
  return {
    attempt: 1,
    fence: 1,
    publisher_id: 'publisher_1',
    started_at: occurredAt,
    lease_expires_at: leaseExpiresAt,
    ended_at: null,
    outcome: null,
    failure_json: null,
    ...patch,
  }
}

function enqueueInput(patch: Partial<OutboxEnqueueInput<Record<string, unknown>>> = {}) {
  return {
    eventId: 'outbox_evt_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    aggregateType: 'query_run' as const,
    aggregateId: 'run_1',
    topic: 'query.attempt.completed.v1',
    payload: {
      schemaVersion: 'query_control_plane.v1',
      type: 'query.attempt.completed',
      runId: 'run_1',
      resultId: 'result_1',
      queryStatus: 'succeeded',
    },
    occurredAt,
    maxAttempts: 5,
    ...patch,
  }
}

describe('PostgreSQL durable outbox enqueue boundary', () => {
  it('is transaction-bound, canonical and idempotent only for the exact envelope', async () => {
    let stored: ReturnType<typeof eventRow> | undefined
    const client = new ScriptedClient(async (text, values) => {
      if (text.startsWith('insert into chatbi_query_outbox')) {
        if (!stored) {
          stored = eventRow({
            payload_fingerprint: values?.[6],
            payload_json: JSON.parse(String(values?.[7])),
            max_attempts: values?.[8],
            occurred_at: values?.[9],
            available_at: values?.[10],
          })
          return { rows: [{ event_id: 'outbox_evt_1' }], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      }
      if (text === 'select * from chatbi_query_outbox where event_id = $1') {
        return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 }
      }
      if (text.startsWith('select\n  attempt, fence')) return await empty()
      throw new Error(`unexpected SQL: ${text}`)
    })

    const first = await enqueueWithClient(client, enqueueInput())
    const replay = await enqueueWithClient(client, enqueueInput({
      payload: {
        queryStatus: 'succeeded',
        resultId: 'result_1',
        runId: 'run_1',
        type: 'query.attempt.completed',
        schemaVersion: 'query_control_plane.v1',
      },
    }))

    expect(first).toMatchObject({ ok: true, created: true })
    expect(replay).toMatchObject({ ok: true, created: false })
    expect(client.calls.some(({ text }) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(text))).toBe(false)
    const insert = client.calls.find(({ text }) => text.startsWith('insert into chatbi_query_outbox'))!
    expect(insert.values?.[7]).toBe(
      '{"queryStatus":"succeeded","resultId":"result_1","runId":"run_1","schemaVersion":"query_control_plane.v1","type":"query.attempt.completed"}',
    )
    expect(insert.values?.[6]).toMatch(/^[0-9a-f]{64}$/)

    const conflicting = [
      enqueueInput({ tenantId: 'tenant_2' }),
      enqueueInput({ workspaceId: 'workspace_2' }),
      enqueueInput({ aggregateId: 'run_2' }),
      enqueueInput({ topic: 'query.attempt.failed.v1' }),
      enqueueInput({ payload: { schemaVersion: 'query_control_plane.v1', type: 'changed' } }),
      enqueueInput({ occurredAt: '2026-07-23T08:00:01.000Z' }),
      enqueueInput({ availableAt: '2026-07-23T08:00:02.000Z' }),
      enqueueInput({ maxAttempts: 6 }),
    ]
    for (const changed of conflicting) {
      await expect(enqueueWithClient(client, changed)).resolves.toMatchObject({
        ok: false,
        reason: 'idempotency_conflict',
      })
    }
  })

  it('allows public-safe references/status while rejecting SQL, parameters, credentials and result details', async () => {
    let fingerprint = ''
    const client = new ScriptedClient(async (text, values) => {
      if (text.startsWith('insert into chatbi_query_outbox')) {
        fingerprint = String(values?.[6])
        return { rows: [{ event_id: 'outbox_evt_1' }], rowCount: 1 }
      }
      if (text === 'select * from chatbi_query_outbox where event_id = $1') {
        return { rows: [eventRow({
          payload_fingerprint: fingerprint,
          payload_json: JSON.parse(String(client.calls[0].values?.[7])),
        })], rowCount: 1 }
      }
      if (text.startsWith('select\n  attempt, fence')) return await empty()
      throw new Error(`unexpected SQL: ${text}`)
    })

    await expect(enqueueWithClient(client, enqueueInput({
      payload: {
        resultId: 'result_1',
        queryStatus: 'succeeded',
        policyVersion: 'policy_2026_07',
        sqlFingerprint: 'sha256:public_only',
      },
    }))).resolves.toMatchObject({ ok: true })

    const unsafePayloads: unknown[] = [
      { rawSql: 'redacted-even-before-value-check' },
      { parameters: ['tenant_1'] },
      { credentials: { reference: 'vault_ref' } },
      { resultRows: [{ amount: 100 }] },
      { error: { message: 'driver detail' } },
      { stack: 'private stack' },
      { summary: 'postgresql://admin:secret@private-db/chatbi' },
      { summary: 'SELECT * FROM private_table' },
      { summary: 'x'.repeat(65 * 1024) },
      { nested: { authorization: 'Bearer private' } },
      { nested: { apiKey: 'private' } },
      { nested: { prompt: 'user question' } },
    ]
    const recursive: Record<string, unknown> = {}
    recursive.self = recursive
    unsafePayloads.push(recursive)

    const before = client.calls.length
    await expect(enqueueWithClient(client, enqueueInput({
      availableAt: '2026-07-23T07:59:59.000Z',
    }))).rejects.toThrow('availableAt cannot be before occurredAt')
    for (const payload of unsafePayloads) {
      await expect(enqueueWithClient(client, enqueueInput({ payload: payload as Record<string, unknown> })))
        .rejects.toThrow(/payload|sensitive/i)
    }
    expect(client.calls).toHaveLength(before)
  })
})

describe('PostgreSQL durable outbox leases and attempt history', () => {
  it('claims with SKIP LOCKED, hashes the token and inserts a durable attempt', async () => {
    const token = 'lease_token_private'
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const client = new ScriptedClient(async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.includes('select event_id, attempt, db_clock.db_now')) return await empty()
      if (text.includes('), candidate as (')) {
        return {
          rows: [eventRow({
            status: 'leased',
            attempt: 1,
            fence: 1,
            lease_owner: 'publisher_1',
            lease_token_hash: tokenHash,
            lease_expires_at: leaseExpiresAt,
          })],
          rowCount: 1,
        }
      }
      if (text.startsWith('insert into chatbi_query_outbox_attempts')) return { rows: [], rowCount: 1 }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const outbox = createPostgresOutboxStore({
      pool: new ScriptedPool(client),
      leaseToken: () => token,
    })

    const lease = await outbox.claimNext({
      publisherId: 'publisher_1',
      now: '2099-01-01T00:00:00.000Z',
      leaseMs: 60_000,
    })

    expect(lease).toMatchObject({
      eventId: 'outbox_evt_1',
      attempt: 1,
      fence: 1,
      publisherId: 'publisher_1',
      leaseToken: token,
      occurredAt,
      leaseExpiresAt,
    })
    const claim = client.calls.find(({ text }) => text.includes('), candidate as ('))!
    expect(claim.text).toContain('for update of message skip locked')
    expect(claim.text).toContain('event.fence + 1')
    expect(claim.text).toContain('available_at <= db_clock.db_now')
    expect(claim.text).toContain("candidate.db_now + ($5::bigint * interval '1 millisecond')")
    expect(claim.values).toEqual([
      null,
      'publisher_1',
      tokenHash,
      JSON.stringify(leaseExpiredFailure()),
      60_000,
    ])
    expect(claim.values).not.toContain(occurredAt)
    expect(JSON.stringify(client.calls)).not.toContain(token)
    expect(client.calls.some(({ text }) => text.startsWith('insert into chatbi_query_outbox_attempts'))).toBe(true)
    expect(client.released).toBe(true)
  })

  it('closes an expired attempt before takeover and fences the former publisher', async () => {
    const newToken = 'new_lease_token'
    const newHash = createHash('sha256').update(newToken).digest('hex')
    let closed = false
    const client = new ScriptedClient(async (text) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.includes('select event_id, attempt, db_clock.db_now')) return await empty()
      if (text.includes('), candidate as (')) {
        return {
          rows: [eventRow({
            status: 'leased',
            attempt: 2,
            fence: 7,
            lease_owner: 'publisher_new',
            lease_token_hash: newHash,
            lease_expires_at: leaseExpiresAt,
            previous_status: 'leased',
            previous_attempt: 1,
            last_failure_json: leaseExpiredFailure(),
          })],
          rowCount: 1,
        }
      }
      if (text.startsWith('update chatbi_query_outbox_attempts')) {
        closed = true
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('insert into chatbi_query_outbox_attempts')) {
        expect(closed).toBe(true)
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const outbox = createPostgresOutboxStore({
      pool: new ScriptedPool(client),
      leaseToken: () => newToken,
    })

    await expect(outbox.claimNext({
      publisherId: 'publisher_new',
      now: occurredAt,
      leaseMs: 60_000,
    })).resolves.toMatchObject({ attempt: 2, fence: 7 })

    const close = client.calls.find(({ text }) => text.startsWith('update chatbi_query_outbox_attempts'))!
    expect(close.values).toEqual([
      'outbox_evt_1',
      1,
      occurredAt,
      'lease_expired',
      JSON.stringify(leaseExpiredFailure()),
    ])
  })

  it('acknowledges with full CAS, closes history and makes an exact replay idempotent', async () => {
    const token = 'ack_private_token'
    const tokenHash = createHash('sha256').update(token).digest('hex')
    let row = eventRow({
      status: 'leased',
      attempt: 1,
      fence: 4,
      lease_owner: 'publisher_1',
      lease_token_hash: tokenHash,
      lease_expires_at: leaseExpiresAt,
    })
    let attempt = attemptRow({ fence: 4 })
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text === 'select clock_timestamp() as db_now') {
        return { rows: [{ db_now: '2026-07-23T08:00:30.000Z' }], rowCount: 1 }
      }
      if (text === 'select * from chatbi_query_outbox where event_id = $1 for update') {
        return { rows: [row], rowCount: 1 }
      }
      if (text.startsWith('select\n  attempt, fence')) return { rows: [attempt], rowCount: 1 }
      if (text.startsWith("update chatbi_query_outbox\nset status = 'published'")) {
        row = eventRow({
          ...row,
          status: 'published',
          lease_owner: null,
          lease_token_hash: null,
          lease_expires_at: null,
          published_at: values?.[5],
          publication_fingerprint: values?.[6],
          terminal_kind: 'published',
          terminal_attempt: 1,
          terminal_fence: 4,
          terminal_publisher_id: 'publisher_1',
          terminal_lease_token_hash: tokenHash,
          terminal_fingerprint: values?.[6],
        })
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_query_outbox_attempts')) {
        attempt = attemptRow({
          fence: 4,
          ended_at: values?.[2],
          outcome: values?.[3],
        })
        return { rows: [], rowCount: 1 }
      }
      if (text === 'select * from chatbi_query_outbox where event_id = $1') {
        return { rows: [row], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const outbox = createPostgresOutboxStore({ pool: new ScriptedPool(client) })
    const input: AckOutboxMessageInput = {
      eventId: 'outbox_evt_1',
      attempt: 1,
      fence: 4,
      publisherId: 'publisher_1',
      leaseToken: token,
      publishedAt: '2026-07-23T08:00:30.000Z',
      publicationFingerprint: 'publication_sha256_1',
    }

    await expect(outbox.ack(input)).resolves.toMatchObject({
      ok: true,
      applied: true,
      message: {
        status: 'published',
        publicationFingerprint: 'publication_sha256_1',
        attempts: [{ outcome: 'published' }],
      },
    })
    await expect(outbox.ack(input)).resolves.toMatchObject({ ok: true, applied: false })

    const mutation = client.calls.find(({ text }) => text.includes("set status = 'published'"))!
    expect(mutation.text).toContain('attempt = $2')
    expect(mutation.text).toContain('fence = $3')
    expect(mutation.text).toContain('lease_token_hash = $5')
    expect(mutation.text).toContain('lease_expires_at > clock_timestamp()')
    expect(mutation.values?.[4]).toBe(tokenHash)
    expect(JSON.stringify(client.calls)).not.toContain(token)
  })

  it.each(['ack', 'retry', 'deadLetter'] as const)(
    '%s cannot use an old business timestamp after the database lease has expired',
    async (action) => {
      const token = 'expired_private_token'
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const row = eventRow({
        status: 'leased',
        attempt: 1,
        fence: 3,
        lease_owner: 'publisher_1',
        lease_token_hash: tokenHash,
        lease_expires_at: '2026-07-23T08:00:10.000Z',
      })
      const client = new ScriptedClient(async (text) => {
        if (text === 'BEGIN' || text === 'COMMIT') return await empty()
        if (text === 'select * from chatbi_query_outbox where event_id = $1 for update') {
          return { rows: [row], rowCount: 1 }
        }
        if (text === 'select clock_timestamp() as db_now') {
          return { rows: [{ db_now: '2026-07-23T08:00:30.000Z' }], rowCount: 1 }
        }
        if (text.startsWith('select\n  attempt, fence')) {
          return { rows: [attemptRow({ fence: 3 })], rowCount: 1 }
        }
        throw new Error(`unexpected SQL: ${text}`)
      })
      const outbox = createPostgresOutboxStore({ pool: new ScriptedPool(client) })
      const identity = {
        eventId: 'outbox_evt_1',
        attempt: 1,
        fence: 3,
        publisherId: 'publisher_1',
        leaseToken: token,
      }
      const result = action === 'ack'
        ? await outbox.ack({
            ...identity,
            publishedAt: '2026-07-23T08:00:05.000Z',
            publicationFingerprint: 'publication_sha256_expired',
          })
        : action === 'retry'
          ? await outbox.retry({
              ...identity,
              failedAt: '2026-07-23T08:00:05.000Z',
              availableAt: '2026-07-23T08:00:06.000Z',
              failure: { code: 'BROKER_UNAVAILABLE', retryable: true },
            })
          : await outbox.deadLetter({
              ...identity,
              failedAt: '2026-07-23T08:00:05.000Z',
              failure: { code: 'UNROUTABLE_EVENT', retryable: false },
            })

      expect(result).toMatchObject({ ok: false, reason: 'lease_expired' })
      expect(client.calls.some(({ text }) => text.startsWith('update chatbi_query_outbox\nset status'))).toBe(false)
    },
  )

  it('rejects a business event timestamp outside the database clock window', async () => {
    const token = 'future_private_token'
    const tokenHash = createHash('sha256').update(token).digest('hex')
    const row = eventRow({
      status: 'leased',
      attempt: 1,
      fence: 2,
      lease_owner: 'publisher_1',
      lease_token_hash: tokenHash,
      lease_expires_at: leaseExpiresAt,
    })
    const client = new ScriptedClient(async (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return await empty()
      if (text === 'select * from chatbi_query_outbox where event_id = $1 for update') {
        return { rows: [row], rowCount: 1 }
      }
      if (text === 'select clock_timestamp() as db_now') {
        return { rows: [{ db_now: '2026-07-23T08:00:30.000Z' }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const outbox = createPostgresOutboxStore({ pool: new ScriptedPool(client) })

    await expect(outbox.ack({
      eventId: 'outbox_evt_1',
      attempt: 1,
      fence: 2,
      publisherId: 'publisher_1',
      leaseToken: token,
      publishedAt: '2026-07-23T09:00:00.000Z',
      publicationFingerprint: 'publication_sha256_future',
    })).rejects.toThrow('publishedAt is outside the allowed database clock window')
    expect(client.calls.some(({ text }) => text.startsWith('update chatbi_query_outbox\nset status'))).toBe(false)
  })

  it.each([
    {
      action: 'retry',
      failure: { code: 'BROKER_UNAVAILABLE', retryable: true } satisfies OutboxFailure,
      expectedStatus: 'retry_wait',
      expectedOutcome: 'retry_scheduled',
    },
    {
      action: 'deadLetter',
      failure: { code: 'UNROUTABLE_EVENT', retryable: false } satisfies OutboxFailure,
      expectedStatus: 'dead_lettered',
      expectedOutcome: 'dead_lettered',
    },
  ] as const)('$action applies fenced CAS and closes its durable attempt', async ({
    action,
    failure,
    expectedStatus,
    expectedOutcome,
  }) => {
    const token = 'mutation_private_token'
    const tokenHash = createHash('sha256').update(token).digest('hex')
    let row = eventRow({
      status: 'leased',
      attempt: 2,
      max_attempts: 5,
      fence: 9,
      lease_owner: 'publisher_1',
      lease_token_hash: tokenHash,
      lease_expires_at: leaseExpiresAt,
    })
    let attempt = attemptRow({ attempt: 2, fence: 9 })
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text === 'select clock_timestamp() as db_now') {
        return { rows: [{ db_now: '2026-07-23T08:00:30.000Z' }], rowCount: 1 }
      }
      if (text === 'select * from chatbi_query_outbox where event_id = $1 for update') {
        return { rows: [row], rowCount: 1 }
      }
      if (text.startsWith('select\n  attempt, fence')) return { rows: [attempt], rowCount: 1 }
      if (text === 'select * from chatbi_query_outbox where event_id = $1') {
        return { rows: [row], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_query_outbox\nset status = ')) {
        row = eventRow({
          ...row,
          status: expectedStatus,
          lease_owner: null,
          lease_token_hash: null,
          lease_expires_at: null,
          available_at: action === 'retry' ? values?.[5] : row.available_at,
          dead_lettered_at: action === 'deadLetter' ? values?.[5] : null,
          last_failure_json: failure,
          terminal_kind: expectedOutcome,
          terminal_attempt: 2,
          terminal_fence: 9,
          terminal_publisher_id: 'publisher_1',
          terminal_lease_token_hash: tokenHash,
          terminal_fingerprint: action === 'retry' ? values?.[7] : values?.[7],
        })
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_query_outbox_attempts')) {
        attempt = attemptRow({
          attempt: 2,
          fence: 9,
          ended_at: values?.[2],
          outcome: values?.[3],
          failure_json: failure,
        })
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const outbox = createPostgresOutboxStore({ pool: new ScriptedPool(client) })
    const lease = {
      eventId: 'outbox_evt_1',
      attempt: 2,
      fence: 9,
      publisherId: 'publisher_1',
      leaseToken: token,
    }
    const result = action === 'retry'
      ? await outbox.retry({
          ...lease,
          failedAt: '2026-07-23T08:00:30.000Z',
          availableAt: '2026-07-23T08:00:45.000Z',
          failure,
        })
      : await outbox.deadLetter({
          ...lease,
          failedAt: '2026-07-23T08:00:30.000Z',
          failure,
        })

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      message: {
        status: expectedStatus,
        attempts: [{ outcome: expectedOutcome, failure }],
      },
    })
    const mutation = client.calls.find(({ text }) => text.startsWith('update chatbi_query_outbox\nset status = '))!
    expect(mutation.text).toContain('attempt = $2')
    expect(mutation.text).toContain('fence = $3')
    expect(mutation.text).toContain('lease_token_hash = $5')
    expect(mutation.values?.[4]).toBe(tokenHash)
  })

  it('scopes direct reads by tenant, workspace and event ID', async () => {
    const client = new ScriptedClient(async (text, values) => {
      expect(text).toContain('tenant_id = $1 and workspace_id = $2 and event_id = $3')
      expect(values).toEqual(['tenant_1', 'workspace_1', 'outbox_evt_1'])
      return await empty()
    })
    const outbox = createPostgresOutboxStore({ pool: new ScriptedPool(client) })

    await expect(outbox.getMessage({
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      eventId: 'outbox_evt_1',
    })).resolves.toBeUndefined()
  })
})

describe('006 query outbox migration', () => {
  it('defines durable state, attempt history, claim indexes and the compose mount', () => {
    const sql = readFileSync(new URL('../../scripts/postgres/006-query-outbox.sql', import.meta.url), 'utf8')
    const compose = readFileSync(new URL('../../docker-compose.postgres.yml', import.meta.url), 'utf8')

    expect(sql).toContain('create table if not exists chatbi_query_outbox (')
    expect(sql).toContain('create table if not exists chatbi_query_outbox_attempts (')
    expect(sql).toContain(
      "check (status = any(array['pending', 'leased', 'retry_wait', 'published', 'dead_lettered']::text[]))",
    )
    expect(sql).toContain('chatbi_query_outbox_lease_shape_check')
    expect(sql).toContain('chatbi_query_outbox_available_time_check')
    expect(sql).toContain('chatbi_query_outbox_terminal_metadata_check')
    expect(sql).toContain('chatbi_query_outbox_claim_idx')
    expect(sql).toContain('chatbi_query_outbox_expired_lease_idx')
    expect(sql).toContain('unique (event_id, fence)')
    expect(sql).toContain('chatbi_query_outbox_attempts_scope_event_fk')
    expect(sql).toContain('chatbi_query_outbox_attempts_terminal_shape_check')
    expect(compose).toContain('006-query-outbox.sql:/docker-entrypoint-initdb.d/006-query-outbox.sql:ro')
  })
})

function leaseExpiredFailure(): OutboxFailure {
  return { code: 'LEASE_EXPIRED', retryable: true }
}
