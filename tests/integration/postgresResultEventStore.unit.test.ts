import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createPostgresResultPageStore,
  createPostgresRunEventStore,
  type PostgresResultEventClientLike,
  type PostgresResultEventPoolLike,
} from '../../apps/api/src/adapters/postgresResultEventStore'

interface Call { text: string; values?: readonly unknown[] }

class ScriptedClient implements PostgresResultEventClientLike {
  readonly calls: Call[] = []
  released = false
  releaseError: Error | boolean | undefined

  constructor(private readonly handler: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return await this.handler(text, values) as { rows: Row[]; rowCount: number | null }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseError = error
  }
}

class ScriptedPool implements PostgresResultEventPoolLike {
  readonly directCalls: Call[] = []
  constructor(readonly client: ScriptedClient, private readonly directHandler = async () => ({ rows: [], rowCount: 0 })) {}
  async connect() { return this.client }
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.directCalls.push({ text, values })
    return await this.directHandler(text, values) as { rows: Row[]; rowCount: number | null }
  }
}

const scope = { tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: 'run_pg_store' }
const at = '2026-07-15T10:00:00.000Z'

function pageRow(patch: Record<string, unknown> = {}) {
  return {
    tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId,
    run_id: scope.runId,
    attempt: 1,
    page_index: 0,
    checksum: 'sha256:page-0',
    content_fingerprint: 'stored-fingerprint',
    row_count: 1,
    payload_json: { rows: [{ key: 'r1', values: { revenue: 100 } }] },
    staged_at: at,
    ...patch,
  }
}

function manifestRow(patch: Record<string, unknown> = {}) {
  return {
    tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId,
    run_id: scope.runId,
    attempt: 1,
    result_id: 'result_pg',
    manifest_checksum: 'sha256:manifest',
    content_fingerprint: 'manifest-fingerprint',
    page_checksums: ['sha256:page-0'],
    page_count: 1,
    total_rows: 1,
    metadata_json: { semanticVersion: 'v1' },
    published_at: at,
    ...patch,
  }
}

function eventRow(patch: Record<string, unknown> = {}) {
  return {
    tenant_id: scope.tenantId,
    workspace_id: scope.workspaceId,
    run_id: scope.runId,
    sequence: 1,
    idempotency_key: 'event-1',
    content_fingerprint: 'event-fingerprint',
    event_json: { type: 'query.started' },
    occurred_at: at,
    ...patch,
  }
}

function empty() { return Promise.resolve({ rows: [], rowCount: 0 }) }

describe('PostgreSQL ResultPageStore and RunEventStore unit boundary', () => {
  it('ships scoped immutable result and CAS event tables', () => {
    const sql = readFileSync(new URL('../../scripts/postgres/result-event-store.sql', import.meta.url), 'utf8')
    expect(sql).toContain('create table if not exists chatbi_result_pages')
    expect(sql).toContain('primary key (tenant_id, workspace_id, run_id, attempt, page_index)')
    expect(sql).toContain('chatbi_result_manifests_immutable')
    expect(sql).toContain('chatbi_result_pages_published_immutable')
    expect(sql).toContain("raise exception 'published result pages are immutable' using errcode = '55000'")
    expect(sql).toContain('create table if not exists chatbi_run_event_streams')
    expect(sql).toContain('unique (tenant_id, workspace_id, run_id, idempotency_key)')
  })

  it('stages JSON through parameters in one transaction and releases its client', async () => {
    const client = new ScriptedClient(async (text, values) => {
      if (text.startsWith('insert into chatbi_result_pages')) {
        return { rows: [pageRow({ content_fingerprint: values?.[6], payload_json: values?.[8] })], rowCount: 1 }
      }
      return empty()
    })
    const store = createPostgresResultPageStore<{ rows: unknown[] }>({ pool: new ScriptedPool(client) })
    const payload = { rows: [{ key: 'r1', values: { revenue: 100 } }] }

    await expect(store.stagePage({
      ...scope, attempt: 1, pageIndex: 0, checksum: 'sha256:page-0', rowCount: 1, payload, stagedAt: at,
    })).resolves.toMatchObject({ ok: true, applied: true, page: { payload } })

    const insert = client.calls.find((call) => call.text.startsWith('insert into chatbi_result_pages'))!
    expect(insert.text).not.toContain('tenant_demo')
    expect(insert.text).not.toContain('revenue')
    expect(insert.values?.slice(0, 6)).toEqual([
      scope.tenantId, scope.workspaceId, scope.runId, 1, 0, 'sha256:page-0',
    ])
    expect(client.calls.map((call) => call.text)).toEqual([
      'BEGIN', insert.text, 'COMMIT',
    ])
    expect(client.released).toBe(true)
  })

  it('returns checksum conflict or collision from the scoped stored page without overwriting it', async () => {
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_result_pages')) return empty()
      if (text.startsWith('select * from chatbi_result_pages')) return { rows: [pageRow()], rowCount: 1 }
      return empty()
    })
    const store = createPostgresResultPageStore({ pool: new ScriptedPool(client) })

    const result = await store.stagePage({
      ...scope, attempt: 1, pageIndex: 0, checksum: 'sha256:different', rowCount: 1,
      payload: { rows: [] }, stagedAt: at,
    })

    expect(result).toMatchObject({ ok: false, reason: 'checksum_conflict', page: { checksum: 'sha256:page-0' } })
    await expect(store.stagePage({
      ...scope, attempt: 1, pageIndex: 0, checksum: 'sha256:page-0', rowCount: 1,
      payload: { rows: [{ changed: true }] }, stagedAt: at,
    })).resolves.toMatchObject({ ok: false, reason: 'checksum_collision' })
    const lookup = client.calls.find((call) => call.text.startsWith('select * from chatbi_result_pages'))!
    expect(lookup.values).toEqual([scope.tenantId, scope.workspaceId, scope.runId, 1, 0])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('validates every staged page before parameterized atomic manifest publication', async () => {
    const client = new ScriptedClient(async (text, values) => {
      if (text.includes('from chatbi_result_manifests') && text.endsWith('for update')) return empty()
      if (text.startsWith('select * from chatbi_result_pages')) {
        return { rows: [pageRow(), pageRow({ page_index: 1, checksum: 'sha256:page-1', row_count: 2 })], rowCount: 2 }
      }
      if (text.startsWith('insert into chatbi_result_manifests')) {
        return { rows: [manifestRow({
          content_fingerprint: values?.[6],
          page_checksums: values?.[7],
          page_count: values?.[8],
          total_rows: values?.[9],
          metadata_json: values?.[10],
        })], rowCount: 1 }
      }
      return empty()
    })
    const store = createPostgresResultPageStore({ pool: new ScriptedPool(client) })

    const result = await store.publishManifest({
      ...scope,
      attempt: 1,
      resultId: 'result_pg',
      manifestChecksum: 'sha256:manifest',
      pageChecksums: ['sha256:page-0', 'sha256:page-1'],
      totalRows: 3,
      metadata: { semanticVersion: 'v1' },
      publishedAt: at,
    })

    expect(result).toMatchObject({ ok: true, applied: true, manifest: { pageCount: 2, totalRows: 3 } })
    const pages = client.calls.find((call) => call.text.startsWith('select * from chatbi_result_pages'))!
    expect(pages.text.toLowerCase()).toContain('order by page_index asc for share')
    expect(pages.values).toEqual([scope.tenantId, scope.workspaceId, scope.runId, 1])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('rolls back and releases when manifest validation raises a database error', async () => {
    const raw = new Error('database failure')
    const client = new ScriptedClient(async (text) => {
      if (text.includes('from chatbi_result_manifests')) return empty()
      if (text.startsWith('select * from chatbi_result_pages')) throw raw
      return empty()
    })
    const store = createPostgresResultPageStore({ pool: new ScriptedPool(client) })

    await expect(store.publishManifest({
      ...scope, attempt: 1, resultId: 'result_pg', manifestChecksum: 'sha256:manifest',
      pageChecksums: [], totalRows: 0, metadata: {}, publishedAt: at,
    })).rejects.toBe(raw)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('reads only a published scoped page using a parameterized page cursor', async () => {
    const client = new ScriptedClient(async () => empty())
    const pool = new ScriptedPool(client, async () => ({
      rows: [{ ...pageRow(), result_id: 'result_pg', manifest_checksum: 'sha256:manifest', published_at: at }],
      rowCount: 1,
    }))
    const store = createPostgresResultPageStore({ pool })

    await expect(store.getPage({ ...scope, pageIndex: 0 })).resolves.toMatchObject({
      resultId: 'result_pg', pageIndex: 0, checksum: 'sha256:page-0',
    })
    expect(pool.directCalls[0].text).toContain('join chatbi_result_pages')
    expect(pool.directCalls[0].values).toEqual([scope.tenantId, scope.workspaceId, scope.runId, 0])
  })

  it('appends an event with sequence CAS and lists after a parameterized cursor', async () => {
    const client = new ScriptedClient(async (text, values) => {
      if (text.startsWith('select current_sequence')) return { rows: [{ current_sequence: 0 }], rowCount: 1 }
      if (text.startsWith('select * from chatbi_run_events')) return empty()
      if (text.startsWith('update chatbi_run_event_streams')) return { rows: [], rowCount: 1 }
      if (text.startsWith('insert into chatbi_run_events')) {
        return { rows: [eventRow({ content_fingerprint: values?.[5], event_json: values?.[6] })], rowCount: 1 }
      }
      return empty()
    })
    const pool = new ScriptedPool(client, async () => ({ rows: [eventRow()], rowCount: 1 }))
    const store = createPostgresRunEventStore<{ type: string }>({ pool })

    await expect(store.append({
      ...scope, eventId: 'event-1', expectedSequence: 0,
      event: { type: 'query.started' }, occurredAt: at,
    })).resolves.toMatchObject({ ok: true, applied: true, stored: { sequence: 1 } })
    const advance = client.calls.find((call) => call.text.startsWith('update chatbi_run_event_streams'))!
    expect(advance.text).toContain('current_sequence = $6')
    expect(advance.values).toEqual([scope.tenantId, scope.workspaceId, scope.runId, 1, at, 0])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')

    await expect(store.listAfter({ ...scope, afterSequence: 0, limit: 10 })).resolves.toHaveLength(1)
    expect(pool.directCalls[0].values).toEqual([scope.tenantId, scope.workspaceId, scope.runId, 0, 10])
  })
})
