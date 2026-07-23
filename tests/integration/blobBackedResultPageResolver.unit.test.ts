import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  BlobBackedResultPageResolverError,
  createBlobBackedResultPageResolver,
} from '../../apps/api/src/adapters/blobBackedResultPageResolver'
import type {
  TransactionalResultManifestMetadata,
  TransactionalResultPage,
  TransactionalStoredResultPage,
} from '../../apps/api/src/transactionalQueryExecutionCoordinator'
import {
  buildImmutableResultBlobKey,
  type ImmutableResultBlob,
  type ImmutableResultBlobStore,
  type ResultBlobDescriptor,
} from '../../src/persistence/resultBlobPorts'
import type {
  PublishedResultManifest,
  PublishedResultPage,
  ResultPageStore,
} from '../../src/persistence/resultPorts'

const scope = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  runId: 'run_stream_blob',
}
const contentType = 'application/vnd.insightflow.result-page+json'
const publishedAt = '2026-07-23T12:00:00.000Z'
const logicalChecksum = `sha256:${'1'.repeat(64)}`
const columns = [{ id: 'month', label: '月份', type: 'string' as const }]
const payload: TransactionalResultPage = {
  columns,
  rows: [{ key: '2026-07', values: { month: '2026-07' } }],
}

function stableStringify(value: unknown) {
  const stable = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(stable)
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stable(nested)]))
    }
    return item
  }
  return JSON.stringify(stable(value))
}

function checksum(body: Uint8Array) {
  return `sha256:${createHash('sha256').update(body).digest('hex')}` as const
}

function metadata(
  storage: 'inline' | 's3',
): TransactionalResultManifestMetadata {
  return {
    schemaVersion: storage === 's3' ? 'chatbi_result_manifest.v2' : 'chatbi_result_manifest.v1',
    pageSize: 100,
    columns,
    chartSpec: {} as TransactionalResultManifestMetadata['chartSpec'],
    completeness: 'full',
    incompleteSteps: [],
    warnings: [],
    freshnessAt: publishedAt,
    semanticVersion: 'sales-semantic-v1',
    ...(storage === 's3' ? {
      pageStorage: {
        type: 's3',
        encoding: 'canonical-json',
        contentType,
      },
    } : {}),
  }
}

function manifest(
  storage: 'inline' | 's3' = 's3',
  patch: Partial<PublishedResultManifest<TransactionalResultManifestMetadata>> = {},
): PublishedResultManifest<TransactionalResultManifestMetadata> {
  return {
    ...scope,
    attempt: 1,
    resultId: 'result_stream_blob',
    manifestChecksum: `sha256:${'2'.repeat(64)}`,
    pageChecksums: [logicalChecksum],
    pageCount: 1,
    totalRows: 1,
    metadata: metadata(storage),
    publishedAt,
    ...patch,
  }
}

function blobForBody(
  body: Uint8Array,
  patch: Partial<ImmutableResultBlob> = {},
): ImmutableResultBlob {
  const descriptor: ResultBlobDescriptor = {
    ...scope,
    attempt: 1,
    kind: 'page',
    checksum: checksum(body),
    byteLength: body.byteLength,
    contentType,
  }
  return {
    ...descriptor,
    key: buildImmutableResultBlobKey(descriptor),
    etag: '"blob-etag-v1"',
    cacheControl: 'private, max-age=31536000, immutable',
    ...patch,
  }
}

function s3Page(
  body: Uint8Array,
  blobPatch: Partial<ImmutableResultBlob> = {},
  pagePatch: Partial<PublishedResultPage<TransactionalStoredResultPage>> = {},
): PublishedResultPage<TransactionalStoredResultPage> {
  return {
    ...scope,
    attempt: 1,
    pageIndex: 0,
    checksum: logicalChecksum,
    rowCount: 1,
    payload: {
      schemaVersion: 'chatbi_result_page_blob_reference.v1',
      storage: 's3',
      blob: blobForBody(body, blobPatch),
    },
    stagedAt: publishedAt,
    resultId: 'result_stream_blob',
    manifestChecksum: `sha256:${'2'.repeat(64)}`,
    publishedAt,
    ...pagePatch,
  }
}

function inlinePage(): PublishedResultPage<TransactionalStoredResultPage> {
  return {
    ...scope,
    attempt: 1,
    pageIndex: 0,
    checksum: logicalChecksum,
    rowCount: 1,
    payload,
    stagedAt: publishedAt,
    resultId: 'result_stream_blob',
    manifestChecksum: `sha256:${'2'.repeat(64)}`,
    publishedAt,
  }
}

function harness(options: {
  page?: PublishedResultPage<TransactionalStoredResultPage>
  body?: Uint8Array
  loadedBlob?: ImmutableResultBlob
  missing?: boolean
}) {
  const calls: string[] = []
  const getPage = vi.fn(async () => {
    calls.push('published-page')
    return options.page
  })
  const get = vi.fn(async () => {
    calls.push('blob-get')
    if (options.missing) return undefined
    const reference = (options.page?.payload as { blob?: ImmutableResultBlob })?.blob
    if (!reference || !options.body) throw new Error('private fake misconfiguration')
    return {
      blob: options.loadedBlob ?? reference,
      body: options.body,
    }
  })
  const resultPageStore = {
    getPage,
  } as unknown as ResultPageStore<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >
  const blobStore = { get } as unknown as ImmutableResultBlobStore
  return {
    resolver: createBlobBackedResultPageResolver({ resultPageStore, blobStore }),
    getPage,
    get,
    calls,
  }
}

function resolveInput(
  publishedManifest = manifest(),
  patch: Partial<{
    tenantId: string
    workspaceId: string
    runId: string
    pageIndex: number
  }> = {},
) {
  return {
    ...scope,
    pageIndex: 0,
    manifest: publishedManifest,
    ...patch,
  }
}

async function expectSafeFailure(operation: Promise<unknown>) {
  const error = await operation.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(BlobBackedResultPageResolverError)
  expect(error).toMatchObject({ code: 'RESULT_PAGE_UNAVAILABLE' })
  expect(JSON.stringify(error)).not.toMatch(/secret|bucket|endpoint|private-db/i)
}

describe('blob-backed published result page resolver', () => {
  it('loads the published descriptor first and hydrates a verified canonical S3 page', async () => {
    const body = new TextEncoder().encode(stableStringify(payload))
    const page = s3Page(body)
    const test = harness({ page, body })

    await expect(test.resolver.resolve(resolveInput())).resolves.toEqual({
      ...page,
      payload,
    })
    expect(test.calls).toEqual(['published-page', 'blob-get'])
    expect(test.getPage).toHaveBeenCalledWith({
      ...scope,
      pageIndex: 0,
      signal: undefined,
      timeoutMs: undefined,
    })
    const blob = blobForBody(body)
    expect(test.get).toHaveBeenCalledWith({
      tenantId: blob.tenantId,
      workspaceId: blob.workspaceId,
      runId: blob.runId,
      attempt: blob.attempt,
      kind: blob.kind,
      checksum: blob.checksum,
      byteLength: blob.byteLength,
      contentType: blob.contentType,
      signal: undefined,
      timeoutMs: undefined,
    })
  })

  it('returns an inline v1 published page without contacting blob storage', async () => {
    const page = inlinePage()
    const test = harness({ page })

    await expect(test.resolver.resolve(resolveInput(manifest('inline')))).resolves.toEqual(page)
    expect(test.calls).toEqual(['published-page'])
    expect(test.get).not.toHaveBeenCalled()
  })

  it.each([
    ['v1 external reference', manifest('inline')],
    ['v2 without pageStorage', manifest('s3', {
      metadata: { ...metadata('s3'), pageStorage: undefined },
    })],
    ['v2 inline pageStorage', manifest('s3', {
      metadata: {
        ...metadata('s3'),
        pageStorage: {
          type: 'inline',
          encoding: 'canonical-json',
          contentType,
        },
      },
    })],
  ])('rejects %s before contacting blob storage', async (_label, publishedManifest) => {
    const body = new TextEncoder().encode(stableStringify(payload))
    const test = harness({ page: s3Page(body), body })

    await expectSafeFailure(test.resolver.resolve(resolveInput(publishedManifest)))
    expect(test.getPage).toHaveBeenCalledOnce()
    expect(test.get).not.toHaveBeenCalled()
  })

  it('rejects cross-scope input before DB access and page attempt drift before blob access', async () => {
    const body = new TextEncoder().encode(stableStringify(payload))
    const crossScope = harness({ page: s3Page(body), body })
    await expectSafeFailure(crossScope.resolver.resolve(resolveInput(
      manifest(),
      { tenantId: 'tenant_other' },
    )))
    expect(crossScope.getPage).not.toHaveBeenCalled()
    expect(crossScope.get).not.toHaveBeenCalled()

    const attemptDrift = harness({
      page: s3Page(body, {}, { attempt: 2 }),
      body,
    })
    await expectSafeFailure(attemptDrift.resolver.resolve(resolveInput()))
    expect(attemptDrift.getPage).toHaveBeenCalledOnce()
    expect(attemptDrift.get).not.toHaveBeenCalled()
  })

  it.each([
    ['scope', { tenantId: 'tenant_other' }],
    ['attempt', { attempt: 2 }],
    ['kind', { kind: 'export' as const }],
    ['contentType', { contentType: 'application/json' }],
    ['checksum', { checksum: `sha256:${'f'.repeat(64)}` as const }],
    ['key', { key: 'chatbi/result-blobs/tampered' }],
    ['length', { byteLength: 0 }],
    ['etag', { etag: 'unquoted-etag' }],
  ])('rejects a tampered blob reference %s before GET', async (_label, patch) => {
    const body = new TextEncoder().encode(stableStringify(payload))
    const test = harness({ page: s3Page(body, patch), body })

    await expectSafeFailure(test.resolver.resolve(resolveInput()))
    expect(test.get).not.toHaveBeenCalled()
  })

  it('fails safely for a missing blob or mismatched returned descriptor', async () => {
    const body = new TextEncoder().encode(stableStringify(payload))
    const page = s3Page(body)
    const missing = harness({ page, body, missing: true })
    await expectSafeFailure(missing.resolver.resolve(resolveInput()))

    const mismatch = harness({
      page,
      body,
      loadedBlob: { ...(page.payload as { blob: ImmutableResultBlob }).blob, etag: '"other-etag"' },
    })
    await expectSafeFailure(mismatch.resolver.resolve(resolveInput()))
    expect(mismatch.get).toHaveBeenCalledOnce()
  })

  it.each([
    ['invalid JSON', new TextEncoder().encode('{"columns":')],
    ['invalid UTF-8', Uint8Array.from([0xc3, 0x28])],
    ['non-canonical JSON', new TextEncoder().encode('{ "rows": [], "columns": [] }')],
  ])('rejects %s after a descriptor-verified blob read', async (_label, body) => {
    const test = harness({ page: s3Page(body), body })

    await expectSafeFailure(test.resolver.resolve(resolveInput()))
    expect(test.calls).toEqual(['published-page', 'blob-get'])
  })

  it('recomputes body length and checksum even when a fake blob store lies', async () => {
    const body = new TextEncoder().encode(stableStringify(payload))
    const page = s3Page(body)
    const corrupted = Uint8Array.from(body)
    corrupted[0] ^= 1
    const test = harness({ page, body: corrupted })

    await expectSafeFailure(test.resolver.resolve(resolveInput()))
    expect(test.get).toHaveBeenCalledOnce()
  })
})
