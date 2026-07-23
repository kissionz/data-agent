import { createHash, timingSafeEqual } from 'node:crypto'
import type {
  ImmutableResultBlob,
  ImmutableResultBlobStore,
  ResultBlobDescriptor,
} from '../../../../src/persistence/resultBlobPorts'
import {
  buildImmutableResultBlobKey,
  resultBlobChecksumHex,
  validateResultBlobDescriptor,
} from '../../../../src/persistence/resultBlobPorts'
import type {
  PublishedResultPage,
  PublishedResultPageResolver,
  ResolvePublishedResultPageInput,
  ResultPageStore,
} from '../../../../src/persistence/resultPorts'
import type {
  TransactionalResultBlobPageReference,
  TransactionalResultManifestMetadata,
  TransactionalResultPage,
  TransactionalStoredResultPage,
} from '../transactionalQueryExecutionCoordinator'

const resultPageContentType = 'application/vnd.insightflow.result-page+json'
const immutableCacheControl = 'private, max-age=31536000, immutable'
const etagPattern = /^"[A-Za-z0-9._:+/=-]{1,160}"$/

export class BlobBackedResultPageResolverError extends Error {
  readonly code = 'RESULT_PAGE_UNAVAILABLE'

  constructor() {
    super('Published result page is unavailable.')
    this.name = 'BlobBackedResultPageResolverError'
  }
}

export interface BlobBackedResultPageResolverOptions {
  resultPageStore: ResultPageStore<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >
  blobStore: ImmutableResultBlobStore
}

/**
 * Resolves external page bytes only after the caller supplies an already
 * authorized published manifest. Every persisted descriptor is revalidated
 * before object storage is contacted.
 */
export function createBlobBackedResultPageResolver(
  options: BlobBackedResultPageResolverOptions,
): PublishedResultPageResolver<
  TransactionalResultPage,
  TransactionalResultManifestMetadata
> {
  return {
    async resolve(input) {
      try {
        validateAuthorizedManifestScope(input)
        const stored = await options.resultPageStore.getPage({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          pageIndex: input.pageIndex,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        })
        validatePublishedPageEnvelope(stored, input)
        if (isInlineManifest(input.manifest.metadata)) {
          if (isBlobReference(stored.payload)) throw safeFailure()
          return stored as PublishedResultPage<TransactionalResultPage>
        }

        validateS3Manifest(input.manifest.metadata)
        const reference = parseBlobReference(stored.payload)
        const descriptor = validateReference(reference, input)
        const loaded = await options.blobStore.get({
          ...descriptor,
          signal: input.signal,
          timeoutMs: input.timeoutMs,
        })
        if (!loaded) throw safeFailure()
        validateLoadedBlob(loaded.blob, reference.blob, descriptor, loaded.body)
        const payload = decodeCanonicalResultPage(loaded.body)
        return { ...stored, payload }
      } catch (error) {
        if (error instanceof BlobBackedResultPageResolverError) throw error
        throw safeFailure()
      }
    },
  }
}

function validateAuthorizedManifestScope(
  input: ResolvePublishedResultPageInput<TransactionalResultManifestMetadata>,
) {
  if (
    input.manifest.tenantId !== input.tenantId
    || input.manifest.workspaceId !== input.workspaceId
    || input.manifest.runId !== input.runId
    || !Number.isSafeInteger(input.pageIndex)
    || input.pageIndex < 0
    || input.pageIndex >= input.manifest.pageCount
    || input.manifest.pageChecksums.length !== input.manifest.pageCount
  ) {
    throw safeFailure()
  }
}

function validatePublishedPageEnvelope(
  page: PublishedResultPage<TransactionalStoredResultPage> | undefined,
  input: ResolvePublishedResultPageInput<TransactionalResultManifestMetadata>,
): asserts page is PublishedResultPage<TransactionalStoredResultPage> {
  if (
    !page
    || page.tenantId !== input.tenantId
    || page.workspaceId !== input.workspaceId
    || page.runId !== input.runId
    || page.attempt !== input.manifest.attempt
    || page.pageIndex !== input.pageIndex
    || page.checksum !== input.manifest.pageChecksums[input.pageIndex]
    || page.resultId !== input.manifest.resultId
    || page.manifestChecksum !== input.manifest.manifestChecksum
    || page.publishedAt !== input.manifest.publishedAt
  ) {
    throw safeFailure()
  }
}

function isInlineManifest(metadata: TransactionalResultManifestMetadata) {
  if (metadata.schemaVersion !== 'chatbi_result_manifest.v1') return false
  return metadata.pageStorage === undefined || (
    metadata.pageStorage.type === 'inline'
    && metadata.pageStorage.encoding === 'canonical-json'
    && metadata.pageStorage.contentType === resultPageContentType
  )
}

function validateS3Manifest(metadata: TransactionalResultManifestMetadata) {
  if (
    metadata.schemaVersion !== 'chatbi_result_manifest.v2'
    || metadata.pageStorage?.type !== 's3'
    || metadata.pageStorage.encoding !== 'canonical-json'
    || metadata.pageStorage.contentType !== resultPageContentType
  ) {
    throw safeFailure()
  }
}

function isBlobReference(value: TransactionalStoredResultPage): value is TransactionalResultBlobPageReference {
  return Boolean(
    value
    && typeof value === 'object'
    && 'schemaVersion' in value
    && value.schemaVersion === 'chatbi_result_page_blob_reference.v1',
  )
}

function parseBlobReference(value: TransactionalStoredResultPage): TransactionalResultBlobPageReference {
  if (
    !isBlobReference(value)
    || value.storage !== 's3'
    || !value.blob
    || typeof value.blob !== 'object'
  ) {
    throw safeFailure()
  }
  return value
}

function validateReference(
  reference: TransactionalResultBlobPageReference,
  input: ResolvePublishedResultPageInput<TransactionalResultManifestMetadata>,
): ResultBlobDescriptor {
  const descriptor: ResultBlobDescriptor = {
    tenantId: reference.blob.tenantId,
    workspaceId: reference.blob.workspaceId,
    runId: reference.blob.runId,
    attempt: reference.blob.attempt,
    kind: reference.blob.kind,
    checksum: reference.blob.checksum,
    byteLength: reference.blob.byteLength,
    contentType: reference.blob.contentType,
  }
  validateResultBlobDescriptor(descriptor)
  if (
    descriptor.tenantId !== input.tenantId
    || descriptor.workspaceId !== input.workspaceId
    || descriptor.runId !== input.runId
    || descriptor.attempt !== input.manifest.attempt
    || descriptor.kind !== 'page'
    || descriptor.contentType !== resultPageContentType
    || descriptor.byteLength < 1
    || reference.blob.key !== buildImmutableResultBlobKey(descriptor)
    || !etagPattern.test(reference.blob.etag)
    || reference.blob.cacheControl !== immutableCacheControl
  ) {
    throw safeFailure()
  }
  return descriptor
}

function validateLoadedBlob(
  actual: ImmutableResultBlob,
  reference: ImmutableResultBlob,
  descriptor: ResultBlobDescriptor,
  body: Uint8Array,
) {
  const metadataMatches = (
    actual.key === reference.key
    && actual.tenantId === descriptor.tenantId
    && actual.workspaceId === descriptor.workspaceId
    && actual.runId === descriptor.runId
    && actual.attempt === descriptor.attempt
    && actual.kind === descriptor.kind
    && actual.checksum === descriptor.checksum
    && actual.byteLength === descriptor.byteLength
    && actual.contentType === descriptor.contentType
    && actual.etag === reference.etag
    && actual.cacheControl === immutableCacheControl
  )
  if (!metadataMatches || !(body instanceof Uint8Array) || body.byteLength !== descriptor.byteLength) {
    throw safeFailure()
  }
  const expected = Buffer.from(resultBlobChecksumHex(descriptor.checksum), 'hex')
  const actualChecksum = createHash('sha256').update(body).digest()
  if (expected.length !== actualChecksum.length || !timingSafeEqual(expected, actualChecksum)) {
    throw safeFailure()
  }
}

function decodeCanonicalResultPage(body: Uint8Array): TransactionalResultPage {
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
    parsed = JSON.parse(text) as unknown
  } catch {
    throw safeFailure()
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw safeFailure()
  if (stableStringify(parsed) !== text) throw safeFailure()
  return parsed as TransactionalResultPage
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function safeFailure() {
  return new BlobBackedResultPageResolverError()
}
