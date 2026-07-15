import { describe, expect, it } from 'vitest'
import {
  createInMemoryResultPageStore,
  createInMemoryRunEventStore,
  type PublishResultManifestInput,
  type ResultPageStore,
  type RunEventStore,
  type StageResultPageInput,
} from '../persistence'

const scope = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  runId: 'run_result_store',
}

type PagePayload = { rows: Array<{ key: string; values: Record<string, string | number | boolean | null> }> }
type ManifestMetadata = { semanticVersion: string; columns: string[] }

function page(patch: Partial<StageResultPageInput<PagePayload>> = {}): StageResultPageInput<PagePayload> {
  return {
    ...scope,
    attempt: 1,
    pageIndex: 0,
    checksum: 'sha256:page-0',
    rowCount: 1,
    payload: { rows: [{ key: 'row-1', values: { revenue: 100, final: true, note: null } }] },
    stagedAt: '2026-07-15T10:00:00.000Z',
    ...patch,
  }
}

function manifest(patch: Partial<PublishResultManifestInput<ManifestMetadata>> = {}): PublishResultManifestInput<ManifestMetadata> {
  return {
    ...scope,
    attempt: 1,
    resultId: 'result_1',
    manifestChecksum: 'sha256:manifest-1',
    pageChecksums: ['sha256:page-0'],
    totalRows: 1,
    metadata: { semanticVersion: 'sales-semantic-2026.06.1', columns: ['revenue', 'final', 'note'] },
    publishedAt: '2026-07-15T10:00:01.000Z',
    ...patch,
  }
}

describe('in-memory result page store', () => {
  it('stages the same page checksum idempotently and rejects checksum conflicts or collisions', () => {
    const store = createInMemoryResultPageStore<PagePayload, ManifestMetadata>()
    const first = store.stagePage(page())
    const retry = store.stagePage(page({ stagedAt: '2026-07-15T10:00:02.000Z' }))
    const checksumConflict = store.stagePage(page({ checksum: 'sha256:different' }))
    const checksumCollision = store.stagePage(page({
      payload: { rows: [{ key: 'row-1', values: { revenue: 999 } }] },
    }))

    expect(first).toMatchObject({ ok: true, applied: true })
    expect(retry).toMatchObject({ ok: true, applied: false })
    expect(checksumConflict).toMatchObject({ ok: false, reason: 'checksum_conflict' })
    expect(checksumCollision).toMatchObject({ ok: false, reason: 'checksum_collision' })
  })

  it('keeps staged pages unreadable until a complete matching manifest is published', () => {
    const store = createInMemoryResultPageStore<PagePayload, ManifestMetadata>()
    store.stagePage(page())

    expect(store.getPage({ ...scope, pageIndex: 0 })).toBeUndefined()
    expect(store.publishManifest(manifest({ pageChecksums: ['sha256:wrong'] }))).toMatchObject({
      ok: false,
      reason: 'page_checksum_mismatch',
    })
    expect(store.publishManifest(manifest({ pageChecksums: ['sha256:page-0', 'sha256:missing'], totalRows: 2 }))).toMatchObject({
      ok: false,
      reason: 'missing_page',
    })
    expect(store.publishManifest(manifest({ totalRows: 2 }))).toMatchObject({
      ok: false,
      reason: 'row_count_mismatch',
    })

    const published = store.publishManifest(manifest())
    expect(published).toMatchObject({ ok: true, applied: true, manifest: { pageCount: 1 } })
    expect(store.getPage({ ...scope, pageIndex: 0 })).toMatchObject({
      resultId: 'result_1',
      manifestChecksum: 'sha256:manifest-1',
      checksum: 'sha256:page-0',
      payload: { rows: [{ values: { revenue: 100, final: true, note: null } }] },
    })
  })

  it('publishes a manifest idempotently but fences a different attempt or manifest', () => {
    const store = createInMemoryResultPageStore<PagePayload, ManifestMetadata>()
    store.stagePage(page())
    store.stagePage(page({ attempt: 2, checksum: 'sha256:attempt-2' }))
    expect(store.publishManifest(manifest())).toMatchObject({ ok: true, applied: true })
    expect(store.publishManifest(manifest({ publishedAt: '2026-07-15T10:00:03.000Z' }))).toMatchObject({
      ok: true,
      applied: false,
    })
    expect(store.publishManifest(manifest({
      attempt: 2,
      manifestChecksum: 'sha256:manifest-2',
      pageChecksums: ['sha256:attempt-2'],
    }))).toMatchObject({ ok: false, reason: 'publish_conflict' })
    expect(store.publishManifest(manifest({ metadata: { semanticVersion: 'changed', columns: [] } }))).toMatchObject({
      ok: false,
      reason: 'checksum_collision',
    })
  })

  it('enforces tenant and workspace scope and returns defensive copies', () => {
    const store = createInMemoryResultPageStore<PagePayload, ManifestMetadata>()
    store.stagePage(page())
    store.publishManifest(manifest())

    expect(store.getManifest({ ...scope, workspaceId: 'workspace_other' })).toBeUndefined()
    expect(store.getPage({ ...scope, tenantId: 'tenant_other', pageIndex: 0 })).toBeUndefined()

    const fetched = store.getPage({ ...scope, pageIndex: 0 })!
    fetched.payload.rows[0].values.revenue = 999
    expect(store.getPage({ ...scope, pageIndex: 0 })!.payload.rows[0].values.revenue).toBe(100)
  })
})

describe('in-memory run event store', () => {
  it('appends with sequence CAS and returns ordered events after a cursor', () => {
    const store = createInMemoryRunEventStore<{ type: string; value?: number }>()
    const first = store.append({
      ...scope,
      eventId: 'event-1',
      expectedSequence: 0,
      event: { type: 'query.started' },
      occurredAt: '2026-07-15T10:00:00.000Z',
    })
    const stale = store.append({
      ...scope,
      eventId: 'event-stale',
      expectedSequence: 0,
      event: { type: 'query.completed' },
      occurredAt: '2026-07-15T10:00:01.000Z',
    })
    const second = store.append({
      ...scope,
      eventId: 'event-2',
      expectedSequence: 1,
      event: { type: 'query.completed', value: 2 },
      occurredAt: '2026-07-15T10:00:01.000Z',
    })

    expect(first).toMatchObject({ ok: true, applied: true, stored: { sequence: 1 } })
    expect(stale).toEqual({ ok: false, reason: 'sequence_conflict', currentSequence: 1 })
    expect(second).toMatchObject({ ok: true, applied: true, stored: { sequence: 2 } })
    expect(store.currentSequence(scope)).toBe(2)
    expect(store.listAfter({ ...scope, afterSequence: 1 })).toEqual([
      expect.objectContaining({ eventId: 'event-2', sequence: 2 }),
    ])
  })

  it('makes identical event retries idempotent before CAS and rejects reused ids with changed content', () => {
    const store = createInMemoryRunEventStore<{ type: string }>()
    const input = {
      ...scope,
      eventId: 'event-idempotent',
      expectedSequence: 0,
      event: { type: 'query.started' },
      occurredAt: '2026-07-15T10:00:00.000Z',
    }
    expect(store.append(input)).toMatchObject({ ok: true, applied: true })
    expect(store.append(input)).toMatchObject({ ok: true, applied: false, stored: { sequence: 1 } })
    expect(store.append({ ...input, event: { type: 'query.cancelled' } })).toMatchObject({
      ok: false,
      reason: 'idempotency_conflict',
    })
    expect(store.currentSequence(scope)).toBe(1)
  })

  it('isolates streams by tenant/workspace and protects stored events from mutation', () => {
    const store = createInMemoryRunEventStore<{ type: string; nested: { value: number } }>()
    store.append({
      ...scope,
      eventId: 'event-scoped',
      expectedSequence: 0,
      event: { type: 'query.started', nested: { value: 1 } },
      occurredAt: '2026-07-15T10:00:00.000Z',
    })

    expect(store.listAfter({ ...scope, workspaceId: 'workspace_other', afterSequence: 0 })).toEqual([])
    expect(store.currentSequence({ ...scope, tenantId: 'tenant_other' })).toBe(0)
    const listed = store.listAfter({ ...scope, afterSequence: 0 })
    listed[0].event.nested.value = 99
    expect(store.listAfter({ ...scope, afterSequence: 0 })[0].event.nested.value).toBe(1)
  })
})

describe('async durable store contracts', () => {
  it('allows PostgreSQL-style asynchronous adapters while memory factories remain synchronous', async () => {
    const memoryPages = createInMemoryResultPageStore<PagePayload, ManifestMetadata>()
    const memoryEvents = createInMemoryRunEventStore<{ type: string }>()
    const durablePages: ResultPageStore<PagePayload, ManifestMetadata> = {
      async stagePage(input) {
        return memoryPages.stagePage(input)
      },
      async publishManifest(input) {
        return memoryPages.publishManifest(input)
      },
      async getManifest(input) {
        return memoryPages.getManifest(input)
      },
      async getPage(input) {
        return memoryPages.getPage(input)
      },
    }
    const durableEvents: RunEventStore<{ type: string }> = {
      async append(input) {
        return memoryEvents.append(input)
      },
      async listAfter(input) {
        return memoryEvents.listAfter(input)
      },
      async currentSequence(input) {
        return memoryEvents.currentSequence(input)
      },
    }

    await expect(durablePages.stagePage(page())).resolves.toMatchObject({ ok: true, applied: true })
    await expect(durablePages.publishManifest(manifest())).resolves.toMatchObject({ ok: true, applied: true })
    await expect(durablePages.getPage({ ...scope, pageIndex: 0 })).resolves.toMatchObject({ resultId: 'result_1' })

    await expect(durableEvents.append({
      ...scope,
      eventId: 'event-async',
      expectedSequence: 0,
      event: { type: 'query.started' },
      occurredAt: '2026-07-15T10:00:00.000Z',
    })).resolves.toMatchObject({ ok: true, applied: true, stored: { sequence: 1 } })
    await expect(durableEvents.listAfter({ ...scope, afterSequence: 0 })).resolves.toHaveLength(1)
    await expect(durableEvents.currentSequence(scope)).resolves.toBe(1)

    expect(memoryPages.getManifest(scope)).toMatchObject({ resultId: 'result_1' })
    expect(memoryEvents.currentSequence(scope)).toBe(1)
  })
})
