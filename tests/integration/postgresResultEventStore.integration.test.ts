import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  createPostgresResultPageStore,
  createPostgresRunEventStore,
} from '../../apps/api/src/adapters/postgresResultEventStore'

const databaseUrl = process.env.CHATBI_TEST_POSTGRES_ADMIN_URL
  ?? 'postgresql://chatbi_admin:chatbi_admin@127.0.0.1:55432/chatbi_test'
const scope = { tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: 'run_result_event_integration' }
const at = '2026-07-15T10:00:00.000Z'

interface PagePayload { rows: Array<{ key: string; values: Record<string, string | number> }> }
interface Metadata { semanticVersion: string }
interface Event { type: string; detail?: string }

describe('PostgreSQL durable ResultPageStore and RunEventStore real integration', () => {
  let admin: Pool
  let poolA: Pool
  let poolB: Pool
  let resultsA: ReturnType<typeof createPostgresResultPageStore<PagePayload, Metadata>>
  let resultsB: ReturnType<typeof createPostgresResultPageStore<PagePayload, Metadata>>
  let eventsA: ReturnType<typeof createPostgresRunEventStore<Event>>
  let eventsB: ReturnType<typeof createPostgresRunEventStore<Event>>

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 })
    poolA = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    poolB = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    const migration = readFileSync(new URL('../../scripts/postgres/result-event-store.sql', import.meta.url), 'utf8')
    await admin.query(migration)
    resultsA = createPostgresResultPageStore<PagePayload, Metadata>({ pool: poolA })
    resultsB = createPostgresResultPageStore<PagePayload, Metadata>({ pool: poolB })
    eventsA = createPostgresRunEventStore<Event>({ pool: poolA })
    eventsB = createPostgresRunEventStore<Event>({ pool: poolB })
  })

  beforeEach(async () => {
    await admin.query(`truncate table
      chatbi_run_events,
      chatbi_run_event_streams,
      chatbi_result_manifests,
      chatbi_result_pages`)
  })

  afterAll(async () => {
    await Promise.all([resultsA?.close(), resultsB?.close(), eventsA?.close(), eventsB?.close()])
    await Promise.all([admin?.end(), poolA?.end(), poolB?.end()])
  })

  it('stages across one adapter, atomically publishes in another and exposes only the scoped published page', async () => {
    const staged = {
      ...scope,
      attempt: 1,
      pageIndex: 0,
      checksum: 'sha256:page-0',
      rowCount: 1,
      payload: { rows: [{ key: 'r1', values: { revenue: 100 } }] },
      stagedAt: at,
    }
    expect(await resultsA.stagePage(staged)).toMatchObject({ ok: true, applied: true })
    expect(await resultsB.stagePage(staged)).toMatchObject({ ok: true, applied: false })
    expect(await resultsB.getPage({ ...scope, pageIndex: 0 })).toBeUndefined()

    expect(await resultsB.publishManifest({
      ...scope,
      attempt: 1,
      resultId: 'result_pg_real',
      manifestChecksum: 'sha256:manifest',
      pageChecksums: ['sha256:page-0'],
      totalRows: 1,
      metadata: { semanticVersion: 'v1' },
      publishedAt: at,
    })).toMatchObject({ ok: true, applied: true })
    expect(await resultsA.getPage({ ...scope, pageIndex: 0 })).toMatchObject({
      resultId: 'result_pg_real', payload: staged.payload,
    })
    expect(await resultsA.getPage({ ...scope, tenantId: 'tenant_other', pageIndex: 0 })).toBeUndefined()
    expect(await resultsA.publishManifest({
      ...scope,
      attempt: 1,
      resultId: 'result_pg_real',
      manifestChecksum: 'sha256:manifest',
      pageChecksums: ['sha256:page-0'],
      totalRows: 1,
      metadata: { semanticVersion: 'v1' },
      publishedAt: '2026-07-15T10:00:01.000Z',
    })).toMatchObject({ ok: true, applied: false })
    expect(await resultsA.stagePage({ ...staged, checksum: 'sha256:different' })).toMatchObject({
      ok: false, reason: 'checksum_conflict',
    })
  })

  it('rejects incomplete manifests and keeps a published manifest immutable', async () => {
    expect(await resultsA.publishManifest({
      ...scope,
      attempt: 1,
      resultId: 'result_missing',
      manifestChecksum: 'sha256:missing',
      pageChecksums: ['sha256:not-staged'],
      totalRows: 1,
      metadata: { semanticVersion: 'v1' },
      publishedAt: at,
    })).toMatchObject({ ok: false, reason: 'missing_page' })

    await resultsA.stagePage({
      ...scope, attempt: 1, pageIndex: 0, checksum: 'sha256:page-0', rowCount: 0,
      payload: { rows: [] }, stagedAt: at,
    })
    await resultsA.publishManifest({
      ...scope, attempt: 1, resultId: 'result_immutable', manifestChecksum: 'sha256:manifest',
      pageChecksums: ['sha256:page-0'], totalRows: 0, metadata: { semanticVersion: 'v1' }, publishedAt: at,
    })
    const error = await admin.query(`update chatbi_result_manifests set total_rows = 99
where tenant_id = $1 and workspace_id = $2 and run_id = $3`, [scope.tenantId, scope.workspaceId, scope.runId])
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: '55000' })
    const pageUpdateError = await admin.query(`update chatbi_result_pages set checksum = 'mutated'
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and attempt = 1 and page_index = 0`, [
      scope.tenantId, scope.workspaceId, scope.runId,
    ]).catch((caught: unknown) => caught)
    expect(pageUpdateError).toMatchObject({ code: '55000' })
    const pageDeleteError = await admin.query(`delete from chatbi_result_pages
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and attempt = 1 and page_index = 0`, [
      scope.tenantId, scope.workspaceId, scope.runId,
    ]).catch((caught: unknown) => caught)
    expect(pageDeleteError).toMatchObject({ code: '55000' })
    expect(await resultsB.getManifest(scope)).toMatchObject({ totalRows: 0, manifestChecksum: 'sha256:manifest' })
    expect(await resultsB.getPage({ ...scope, pageIndex: 0 })).toMatchObject({ checksum: 'sha256:page-0' })
  })

  it('enforces event idempotency and sequence CAS across two adapter instances with ordered cursor reads', async () => {
    const first = {
      ...scope,
      eventId: 'event-1',
      expectedSequence: 0,
      event: { type: 'query.started' },
      occurredAt: at,
    }
    expect(await eventsA.append(first)).toMatchObject({ ok: true, applied: true, stored: { sequence: 1 } })
    expect(await eventsB.append(first)).toMatchObject({ ok: true, applied: false, stored: { sequence: 1 } })
    expect(await eventsB.append({ ...first, event: { type: 'query.cancelled' } })).toMatchObject({
      ok: false, reason: 'idempotency_conflict',
    })

    const competing = await Promise.all([
      eventsA.append({
        ...scope, eventId: 'event-2a', expectedSequence: 1,
        event: { type: 'query.completed', detail: 'a' }, occurredAt: '2026-07-15T10:00:01.000Z',
      }),
      eventsB.append({
        ...scope, eventId: 'event-2b', expectedSequence: 1,
        event: { type: 'query.completed', detail: 'b' }, occurredAt: '2026-07-15T10:00:01.000Z',
      }),
    ])
    expect(competing.filter((result) => result.ok)).toHaveLength(1)
    expect(competing.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason: 'sequence_conflict', currentSequence: 2 }),
    ])
    expect(await eventsA.currentSequence(scope)).toBe(2)
    const afterFirst = await eventsB.listAfter({ ...scope, afterSequence: 1 })
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].sequence).toBe(2)
    expect(await eventsB.listAfter({ ...scope, workspaceId: 'workspace_other', afterSequence: 0 })).toEqual([])
  })
})
