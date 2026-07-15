import type {
  AppendRunEventInput,
  AppendRunEventResult,
  GetPublishedResultInput,
  GetPublishedResultPageInput,
  ListRunEventsInput,
  PublishResultManifestInput,
  PublishResultManifestResult,
  PublishedResultManifest,
  PublishedResultPage,
  SynchronousResultPageStore,
  SynchronousRunEventStore,
  StageResultPageInput,
  StageResultPageResult,
  StagedResultPage,
  StoredRunEvent,
} from './resultPorts'

export function createInMemoryResultPageStore<TPayload = unknown, TMetadata = unknown>(): SynchronousResultPageStore<TPayload, TMetadata> {
  const stagedPages = new Map<string, StagedResultPage<TPayload>>()
  const manifests = new Map<string, PublishedResultManifest<TMetadata>>()

  function stagePage(input: StageResultPageInput<TPayload>): StageResultPageResult<TPayload> {
    validateScope(input)
    positiveInteger(input.attempt, 'attempt')
    nonNegativeInteger(input.pageIndex, 'pageIndex')
    nonNegativeInteger(input.rowCount, 'rowCount')
    nonEmpty(input.checksum, 'checksum')
    instant(input.stagedAt, 'stagedAt')
    clone(input.payload)

    const key = pageKey(input)
    const existing = stagedPages.get(key)
    if (existing) {
      if (existing.checksum !== input.checksum) {
        return { ok: false, reason: 'checksum_conflict', page: copy(existing) }
      }
      if (existing.rowCount !== input.rowCount || fingerprint(existing.payload) !== fingerprint(input.payload)) {
        return { ok: false, reason: 'checksum_collision', page: copy(existing) }
      }
      return { ok: true, applied: false, page: copy(existing) }
    }

    const page = copy(input)
    stagedPages.set(key, page)
    return { ok: true, applied: true, page: copy(page) }
  }

  function publishManifest(input: PublishResultManifestInput<TMetadata>): PublishResultManifestResult<TMetadata> {
    validateScope(input)
    positiveInteger(input.attempt, 'attempt')
    nonEmpty(input.resultId, 'resultId')
    nonEmpty(input.manifestChecksum, 'manifestChecksum')
    nonNegativeInteger(input.totalRows, 'totalRows')
    instant(input.publishedAt, 'publishedAt')
    if (!Array.isArray(input.pageChecksums)) throw new Error('pageChecksums must be an array')
    input.pageChecksums.forEach((checksum, index) => nonEmpty(checksum, `pageChecksums[${index}]`))
    clone(input.metadata)

    const key = runKey(input)
    const existing = manifests.get(key)
    if (existing) {
      if (existing.manifestChecksum !== input.manifestChecksum) {
        return { ok: false, reason: 'publish_conflict', manifest: copy(existing) }
      }
      if (!sameManifest(existing, input)) {
        return { ok: false, reason: 'checksum_collision', manifest: copy(existing) }
      }
      return { ok: true, applied: false, manifest: copy(existing) }
    }

    let totalRows = 0
    for (let pageIndex = 0; pageIndex < input.pageChecksums.length; pageIndex += 1) {
      const page = stagedPages.get(pageKey({ ...input, pageIndex }))
      if (!page) return { ok: false, reason: 'missing_page' }
      if (page.checksum !== input.pageChecksums[pageIndex]) {
        return { ok: false, reason: 'page_checksum_mismatch' }
      }
      totalRows += page.rowCount
    }
    if (totalRows !== input.totalRows) return { ok: false, reason: 'row_count_mismatch' }

    const manifest: PublishedResultManifest<TMetadata> = {
      ...copy(input),
      pageCount: input.pageChecksums.length,
    }
    manifests.set(key, manifest)
    return { ok: true, applied: true, manifest: copy(manifest) }
  }

  function getManifest(input: GetPublishedResultInput) {
    validateScope(input)
    return copy(manifests.get(runKey(input)))
  }

  function getPage(input: GetPublishedResultPageInput): PublishedResultPage<TPayload> | undefined {
    validateScope(input)
    nonNegativeInteger(input.pageIndex, 'pageIndex')
    const manifest = manifests.get(runKey(input))
    if (!manifest || input.pageIndex >= manifest.pageCount) return undefined
    const page = stagedPages.get(pageKey({ ...manifest, pageIndex: input.pageIndex }))
    if (!page || page.checksum !== manifest.pageChecksums[input.pageIndex]) return undefined
    return copy({
      ...page,
      resultId: manifest.resultId,
      manifestChecksum: manifest.manifestChecksum,
      publishedAt: manifest.publishedAt,
    })
  }

  return { stagePage, publishManifest, getManifest, getPage }
}

export function createInMemoryRunEventStore<TEvent = unknown>(): SynchronousRunEventStore<TEvent> {
  const streams = new Map<string, StoredRunEvent<TEvent>[]>()
  const byEventId = new Map<string, StoredRunEvent<TEvent>>()

  function append(input: AppendRunEventInput<TEvent>): AppendRunEventResult<TEvent> {
    validateScope(input)
    nonEmpty(input.eventId, 'eventId')
    nonNegativeInteger(input.expectedSequence, 'expectedSequence')
    instant(input.occurredAt, 'occurredAt')
    clone(input.event)
    const eventIdentity = `${runKey(input)}\u0000${input.eventId}`
    const existing = byEventId.get(eventIdentity)
    if (existing) {
      const same = existing.occurredAt === input.occurredAt && fingerprint(existing.event) === fingerprint(input.event)
      return same
        ? { ok: true, applied: false, stored: copy(existing) }
        : { ok: false, reason: 'idempotency_conflict', stored: copy(existing) }
    }

    const key = runKey(input)
    const stream = streams.get(key) ?? []
    const currentSequence = stream.length === 0 ? 0 : stream[stream.length - 1].sequence
    if (input.expectedSequence !== currentSequence) {
      return { ok: false, reason: 'sequence_conflict', currentSequence }
    }

    const stored: StoredRunEvent<TEvent> = {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      runId: input.runId,
      eventId: input.eventId,
      sequence: currentSequence + 1,
      event: clone(input.event),
      occurredAt: input.occurredAt,
    }
    stream.push(stored)
    streams.set(key, stream)
    byEventId.set(eventIdentity, stored)
    return { ok: true, applied: true, stored: copy(stored) }
  }

  function listAfter(input: ListRunEventsInput): StoredRunEvent<TEvent>[] {
    validateScope(input)
    nonNegativeInteger(input.afterSequence, 'afterSequence')
    const limit = input.limit ?? 100
    positiveInteger(limit, 'limit')
    if (limit > 1000) throw new Error('limit cannot exceed 1000')
    return (streams.get(runKey(input)) ?? [])
      .filter((event) => event.sequence > input.afterSequence)
      .slice(0, limit)
      .map(copy)
  }

  function currentSequence(input: GetPublishedResultInput) {
    validateScope(input)
    const stream = streams.get(runKey(input)) ?? []
    return stream.length === 0 ? 0 : stream[stream.length - 1].sequence
  }

  return { append, listAfter, currentSequence }
}

function runKey(input: { tenantId: string; workspaceId: string; runId: string }) {
  return `${input.tenantId}\u0000${input.workspaceId}\u0000${input.runId}`
}

function pageKey(input: { tenantId: string; workspaceId: string; runId: string; attempt: number; pageIndex: number }) {
  return `${runKey(input)}\u0000${input.attempt}\u0000${input.pageIndex}`
}

function sameManifest<TMetadata>(existing: PublishedResultManifest<TMetadata>, input: PublishResultManifestInput<TMetadata>) {
  return existing.attempt === input.attempt
    && existing.resultId === input.resultId
    && existing.totalRows === input.totalRows
    && fingerprint(existing.pageChecksums) === fingerprint(input.pageChecksums)
    && fingerprint(existing.metadata) === fingerprint(input.metadata)
}

function validateScope(input: { tenantId: string; workspaceId: string; runId: string }) {
  nonEmpty(input.tenantId, 'tenantId')
  nonEmpty(input.workspaceId, 'workspaceId')
  nonEmpty(input.runId, 'runId')
}

function nonEmpty(value: string, field: string) {
  if (!value.trim()) throw new Error(`${field} must not be empty`)
}

function positiveInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`)
}

function nonNegativeInteger(value: number, field: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`)
}

function instant(value: string, field: string) {
  if (!value.trim() || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`)
}

function copy<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function fingerprint(value: unknown): string {
  return stableStringify(value)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
