export interface PersistenceScope {
  tenantId: string
  workspaceId: string
}

export interface StageResultPageInput<TPayload = unknown> extends PersistenceScope {
  runId: string
  attempt: number
  pageIndex: number
  checksum: string
  rowCount: number
  payload: TPayload
  stagedAt: string
}

export interface StagedResultPage<TPayload = unknown> extends StageResultPageInput<TPayload> {}

export type StageResultPageResult<TPayload = unknown> =
  | { ok: true; applied: boolean; page: StagedResultPage<TPayload> }
  | { ok: false; reason: 'checksum_conflict' | 'checksum_collision'; page: StagedResultPage<TPayload> }

export interface PublishResultManifestInput<TMetadata = unknown> extends PersistenceScope {
  runId: string
  attempt: number
  resultId: string
  manifestChecksum: string
  pageChecksums: string[]
  totalRows: number
  metadata: TMetadata
  publishedAt: string
}

export interface PublishedResultManifest<TMetadata = unknown> extends PublishResultManifestInput<TMetadata> {
  pageCount: number
}

export type PublishResultManifestFailureReason =
  | 'missing_page'
  | 'page_checksum_mismatch'
  | 'row_count_mismatch'
  | 'publish_conflict'
  | 'checksum_collision'

export type PublishResultManifestResult<TMetadata = unknown> =
  | { ok: true; applied: boolean; manifest: PublishedResultManifest<TMetadata> }
  | { ok: false; reason: PublishResultManifestFailureReason; manifest?: PublishedResultManifest<TMetadata> }

export interface GetPublishedResultInput extends PersistenceScope {
  runId: string
}

export interface GetPublishedResultPageInput extends GetPublishedResultInput {
  pageIndex: number
}

export interface PublishedResultPage<TPayload = unknown> extends StagedResultPage<TPayload> {
  resultId: string
  manifestChecksum: string
  publishedAt: string
}

/**
 * Stores immutable result pages before atomically publishing their manifest.
 * Staged pages are deliberately not exposed through the read API.
 */
export interface ResultPageStore<TPayload = unknown, TMetadata = unknown> {
  stagePage(input: StageResultPageInput<TPayload>): MaybePromise<StageResultPageResult<TPayload>>
  publishManifest(input: PublishResultManifestInput<TMetadata>): MaybePromise<PublishResultManifestResult<TMetadata>>
  getManifest(input: GetPublishedResultInput): MaybePromise<PublishedResultManifest<TMetadata> | undefined>
  getPage(input: GetPublishedResultPageInput): MaybePromise<PublishedResultPage<TPayload> | undefined>
}

/** Synchronous specialization used by deterministic browser/local adapters. */
export interface SynchronousResultPageStore<TPayload = unknown, TMetadata = unknown>
  extends ResultPageStore<TPayload, TMetadata> {
  stagePage(input: StageResultPageInput<TPayload>): StageResultPageResult<TPayload>
  publishManifest(input: PublishResultManifestInput<TMetadata>): PublishResultManifestResult<TMetadata>
  getManifest(input: GetPublishedResultInput): PublishedResultManifest<TMetadata> | undefined
  getPage(input: GetPublishedResultPageInput): PublishedResultPage<TPayload> | undefined
}

export interface AppendRunEventInput<TEvent = unknown> extends PersistenceScope {
  runId: string
  eventId: string
  expectedSequence: number
  event: TEvent
  occurredAt: string
}

export interface StoredRunEvent<TEvent = unknown> extends PersistenceScope {
  runId: string
  eventId: string
  sequence: number
  event: TEvent
  occurredAt: string
}

export type AppendRunEventResult<TEvent = unknown> =
  | { ok: true; applied: boolean; stored: StoredRunEvent<TEvent> }
  | { ok: false; reason: 'sequence_conflict'; currentSequence: number }
  | { ok: false; reason: 'idempotency_conflict'; stored: StoredRunEvent<TEvent> }

export interface ListRunEventsInput extends PersistenceScope {
  runId: string
  afterSequence: number
  limit?: number
}

/** Append-only per-run event log with optimistic sequence fencing. */
export interface RunEventStore<TEvent = unknown> {
  append(input: AppendRunEventInput<TEvent>): MaybePromise<AppendRunEventResult<TEvent>>
  listAfter(input: ListRunEventsInput): MaybePromise<StoredRunEvent<TEvent>[]>
  currentSequence(input: GetPublishedResultInput): MaybePromise<number>
}

/** Synchronous specialization used by deterministic browser/local adapters. */
export interface SynchronousRunEventStore<TEvent = unknown> extends RunEventStore<TEvent> {
  append(input: AppendRunEventInput<TEvent>): AppendRunEventResult<TEvent>
  listAfter(input: ListRunEventsInput): StoredRunEvent<TEvent>[]
  currentSequence(input: GetPublishedResultInput): number
}
import type { MaybePromise } from './jobPorts'
