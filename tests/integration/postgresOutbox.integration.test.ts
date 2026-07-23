import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createPostgresOutboxStore } from '../../apps/api/src/adapters/postgresOutboxStore'
import type { OutboxMessageLease } from '../../src/persistence/outboxPorts'

interface Payload {
  schemaVersion: string
  type: string
  state: string
}

const databaseUrl = process.env.CHATBI_TEST_POSTGRES_ADMIN_URL
  ?? 'postgresql://chatbi_admin:chatbi_admin@127.0.0.1:55432/chatbi_test'
const testClockBase = Date.now() - 60_000
const t0 = new Date(testClockBase).toISOString()
const t1 = new Date(testClockBase + 1_000).toISOString()
const t2 = new Date(testClockBase + 2_000).toISOString()
const t3 = new Date(testClockBase + 3_000).toISOString()

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function leaseIdentity(lease: OutboxMessageLease<Payload>) {
  return {
    eventId: lease.eventId,
    attempt: lease.attempt,
    fence: lease.fence,
    publisherId: lease.publisherId,
    leaseToken: lease.leaseToken,
  }
}

describe('PostgreSQL durable outbox real integration', () => {
  let admin: Pool
  let poolA: Pool
  let poolB: Pool
  let storeA: ReturnType<typeof createPostgresOutboxStore<Payload>>
  let storeB: ReturnType<typeof createPostgresOutboxStore<Payload>>
  const createdEventIds = new Set<string>()

  function eventId(label: string) {
    const id = `outbox_it_${label}_${randomUUID().replaceAll('-', '')}`
    createdEventIds.add(id)
    return id
  }

  function enqueueInput(
    id: string,
    patch: Partial<Parameters<typeof storeA.enqueue>[0]> = {},
  ): Parameters<typeof storeA.enqueue>[0] {
    return {
      eventId: id,
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      aggregateType: 'query_run',
      aggregateId: `run_${id}`,
      topic: 'query.run.submitted.v1',
      payload: {
        schemaVersion: 'query_control_plane.v1',
        type: 'query.run.submitted',
        state: 'querying',
      },
      occurredAt: t0,
      maxAttempts: 4,
      ...patch,
    }
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 })
    poolA = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    poolB = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    await admin.query(readFileSync(new URL('../../scripts/postgres/006-query-outbox.sql', import.meta.url), 'utf8'))
    storeA = createPostgresOutboxStore<Payload>({ pool: poolA })
    storeB = createPostgresOutboxStore<Payload>({ pool: poolB })
  })

  afterEach(async () => {
    const ids = [...createdEventIds]
    createdEventIds.clear()
    if (ids.length > 0) {
      await admin.query('delete from chatbi_query_outbox where event_id = any($1::text[])', [ids])
    }
  })

  afterAll(async () => {
    await storeA?.close()
    await storeB?.close()
    await Promise.all([admin?.end(), poolA?.end(), poolB?.end()])
  })

  it('keeps an identical event idempotent and rejects changed content', async () => {
    const id = eventId('idempotency')
    const input = enqueueInput(id)

    await expect(storeA.enqueue(input)).resolves.toMatchObject({ ok: true, created: true })
    await expect(storeB.enqueue(structuredClone(input))).resolves.toMatchObject({ ok: true, created: false })
    await expect(storeB.enqueue({
      ...input,
      payload: { ...input.payload, state: 'completed' },
    })).resolves.toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
      message: { eventId: id, status: 'pending' },
    })

    const count = await admin.query<{ count: string }>(
      'select count(*)::text as count from chatbi_query_outbox where event_id = $1',
      [id],
    )
    expect(count.rows).toEqual([{ count: '1' }])
  })

  it('allows exactly one of two publishers to claim the same event concurrently', async () => {
    const id = eventId('concurrent_claim')
    await storeA.enqueue(enqueueInput(id))

    const [first, second] = await Promise.all([
      storeA.claimNext({
        eventId: id,
        publisherId: 'publisher_a',
        now: '1900-01-01T00:00:00.000Z',
        leaseMs: 5_000,
      }),
      storeB.claimNext({
        eventId: id,
        publisherId: 'publisher_b',
        now: '2099-01-01T00:00:00.000Z',
        leaseMs: 5_000,
      }),
    ])

    const claims = [first, second].filter((value): value is OutboxMessageLease<Payload> => Boolean(value))
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({ eventId: id, attempt: 1, fence: 1 })
    const attempts = await admin.query<{ count: string }>(
      'select count(*)::text as count from chatbi_query_outbox_attempts where event_id = $1',
      [id],
    )
    expect(attempts.rows).toEqual([{ count: '1' }])
  })

  it('reclaims an expired lease and rejects the old publisher fence', async () => {
    const id = eventId('reclaim')
    await storeA.enqueue(enqueueInput(id))
    const oldLease = (await storeA.claimNext({
      eventId: id,
      publisherId: 'publisher_old',
      now: '1900-01-01T00:00:00.000Z',
      leaseMs: 250,
    }))!
    await expect(storeB.claimNext({
      eventId: id,
      publisherId: 'publisher_too_early',
      now: '2099-01-01T00:00:00.000Z',
      leaseMs: 5_000,
    })).resolves.toBeUndefined()
    await sleep(400)
    await expect(storeA.ack({
      ...leaseIdentity(oldLease),
      publishedAt: t1,
      publicationFingerprint: 'sha256:obsolete_publication',
    })).resolves.toMatchObject({ ok: false, reason: 'lease_expired' })
    const currentLease = (await storeB.claimNext({
      eventId: id,
      publisherId: 'publisher_current',
      now: '1900-01-01T00:00:00.000Z',
      leaseMs: 5_000,
    }))!

    expect(currentLease).toMatchObject({ eventId: id, attempt: 2, fence: 2 })
    expect(currentLease.leaseToken).not.toBe(oldLease.leaseToken)
    await expect(storeB.ack({
      ...leaseIdentity(currentLease),
      publishedAt: t2,
      publicationFingerprint: 'sha256:current_publication',
    })).resolves.toMatchObject({ ok: true, applied: true })

    await expect(storeA.getMessage({
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      eventId: id,
    })).resolves.toMatchObject({
      status: 'published',
      attempt: 2,
      fence: 2,
      publicationFingerprint: 'sha256:current_publication',
      attempts: [
        { attempt: 1, fence: 1, publisherId: 'publisher_old', outcome: 'lease_expired' },
        { attempt: 2, fence: 2, publisherId: 'publisher_current', outcome: 'published' },
      ],
    })
  })

  it('can claim a scheduled retry after recreating the store', async () => {
    const id = eventId('restart_retry')
    await storeA.enqueue(enqueueInput(id))
    const first = (await storeA.claimNext({
      eventId: id,
      publisherId: 'publisher_before_restart',
      now: t0,
      leaseMs: 5_000,
    }))!
    const failedAt = new Date().toISOString()
    const availableAt = new Date(Date.now() + 350).toISOString()
    await expect(storeA.retry({
      ...leaseIdentity(first),
      failedAt,
      availableAt,
      failure: { code: 'HTTP_UNAVAILABLE', retryable: true },
    })).resolves.toMatchObject({ ok: true, applied: true, message: { status: 'retry_wait' } })

    await storeA.close()
    const restartedPool = new Pool({
      connectionString: databaseUrl,
      max: 2,
      connectionTimeoutMillis: 2_000,
    })
    const restartedStore = createPostgresOutboxStore<Payload>({ pool: restartedPool })
    try {
      await expect(restartedStore.claimNext({
        eventId: id,
        publisherId: 'publisher_after_restart',
        now: '2099-01-01T00:00:00.000Z',
        leaseMs: 5_000,
      })).resolves.toBeUndefined()
      await sleep(500)
      const second = (await restartedStore.claimNext({
        eventId: id,
        publisherId: 'publisher_after_restart',
        now: '1900-01-01T00:00:00.000Z',
        leaseMs: 5_000,
      }))!
      expect(second).toMatchObject({ eventId: id, attempt: 2, fence: 2 })
      await expect(restartedStore.ack({
        ...leaseIdentity(second),
        publishedAt: t3,
        publicationFingerprint: 'sha256:after_restart',
      })).resolves.toMatchObject({ ok: true, applied: true })
    } finally {
      await restartedStore.close()
      await restartedPool.end()
    }
  })

  it('persists ack, dead-letter state, and complete attempt history across adapters', async () => {
    const publishedId = eventId('published_history')
    const deadLetterId = eventId('dead_history')
    await storeA.enqueue(enqueueInput(publishedId))
    await storeA.enqueue(enqueueInput(deadLetterId))
    const publishedLease = (await storeA.claimNext({
      eventId: publishedId,
      publisherId: 'publisher_success',
      now: t0,
      leaseMs: 5_000,
    }))!
    const deadLetterLease = (await storeA.claimNext({
      eventId: deadLetterId,
      publisherId: 'publisher_rejected',
      now: t0,
      leaseMs: 5_000,
    }))!

    await storeA.ack({
      ...leaseIdentity(publishedLease),
      publishedAt: t1,
      publicationFingerprint: 'sha256:persisted_success',
    })
    await storeA.deadLetter({
      ...leaseIdentity(deadLetterLease),
      failedAt: t1,
      failure: { code: 'HTTP_REJECTED', retryable: false },
    })

    await expect(storeB.getMessage({
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      eventId: publishedId,
    })).resolves.toMatchObject({
      status: 'published',
      publishedAt: t1,
      publicationFingerprint: 'sha256:persisted_success',
      attempts: [{ attempt: 1, fence: 1, publisherId: 'publisher_success', outcome: 'published' }],
    })
    await expect(storeB.getMessage({
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      eventId: deadLetterId,
    })).resolves.toMatchObject({
      status: 'dead_lettered',
      deadLetteredAt: t1,
      lastFailure: { code: 'HTTP_REJECTED', retryable: false },
      attempts: [{
        attempt: 1,
        fence: 1,
        publisherId: 'publisher_rejected',
        outcome: 'dead_lettered',
        failure: { code: 'HTTP_REJECTED', retryable: false },
      }],
    })
  })

  it('does not expose an event through a different tenant or workspace scope', async () => {
    const id = eventId('scope')
    await storeA.enqueue(enqueueInput(id))

    await expect(storeB.getMessage({
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      eventId: id,
    })).resolves.toMatchObject({ eventId: id, tenantId: 'tenant_demo', workspaceId: 'workspace_sales' })
    await expect(storeB.getMessage({
      tenantId: 'tenant_other',
      workspaceId: 'workspace_sales',
      eventId: id,
    })).resolves.toBeUndefined()
    await expect(storeB.getMessage({
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_other',
      eventId: id,
    })).resolves.toBeUndefined()
  })
})
