import { createHash } from 'node:crypto'
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
  ResultPageStore,
  RunEventStore,
  StageResultPageInput,
  StageResultPageResult,
  StagedResultPage,
  StoredRunEvent,
} from '../../../../src/persistence/resultPorts'

interface PgResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

interface BoundedPgQuery {
  text: string
  values: readonly unknown[]
  query_timeout?: number
}

export interface PostgresResultEventClientLike {
  query<Row = Record<string, unknown>>(
    text: string | BoundedPgQuery,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresResultEventPoolLike {
  connect(): Promise<PostgresResultEventClientLike>
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgResult<Row>>
  end?(): Promise<void>
}

export interface PostgresResultEventStoreOptions {
  pool: PostgresResultEventPoolLike
  /** Must be independent from pool in production so poolMax=1 can still cancel. */
  cancellationPool?: PostgresResultEventPoolLike
  closePool?: boolean
  closeCancellationPool?: boolean
}

export interface PostgresResultPageStore<TPayload = unknown, TMetadata = unknown>
  extends ResultPageStore<TPayload, TMetadata> {
  close(): Promise<void>
}

export interface PostgresRunEventStore<TEvent = unknown> extends RunEventStore<TEvent> {
  close(): Promise<void>
}

interface PageRow {
  tenant_id: string
  workspace_id: string
  run_id: string
  attempt: number | string
  page_index: number | string
  checksum: string
  content_fingerprint: string
  row_count: number | string
  payload_json: unknown
  staged_at: string | Date
}

interface ManifestRow {
  tenant_id: string
  workspace_id: string
  run_id: string
  attempt: number | string
  result_id: string
  manifest_checksum: string
  content_fingerprint: string
  page_checksums: string[]
  page_count: number | string
  total_rows: number | string
  metadata_json: unknown
  published_at: string | Date
}

interface EventStreamRow {
  current_sequence: number | string
}

interface EventRow {
  tenant_id: string
  workspace_id: string
  run_id: string
  sequence: number | string
  idempotency_key: string
  content_fingerprint: string
  event_json: unknown
  occurred_at: string | Date
}

/** Node-only PostgreSQL result-page adapter. Do not export it from browser package barrels. */
export function createPostgresResultPageStore<TPayload = unknown, TMetadata = unknown>(
  options: PostgresResultEventStoreOptions,
): PostgresResultPageStore<TPayload, TMetadata> {
  async function stagePage(input: StageResultPageInput<TPayload>): Promise<StageResultPageResult<TPayload>> {
    validateScope(input)
    positiveInteger(input.attempt, 'attempt')
    nonNegativeInteger(input.pageIndex, 'pageIndex')
    nonNegativeInteger(input.rowCount, 'rowCount')
    nonEmpty(input.checksum, 'checksum')
    const stagedAt = instant(input.stagedAt, 'stagedAt')
    const payloadJson = stringifyJson(input.payload, 'payload')
    const contentFingerprint = fingerprint({ rowCount: input.rowCount, payload: parseJson(payloadJson) })

    return transaction(options.pool, async (client) => {
      const inserted = await client.query<PageRow>(`insert into chatbi_result_pages (
  tenant_id, workspace_id, run_id, attempt, page_index, checksum,
  content_fingerprint, row_count, payload_json, staged_at
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)
on conflict (tenant_id, workspace_id, run_id, attempt, page_index) do nothing
returning *`, [
        input.tenantId, input.workspaceId, input.runId, input.attempt, input.pageIndex,
        input.checksum, contentFingerprint, input.rowCount, payloadJson, stagedAt,
      ])
      const row = inserted.rows[0] ?? await loadPage(client, input)
      if (!row) throw new Error('staged result page could not be loaded')
      const page = mapPage<TPayload>(row)
      if (row.checksum !== input.checksum) return { ok: false, reason: 'checksum_conflict', page }
      if (row.content_fingerprint !== contentFingerprint) return { ok: false, reason: 'checksum_collision', page }
      return { ok: true, applied: Boolean(inserted.rowCount), page }
    })
  }

  async function publishManifest(
    input: PublishResultManifestInput<TMetadata>,
  ): Promise<PublishResultManifestResult<TMetadata>> {
    validateScope(input)
    positiveInteger(input.attempt, 'attempt')
    nonEmpty(input.resultId, 'resultId')
    nonEmpty(input.manifestChecksum, 'manifestChecksum')
    nonNegativeInteger(input.totalRows, 'totalRows')
    const publishedAt = instant(input.publishedAt, 'publishedAt')
    input.pageChecksums.forEach((checksum, index) => nonEmpty(checksum, `pageChecksums[${index}]`))
    const metadataJson = stringifyJson(input.metadata, 'metadata')
    const contentFingerprint = fingerprint({
      attempt: input.attempt,
      resultId: input.resultId,
      pageChecksums: input.pageChecksums,
      totalRows: input.totalRows,
      metadata: parseJson(metadataJson),
    })

    return transaction(options.pool, async (client) => {
      const existing = await loadManifest<TMetadata>(client, input, true)
      if (existing) return compareManifest(existing, input.manifestChecksum, contentFingerprint)

      const pages = await client.query<PageRow>(`select * from chatbi_result_pages
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and attempt = $4
order by page_index asc for share`, [input.tenantId, input.workspaceId, input.runId, input.attempt])
      if (pages.rows.length !== input.pageChecksums.length) return { ok: false, reason: 'missing_page' }
      let totalRows = 0
      for (let index = 0; index < input.pageChecksums.length; index += 1) {
        const page = pages.rows[index]
        if (integer(page.page_index, 'page_index') !== index) return { ok: false, reason: 'missing_page' }
        if (page.checksum !== input.pageChecksums[index]) return { ok: false, reason: 'page_checksum_mismatch' }
        totalRows += integer(page.row_count, 'row_count')
      }
      if (totalRows !== input.totalRows) return { ok: false, reason: 'row_count_mismatch' }

      const inserted = await client.query<ManifestRow>(`insert into chatbi_result_manifests (
  tenant_id, workspace_id, run_id, attempt, result_id, manifest_checksum,
  content_fingerprint, page_checksums, page_count, total_rows, metadata_json, published_at
) values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11::jsonb, $12::timestamptz)
on conflict (tenant_id, workspace_id, run_id) do nothing
returning *`, [
        input.tenantId, input.workspaceId, input.runId, input.attempt, input.resultId,
        input.manifestChecksum, contentFingerprint, input.pageChecksums, input.pageChecksums.length,
        input.totalRows, metadataJson, publishedAt,
      ])
      const row = inserted.rows[0]
      if (row) return { ok: true, applied: true, manifest: mapManifest<TMetadata>(row) }
      const raced = await loadManifest<TMetadata>(client, input, false)
      if (!raced) throw new Error('published result manifest could not be loaded')
      return compareManifest(raced, input.manifestChecksum, contentFingerprint)
    })
  }

  async function getManifest(input: GetPublishedResultInput) {
    validateScope(input)
    const result = await options.pool.query<ManifestRow>(`select * from chatbi_result_manifests
where tenant_id = $1 and workspace_id = $2 and run_id = $3`, [input.tenantId, input.workspaceId, input.runId])
    return result.rows[0] ? mapManifest<TMetadata>(result.rows[0]) : undefined
  }

  async function getPage(input: GetPublishedResultPageInput): Promise<PublishedResultPage<TPayload> | undefined> {
    validateScope(input)
    nonNegativeInteger(input.pageIndex, 'pageIndex')
    const result = await options.pool.query<PageRow & Pick<ManifestRow, 'result_id' | 'manifest_checksum' | 'published_at'>>(`select
  page.*, manifest.result_id, manifest.manifest_checksum, manifest.published_at
from chatbi_result_manifests manifest
join chatbi_result_pages page
  on page.tenant_id = manifest.tenant_id
 and page.workspace_id = manifest.workspace_id
 and page.run_id = manifest.run_id
 and page.attempt = manifest.attempt
 and page.page_index = $4
 and page.checksum = manifest.page_checksums[page.page_index + 1]
where manifest.tenant_id = $1 and manifest.workspace_id = $2 and manifest.run_id = $3`, [
      input.tenantId, input.workspaceId, input.runId, input.pageIndex,
    ])
    const row = result.rows[0]
    return row ? {
      ...mapPage<TPayload>(row),
      resultId: row.result_id,
      manifestChecksum: row.manifest_checksum,
      publishedAt: iso(row.published_at),
    } : undefined
  }

  async function close() {
    if (options.closePool) await options.pool.end?.()
  }

  return { stagePage, publishManifest, getManifest, getPage, close }
}

/** Node-only PostgreSQL append-only run-event adapter. */
export function createPostgresRunEventStore<TEvent = unknown>(
  options: PostgresResultEventStoreOptions,
): PostgresRunEventStore<TEvent> {
  async function append(input: AppendRunEventInput<TEvent>): Promise<AppendRunEventResult<TEvent>> {
    validateScope(input)
    nonEmpty(input.eventId, 'eventId')
    nonNegativeInteger(input.expectedSequence, 'expectedSequence')
    const occurredAt = instant(input.occurredAt, 'occurredAt')
    const eventJson = stringifyJson(input.event, 'event')
    const contentFingerprint = fingerprint({ event: parseJson(eventJson), occurredAt })

    return transaction(options.pool, async (client) => {
      await client.query(`insert into chatbi_run_event_streams (
  tenant_id, workspace_id, run_id, current_sequence, updated_at
) values ($1, $2, $3, 0, $4::timestamptz)
on conflict (tenant_id, workspace_id, run_id) do nothing`, [
        input.tenantId, input.workspaceId, input.runId, occurredAt,
      ])
      const stream = await client.query<EventStreamRow>(`select current_sequence from chatbi_run_event_streams
where tenant_id = $1 and workspace_id = $2 and run_id = $3 for update`, [
        input.tenantId, input.workspaceId, input.runId,
      ])
      const currentSequence = integer(stream.rows[0]?.current_sequence, 'current_sequence')
      const existing = await client.query<EventRow>(`select * from chatbi_run_events
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and idempotency_key = $4`, [
        input.tenantId, input.workspaceId, input.runId, input.eventId,
      ])
      if (existing.rows[0]) {
        const stored = mapEvent<TEvent>(existing.rows[0])
        return existing.rows[0].content_fingerprint === contentFingerprint
          ? { ok: true, applied: false, stored }
          : { ok: false, reason: 'idempotency_conflict', stored }
      }
      if (input.expectedSequence !== currentSequence) {
        return { ok: false, reason: 'sequence_conflict', currentSequence }
      }

      const nextSequence = currentSequence + 1
      const advanced = await client.query(`update chatbi_run_event_streams
set current_sequence = $4, updated_at = $5::timestamptz
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and current_sequence = $6`, [
        input.tenantId, input.workspaceId, input.runId, nextSequence, occurredAt, input.expectedSequence,
      ])
      if (advanced.rowCount !== 1) return { ok: false, reason: 'sequence_conflict', currentSequence }
      const inserted = await client.query<EventRow>(`insert into chatbi_run_events (
  tenant_id, workspace_id, run_id, sequence, idempotency_key,
  content_fingerprint, event_json, occurred_at
) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
returning *`, [
        input.tenantId, input.workspaceId, input.runId, nextSequence, input.eventId,
        contentFingerprint, eventJson, occurredAt,
      ])
      const row = inserted.rows[0]
      if (!row) throw new Error('appended run event could not be loaded')
      return { ok: true, applied: true, stored: mapEvent<TEvent>(row) }
    })
  }

  async function listAfter(input: ListRunEventsInput): Promise<StoredRunEvent<TEvent>[]> {
    validateScope(input)
    nonNegativeInteger(input.afterSequence, 'afterSequence')
    const limit = input.limit ?? 100
    positiveInteger(limit, 'limit')
    if (limit > 1000) throw new Error('limit cannot exceed 1000')
    const result = await boundedReadQuery<EventRow>(
      options.pool,
      options.cancellationPool ?? options.pool,
      `select * from chatbi_run_events
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and sequence > $4
order by sequence asc limit $5`,
      [input.tenantId, input.workspaceId, input.runId, input.afterSequence, limit],
      input,
    )
    return result.rows.map(mapEvent<TEvent>)
  }

  async function currentSequence(input: GetPublishedResultInput) {
    validateScope(input)
    const result = await boundedReadQuery<EventStreamRow>(
      options.pool,
      options.cancellationPool ?? options.pool,
      `select current_sequence from chatbi_run_event_streams
where tenant_id = $1 and workspace_id = $2 and run_id = $3`,
      [input.tenantId, input.workspaceId, input.runId],
      input,
    )
    return result.rows[0] ? integer(result.rows[0].current_sequence, 'current_sequence') : 0
  }

  async function close() {
    if (options.closePool) await options.pool.end?.()
    if (options.closeCancellationPool && options.cancellationPool !== options.pool) {
      await options.cancellationPool?.end?.()
    }
  }

  return { append, listAfter, currentSequence, close }
}

async function boundedReadQuery<Row>(
  pool: PostgresResultEventPoolLike,
  cancellationPool: PostgresResultEventPoolLike,
  text: string,
  values: readonly unknown[],
  boundary: { signal?: AbortSignal; timeoutMs?: number },
): Promise<PgResult<Row>> {
  if (boundary.signal?.aborted) throw abortError()
  if (boundary.timeoutMs !== undefined) positiveInteger(boundary.timeoutMs, 'timeoutMs')
  if (!boundary.signal && boundary.timeoutMs === undefined) return pool.query<Row>(text, values)

  const client = await acquireReadClient(pool, boundary.signal)
  let releaseWithError = false
  try {
    if (boundary.signal?.aborted) throw abortError()
    const pidResult = await client.query<{ backend_pid: number | string }>({
      text: 'select pg_backend_pid() as backend_pid',
      values: [],
      ...(boundary.timeoutMs !== undefined ? { query_timeout: boundary.timeoutMs } : {}),
    })
    const backendPid = positiveDatabaseInteger(pidResult.rows[0]?.backend_pid, 'backend_pid')
    if (boundary.signal?.aborted) throw abortError()

    let cancellation: Promise<void> | undefined
    const onAbort = () => {
      cancellation ??= cancelReadBackend(cancellationPool, backendPid).catch(() => undefined)
    }
    boundary.signal?.addEventListener('abort', onAbort, { once: true })
    if (boundary.signal?.aborted) onAbort()
    try {
      return await client.query<Row>({
        text,
        values,
        ...(boundary.timeoutMs !== undefined ? { query_timeout: boundary.timeoutMs } : {}),
      })
    } catch (error) {
      releaseWithError = !isPostgresCancellation(error)
      if (boundary.signal?.aborted) throw abortError()
      throw error
    } finally {
      boundary.signal?.removeEventListener('abort', onAbort)
      // Cancellation is best effort and already owns a rejection handler.
      void cancellation
    }
  } catch (error) {
    releaseWithError = !(error instanceof Error && error.name === 'AbortError')
    throw error
  } finally {
    client.release(releaseWithError || undefined)
  }
}

function abortError() {
  const error = new Error('PostgreSQL event read aborted')
  error.name = 'AbortError'
  return error
}

function acquireReadClient(
  pool: PostgresResultEventPoolLike,
  signal: AbortSignal | undefined,
): Promise<PostgresResultEventClientLike> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void pool.connect().then((client) => {
      if (settled) {
        client.release()
        return
      }
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(client)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (signal?.aborted) onAbort()
  })
}

async function cancelReadBackend(pool: PostgresResultEventPoolLike, backendPid: number): Promise<void> {
  const result = await pool.query<{ cancelled: boolean }>(
    'select pg_cancel_backend($1) as cancelled',
    [backendPid],
  )
  if (result.rows[0]?.cancelled !== true) throw new Error('PostgreSQL event read cancellation rejected')
}

function positiveDatabaseInteger(value: unknown, name: string): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`)
  return number
}

function isPostgresCancellation(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && String((error as { code: unknown }).code) === '57014'
}

async function loadPage(
  client: PostgresResultEventClientLike,
  input: Pick<StageResultPageInput, 'tenantId' | 'workspaceId' | 'runId' | 'attempt' | 'pageIndex'>,
) {
  const result = await client.query<PageRow>(`select * from chatbi_result_pages
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and attempt = $4 and page_index = $5`, [
    input.tenantId, input.workspaceId, input.runId, input.attempt, input.pageIndex,
  ])
  return result.rows[0]
}

async function loadManifest<TMetadata>(
  client: PostgresResultEventClientLike,
  input: GetPublishedResultInput,
  lock: boolean,
): Promise<PublishedResultManifest<TMetadata> | undefined> {
  const result = await client.query<ManifestRow>(`select * from chatbi_result_manifests
where tenant_id = $1 and workspace_id = $2 and run_id = $3${lock ? ' for update' : ''}`, [
    input.tenantId, input.workspaceId, input.runId,
  ])
  return result.rows[0] ? mapManifest<TMetadata>(result.rows[0]) : undefined
}

function compareManifest<TMetadata>(
  manifest: PublishedResultManifest<TMetadata>,
  checksum: string,
  contentFingerprint: string,
): PublishResultManifestResult<TMetadata> {
  if (manifest.manifestChecksum !== checksum) return { ok: false, reason: 'publish_conflict', manifest }
  const existingFingerprint = fingerprint({
    attempt: manifest.attempt,
    resultId: manifest.resultId,
    pageChecksums: manifest.pageChecksums,
    totalRows: manifest.totalRows,
    metadata: manifest.metadata,
  })
  return existingFingerprint === contentFingerprint
    ? { ok: true, applied: false, manifest }
    : { ok: false, reason: 'checksum_collision', manifest }
}

function mapPage<TPayload>(row: PageRow): StagedResultPage<TPayload> {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    attempt: integer(row.attempt, 'attempt'),
    pageIndex: integer(row.page_index, 'page_index'),
    checksum: row.checksum,
    rowCount: integer(row.row_count, 'row_count'),
    payload: parseJson<TPayload>(row.payload_json),
    stagedAt: iso(row.staged_at),
  }
}

function mapManifest<TMetadata>(row: ManifestRow): PublishedResultManifest<TMetadata> {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    attempt: integer(row.attempt, 'attempt'),
    resultId: row.result_id,
    manifestChecksum: row.manifest_checksum,
    pageChecksums: [...row.page_checksums],
    pageCount: integer(row.page_count, 'page_count'),
    totalRows: integer(row.total_rows, 'total_rows'),
    metadata: parseJson<TMetadata>(row.metadata_json),
    publishedAt: iso(row.published_at),
  }
}

function mapEvent<TEvent>(row: EventRow): StoredRunEvent<TEvent> {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    eventId: row.idempotency_key,
    sequence: integer(row.sequence, 'sequence'),
    event: parseJson<TEvent>(row.event_json),
    occurredAt: iso(row.occurred_at),
  }
}

async function transaction<T>(
  pool: PostgresResultEventPoolLike,
  work: (client: PostgresResultEventClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let transactionStarted = false
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    transactionStarted = true
    const result = await work(client)
    await client.query('COMMIT')
    transactionStarted = false
    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('rollback failed')
      }
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}

function validateScope(input: { tenantId: string; workspaceId: string; runId: string }) {
  nonEmpty(input.tenantId, 'tenantId')
  nonEmpty(input.workspaceId, 'workspaceId')
  nonEmpty(input.runId, 'runId')
}

function nonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} cannot be empty`)
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function integer(value: unknown, name: string) {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is missing`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} is not a safe non-negative integer`)
  return number
}

function instant(value: string, name: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid ISO instant`)
  return new Date(value).toISOString()
}

function iso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('database returned an invalid timestamp')
  return date.toISOString()
}

function stringifyJson(value: unknown, name: string) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error(`${name} must be JSON serializable`)
  return json
}

function parseJson<T = unknown>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : structuredClone(value)) as T
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
