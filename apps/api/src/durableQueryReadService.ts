import {
  createHash,
} from 'node:crypto'
import {
  CONTRACT_VERSION,
  validateActor,
  type ActorContext,
  type ApiEnvelope,
  type PublicErrorCode,
  type ResultPageRequest,
  type ResultPageView,
} from '../../../src/contracts'
import type { QueryControlPlane } from '../../../src/persistence/controlPlanePorts'
import type { StoredRunRecord } from '../../../src/persistence/ports'
import type {
  PublishedResultManifest,
  PublishedResultPage,
  PublishedResultPageResolver,
  ResultPageStore,
  RunEventStore,
  StoredRunEvent,
} from '../../../src/persistence/resultPorts'
import type {
  TransactionalResultManifestMetadata,
  TransactionalResultPage,
  TransactionalStoredResultPage,
} from './transactionalQueryExecutionCoordinator'
import {
  DEFAULT_DURABLE_EVENT_POLL_INTERVAL_MS,
  DEFAULT_DURABLE_EVENT_WAIT_MS,
  DurableEventPollAbortedError,
  MAX_DURABLE_EVENT_WAIT_MS,
  longPollDurableEvents,
} from './durableEventLongPoll'

export interface DurableRunEventsRequest {
  runId: string
  conversationId: string
  actor: ActorContext
  afterSequence?: string
  limit?: number
  waitMs?: number
  signal?: AbortSignal
}

export interface DurableRunEventsView<TEvent = unknown> {
  runId: string
  conversationId: string
  events: StoredRunEvent<TEvent>[]
  afterSequence: number
  timedOut: boolean
  waitedMs: number
}

export const DURABLE_RESULT_STREAM_SCHEMA_VERSION = 'chatbi_result_stream.v1'
export const MAX_DURABLE_RESULT_STREAM_ROWS = 100_000
export const MAX_DURABLE_RESULT_STREAM_BYTES = 32 * 1024 * 1024
export const MAX_DURABLE_RESULT_STREAM_DURATION_MS = 60_000

const minimumResultStreamBytes = 1_024
const minimumResultStreamDurationMs = 100

export interface DurableResultStreamRequest {
  runId: string
  conversationId: string
  actor: ActorContext
  signal?: AbortSignal
  maxRows?: number
  maxBytes?: number
  timeoutMs?: number
}

export interface DurableResultStreamView {
  schemaVersion: typeof DURABLE_RESULT_STREAM_SCHEMA_VERSION
  runId: string
  resultId: string
  totalRows: number
  maxRows: number
  maxBytes: number
  timeoutMs: number
  body: AsyncIterable<string>
}

export interface DurableQueryReadService<TEvent = unknown> {
  getResultPage(request: ResultPageRequest): Promise<ApiEnvelope<ResultPageView>>
  openResultStream(request: DurableResultStreamRequest): Promise<ApiEnvelope<DurableResultStreamView>>
  getRunEvents(request: DurableRunEventsRequest): Promise<ApiEnvelope<DurableRunEventsView<TEvent>>>
}

export interface DurableQueryReadServiceOptions<TEvent = unknown> {
  controlPlane: QueryControlPlane
  resultPageStore: ResultPageStore<TransactionalStoredResultPage, TransactionalResultManifestMetadata>
  publishedPageResolver?: PublishedResultPageResolver<
    TransactionalResultPage,
    TransactionalResultManifestMetadata
  >
  runEventStore: RunEventStore<TEvent>
  eventPollIntervalMs?: number
}

/** Reads only committed control-plane state and published result manifests. */
export function createDurableQueryReadService<TEvent = unknown>(
  options: DurableQueryReadServiceOptions<TEvent>,
): DurableQueryReadService<TEvent> {
  let sequence = 0
  const instanceId = globalThis.crypto?.randomUUID?.().replaceAll('-', '').slice(0, 12)
    ?? Math.random().toString(36).slice(2, 14)

  function ids() {
    sequence += 1
    const suffix = `${instanceId}_${String(sequence).padStart(6, '0')}`
    return { requestId: `req_${suffix}`, traceId: `trace_${suffix}` }
  }

  const publishedPageResolver = options.publishedPageResolver ?? {
    async resolve(input) {
      const page = await options.resultPageStore.getPage(input)
      if (!page) return undefined
      if (!isInlineResultPage(page.payload)) {
        throw new Error('External result page requires an authorized blob resolver')
      }
      return { ...page, payload: page.payload }
    },
  } satisfies PublishedResultPageResolver<
    TransactionalResultPage,
    TransactionalResultManifestMetadata
  >

  async function authorize(
    request: { runId: string; conversationId: string; actor: ActorContext },
    requestId: string,
    traceId: string,
  ) {
    const actorError = validateActor(request.actor)
    if (actorError) return { ok: false as const, envelope: { ok: false as const, requestId, traceId, error: actorError } }
    if (!request.runId || !request.conversationId) {
      return {
        ok: false as const,
        envelope: failure<never>(requestId, traceId, 'VALIDATION_FAILED', '缺少运行 ID 或会话 ID', 'durable_read_contract'),
      }
    }
    const scope = { tenantId: request.actor.tenantId, workspaceId: request.actor.workspaceId }
    const stored = await options.controlPlane.getRun({ ...scope, runId: request.runId })
    if (!stored) {
      return {
        ok: false as const,
        envelope: failure<never>(requestId, traceId, 'SEMANTIC_NOT_FOUND', '没有找到对应运行记录', `run_${request.runId}`),
      }
    }
    if (stored.run.conversationId !== request.conversationId) {
      return {
        ok: false as const,
        envelope: failure<never>(requestId, traceId, 'PERMISSION_DENIED', '无权访问该内容', 'durable_run_boundary'),
      }
    }
    const conversation = await options.controlPlane.getConversation({
      ...scope,
      conversationId: request.conversationId,
    })
    if (!conversation || conversation.businessDomainId !== request.actor.businessDomainId) {
      return {
        ok: false as const,
        envelope: failure<never>(requestId, traceId, 'PERMISSION_DENIED', '无权访问该内容', 'durable_conversation_boundary'),
      }
    }
    return { ok: true as const, scope, stored }
  }

  return {
    async getResultPage(request) {
      const { requestId, traceId } = ids()
      const offset = parseOffset(request.cursor)
      const limit = normalizeLimit(request.limit)
      if (offset === undefined || limit === undefined) {
        return failure(
          requestId,
          traceId,
          'VALIDATION_FAILED',
          '结果分页参数无效，cursor 必须形如 offset:0，limit 必须为 1-500 的整数。',
          `result_page_${request.runId}`,
        )
      }
      try {
        const authorized = await authorize(request, requestId, traceId)
        if (!authorized.ok) return authorized.envelope
        const manifest = await options.resultPageStore.getManifest({ ...authorized.scope, runId: request.runId })
        if (!manifest || authorized.stored.run.displayStatus !== 'completed' || !authorized.stored.run.result) {
          return failure(
            requestId,
            traceId,
            'SEMANTIC_NOT_FOUND',
            '该运行尚无已发布的分页结果',
            `result_${request.runId}`,
          )
        }
        assertManifestMetadata(manifest.metadata)
        if (
          manifest.resultId !== authorized.stored.run.result.id
          || manifest.metadata.semanticVersion !== authorized.stored.run.semanticVersion
          || manifest.pageCount !== Math.ceil(manifest.totalRows / manifest.metadata.pageSize)
          || manifest.pageChecksums.length !== manifest.pageCount
        ) {
          throw new Error('published result manifest is inconsistent with its Run')
        }

        const endOffset = Math.min(manifest.totalRows, offset + limit)
        const firstPageIndex = Math.floor(offset / manifest.metadata.pageSize)
        const lastPageIndex = endOffset > offset
          ? Math.floor((endOffset - 1) / manifest.metadata.pageSize)
          : firstPageIndex - 1
        const intersectingRows: TransactionalResultPage['rows'] = []
        for (let pageIndex = firstPageIndex; pageIndex <= lastPageIndex; pageIndex += 1) {
          const page = await publishedPageResolver.resolve({
            ...authorized.scope,
            runId: request.runId,
            pageIndex,
            manifest,
          })
          const expectedRowCount = Math.min(
            manifest.metadata.pageSize,
            manifest.totalRows - pageIndex * manifest.metadata.pageSize,
          )
          if (
            !page
            || page.resultId !== manifest.resultId
            || page.manifestChecksum !== manifest.manifestChecksum
            || page.attempt !== manifest.attempt
            || page.pageIndex !== pageIndex
            || page.checksum !== manifest.pageChecksums[pageIndex]
            || page.rowCount !== expectedRowCount
            || !Array.isArray(page.payload.rows)
            || page.payload.rows.length !== page.rowCount
            || JSON.stringify(page.payload.columns) !== JSON.stringify(manifest.metadata.columns)
          ) {
            throw new Error('published result page is missing or inconsistent')
          }
          intersectingRows.push(...page.payload.rows)
        }

        const offsetWithinFirstPage = offset - firstPageIndex * manifest.metadata.pageSize
        const rows = intersectingRows.slice(offsetWithinFirstPage, offsetWithinFirstPage + limit)
        const nextOffset = offset + rows.length
        const hasMore = nextOffset < manifest.totalRows
        const permissionDigest = authorized.stored.queryExecution?.permissionDigest
          ?? `perm_${authorized.stored.run.tenantId}_${authorized.stored.run.workspaceId}_${authorized.stored.run.semanticVersion}`
        const responseRequestId = authorized.stored.requestId
        const responseTraceId = authorized.stored.traceId
        return {
          ok: true,
          requestId: responseRequestId,
          traceId: responseTraceId,
          data: {
            contractVersion: CONTRACT_VERSION,
            requestId: responseRequestId,
            traceId: responseTraceId,
            runId: authorized.stored.run.id,
            conversationId: authorized.stored.run.conversationId,
            resultId: manifest.resultId,
            semanticVersion: authorized.stored.run.semanticVersion,
            columns: structuredClone(manifest.metadata.columns),
            rows: structuredClone(rows),
            page: {
              limit,
              cursor: request.cursor,
              nextCursor: hasMore ? `offset:${nextOffset}` : undefined,
              hasMore,
              totalRows: manifest.totalRows,
            },
            completeness: manifest.metadata.completeness,
            warnings: [...manifest.metadata.warnings],
            freshnessAt: manifest.metadata.freshnessAt,
            queryExecution: structuredClone(authorized.stored.queryExecution),
            permissionDigest,
            policyVersion: request.actor.policyVersion ?? 'policy_current',
            rawSqlExposed: false,
            rawDatabaseCredentialsExposed: false,
            audit: structuredClone(authorized.stored.audit),
          },
        }
      } catch {
        return failure(
          requestId,
          traceId,
          'INTERNAL_ERROR',
          '已发布结果暂时不可用，请稍后重试',
          `durable_result_read_${request.runId}`,
          true,
        )
      }
    },

    async openResultStream(request) {
      const { requestId, traceId } = ids()
      const maxRows = normalizeStreamRows(request.maxRows)
      const maxBytes = normalizeStreamBytes(request.maxBytes)
      const timeoutMs = normalizeStreamDuration(request.timeoutMs)
      if (maxRows === undefined || maxBytes === undefined || timeoutMs === undefined) {
        return failure(
          requestId,
          traceId,
          'VALIDATION_FAILED',
          `流式结果预算无效：max_rows 必须为 1-${MAX_DURABLE_RESULT_STREAM_ROWS}，max_bytes 必须为 ${minimumResultStreamBytes}-${MAX_DURABLE_RESULT_STREAM_BYTES}，timeout_ms 必须为 ${minimumResultStreamDurationMs}-${MAX_DURABLE_RESULT_STREAM_DURATION_MS}。`,
          `result_stream_budget_${request.runId}`,
        )
      }

      const boundary = createResultStreamBoundary(request.signal, timeoutMs)
      try {
        assertResultStreamActive(boundary)
        const authorized = await raceResultStreamBoundary(
          authorize(request, requestId, traceId),
          boundary,
        )
        if (!authorized.ok) {
          boundary.dispose()
          return authorized.envelope
        }
        assertResultStreamActive(boundary)
        const manifest = await raceResultStreamBoundary(
          Promise.resolve(options.resultPageStore.getManifest({
            ...authorized.scope,
            runId: request.runId,
            signal: boundary.signal,
            timeoutMs: boundary.remainingMs(),
          })),
          boundary,
        )
        if (!manifest || authorized.stored.run.displayStatus !== 'completed' || !authorized.stored.run.result) {
          boundary.dispose()
          return failure(
            requestId,
            traceId,
            'SEMANTIC_NOT_FOUND',
            '该运行尚无可流式读取的已发布结果',
            `result_stream_${request.runId}`,
          )
        }
        assertPublishedStreamManifest(manifest, authorized.stored)
        if (manifest.totalRows > maxRows) {
          boundary.dispose()
          return failure(
            requestId,
            traceId,
            'QUERY_TOO_EXPENSIVE',
            '已发布结果超过本次流式读取的行数预算',
            `result_stream_rows_${request.runId}`,
          )
        }

        return {
          ok: true,
          requestId,
          traceId,
          data: {
            schemaVersion: DURABLE_RESULT_STREAM_SCHEMA_VERSION,
            runId: request.runId,
            resultId: manifest.resultId,
            totalRows: manifest.totalRows,
            maxRows,
            maxBytes,
            timeoutMs,
            body: streamPublishedResultNdjson({
              scope: authorized.scope,
              stored: authorized.stored,
              manifest,
              resolver: publishedPageResolver,
              boundary,
              externalSignal: request.signal,
              maxBytes,
            }),
          },
        }
      } catch (error) {
        boundary.dispose()
        if (error instanceof ResultStreamAbortedError && request.signal?.aborted) {
          return failure(
            requestId,
            traceId,
            'RUN_CANCELLED',
            '结果流已因客户端断开而结束',
            `result_stream_aborted_${request.runId}`,
          )
        }
        return failure(
          requestId,
          traceId,
          'INTERNAL_ERROR',
          '已发布结果流暂时不可用，请稍后重试',
          `durable_result_stream_${request.runId}`,
          true,
        )
      }
    },

    async getRunEvents(request) {
      const { requestId, traceId } = ids()
      const afterSequence = parseSequence(request.afterSequence)
      const limit = normalizeEventLimit(request.limit)
      const waitMs = normalizeEventWait(request.waitMs)
      if (afterSequence === undefined || limit === undefined || waitMs === undefined) {
        return failure(
          requestId,
          traceId,
          'VALIDATION_FAILED',
          `Last-Event-ID 必须为非负整数，event limit 必须为 1-1000，wait_ms 必须为 0-${MAX_DURABLE_EVENT_WAIT_MS} 的整数。`,
          `event_cursor_${request.runId}`,
        )
      }
      try {
        const authorized = await authorize(request, requestId, traceId)
        if (!authorized.ok) return authorized.envelope
        const polled = await longPollDurableEvents({
          store: options.runEventStore,
          tenantId: authorized.scope.tenantId,
          workspaceId: authorized.scope.workspaceId,
          runId: request.runId,
          afterSequence,
          limit,
          waitMs,
          signal: request.signal,
          pollIntervalMs: options.eventPollIntervalMs ?? DEFAULT_DURABLE_EVENT_POLL_INTERVAL_MS,
        })
        return {
          ok: true,
          requestId,
          traceId,
          data: {
            runId: request.runId,
            conversationId: request.conversationId,
            events: structuredClone(polled.events),
            afterSequence,
            timedOut: polled.timedOut,
            waitedMs: polled.waitedMs,
          },
        }
      } catch (error) {
        if (error instanceof DurableEventPollAbortedError) {
          return failure(
            requestId,
            traceId,
            'RUN_CANCELLED',
            '事件等待已因客户端断开而结束',
            `event_stream_aborted_${request.runId}`,
          )
        }
        return failure(
          requestId,
          traceId,
          'INTERNAL_ERROR',
          '运行事件暂时不可用，请稍后重试',
          `durable_event_read_${request.runId}`,
          true,
        )
      }
    },
  }
}

interface ResultStreamBoundary {
  signal: AbortSignal
  timedOut(): boolean
  remainingMs(): number
  dispose(): void
}

class ResultStreamAbortedError extends Error {
  constructor() {
    super('result stream aborted')
    this.name = 'ResultStreamAbortedError'
  }
}

class ResultStreamIntegrityError extends Error {
  constructor() {
    super('published result integrity check failed')
    this.name = 'ResultStreamIntegrityError'
  }
}

class ResultStreamBudgetError extends Error {
  constructor() {
    super('result stream byte budget exceeded')
    this.name = 'ResultStreamBudgetError'
  }
}

function createResultStreamBoundary(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): ResultStreamBoundary {
  const controller = new AbortController()
  const startedAt = Date.now()
  let timeoutReached = false
  let disposed = false
  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  if (externalSignal?.aborted) onExternalAbort()
  const timeout = setTimeout(() => {
    timeoutReached = true
    controller.abort()
  }, timeoutMs)
  timeout.unref?.()
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    remainingMs: () => Math.max(1, timeoutMs - (Date.now() - startedAt)),
    dispose() {
      if (disposed) return
      disposed = true
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

function assertResultStreamActive(boundary: ResultStreamBoundary) {
  if (boundary.signal.aborted || boundary.remainingMs() <= 0) {
    throw new ResultStreamAbortedError()
  }
}

function raceResultStreamBoundary<T>(
  operation: Promise<T>,
  boundary: ResultStreamBoundary,
): Promise<T> {
  if (boundary.signal.aborted) return Promise.reject(new ResultStreamAbortedError())
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      boundary.signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = () => finish(() => reject(new ResultStreamAbortedError()))
    boundary.signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    )
    if (boundary.signal.aborted) onAbort()
  })
}

interface StreamPublishedResultInput {
  scope: { tenantId: string; workspaceId: string }
  stored: StoredRunRecord
  manifest: PublishedResultManifest<TransactionalResultManifestMetadata>
  resolver: PublishedResultPageResolver<
    TransactionalResultPage,
    TransactionalResultManifestMetadata
  >
  boundary: ResultStreamBoundary
  externalSignal?: AbortSignal
  maxBytes: number
}

async function* streamPublishedResultNdjson(
  input: StreamPublishedResultInput,
): AsyncGenerator<string> {
  const encoder = new TextEncoder()
  let bytesWritten = 0
  let rowsWritten = 0
  const line = (record: unknown) => {
    const serialized = `${JSON.stringify(record)}\n`
    const bytes = encoder.encode(serialized).byteLength
    if (bytesWritten + bytes > input.maxBytes) throw new ResultStreamBudgetError()
    bytesWritten += bytes
    return serialized
  }

  try {
    assertResultStreamActive(input.boundary)
    yield line({
      type: 'manifest',
      schemaVersion: DURABLE_RESULT_STREAM_SCHEMA_VERSION,
      runId: input.manifest.runId,
      resultId: input.manifest.resultId,
      attempt: input.manifest.attempt,
      semanticVersion: input.manifest.metadata.semanticVersion,
      columns: input.manifest.metadata.columns,
      totalRows: input.manifest.totalRows,
      completeness: input.manifest.metadata.completeness,
      warnings: input.manifest.metadata.warnings,
      publishedAt: input.manifest.publishedAt,
    })

    for (let pageIndex = 0; pageIndex < input.manifest.pageCount; pageIndex += 1) {
      assertResultStreamActive(input.boundary)
      const page = await raceResultStreamBoundary(
        Promise.resolve(input.resolver.resolve({
          ...input.scope,
          runId: input.manifest.runId,
          pageIndex,
          manifest: input.manifest,
          signal: input.boundary.signal,
          timeoutMs: input.boundary.remainingMs(),
        })),
        input.boundary,
      )
      assertPublishedStreamPage(page, input.manifest, input.scope, pageIndex)
      for (const row of page.payload.rows) {
        assertResultStreamActive(input.boundary)
        assertPlainJsonValue(row)
        yield line({
          type: 'row',
          schemaVersion: DURABLE_RESULT_STREAM_SCHEMA_VERSION,
          index: rowsWritten,
          row,
        })
        rowsWritten += 1
      }
    }
    if (rowsWritten !== input.manifest.totalRows) throw new ResultStreamIntegrityError()
    yield line({
      type: 'complete',
      schemaVersion: DURABLE_RESULT_STREAM_SCHEMA_VERSION,
      rowCount: rowsWritten,
      payloadBytes: bytesWritten,
    })
  } catch (error) {
    if (input.externalSignal?.aborted) return
    const code = input.boundary.timedOut()
      ? 'RESULT_STREAM_TIMEOUT'
      : error instanceof ResultStreamBudgetError
        ? 'RESULT_STREAM_BYTE_BUDGET_EXCEEDED'
        : error instanceof ResultStreamIntegrityError
          ? 'RESULT_STREAM_INTEGRITY_FAILED'
          : 'RESULT_STREAM_UNAVAILABLE'
    try {
      yield line({
        type: 'error',
        schemaVersion: DURABLE_RESULT_STREAM_SCHEMA_VERSION,
        error: { code, retryable: code !== 'RESULT_STREAM_INTEGRITY_FAILED' },
      })
    } catch {
      // The byte budget is absolute; do not exceed it to report its own failure.
    }
  } finally {
    input.boundary.dispose()
  }
}

function assertPublishedStreamManifest(
  manifest: PublishedResultManifest<TransactionalResultManifestMetadata>,
  stored: StoredRunRecord,
) {
  assertManifestMetadata(manifest.metadata)
  if (
    !stored.run.result
    || manifest.tenantId !== stored.run.tenantId
    || manifest.workspaceId !== stored.run.workspaceId
    || manifest.runId !== stored.run.id
    || manifest.resultId !== stored.run.result.id
    || manifest.metadata.semanticVersion !== stored.run.semanticVersion
    || !Number.isSafeInteger(manifest.attempt)
    || manifest.attempt < 1
    || !Number.isSafeInteger(manifest.totalRows)
    || manifest.totalRows < 0
    || manifest.pageCount !== Math.ceil(manifest.totalRows / manifest.metadata.pageSize)
    || manifest.pageChecksums.length !== manifest.pageCount
    || manifest.pageChecksums.some((checksum) => !/^sha256:[0-9a-f]{64}$/.test(checksum))
  ) {
    throw new ResultStreamIntegrityError()
  }
  assertPlainJsonValue(manifest.metadata)
  const checksum = sha256({
    runId: manifest.runId,
    attempt: manifest.attempt,
    resultId: manifest.resultId,
    pageChecksums: manifest.pageChecksums,
    totalRows: manifest.totalRows,
    metadata: manifest.metadata,
  })
  if (manifest.manifestChecksum !== checksum) throw new ResultStreamIntegrityError()
}

function assertPublishedStreamPage(
  page: PublishedResultPage<TransactionalResultPage> | undefined,
  manifest: PublishedResultManifest<TransactionalResultManifestMetadata>,
  scope: { tenantId: string; workspaceId: string },
  pageIndex: number,
): asserts page is PublishedResultPage<TransactionalResultPage> {
  const expectedRowCount = Math.min(
    manifest.metadata.pageSize,
    manifest.totalRows - pageIndex * manifest.metadata.pageSize,
  )
  if (
    !page
    || page.tenantId !== scope.tenantId
    || page.workspaceId !== scope.workspaceId
    || page.runId !== manifest.runId
    || page.resultId !== manifest.resultId
    || page.manifestChecksum !== manifest.manifestChecksum
    || page.attempt !== manifest.attempt
    || page.pageIndex !== pageIndex
    || page.checksum !== manifest.pageChecksums[pageIndex]
    || page.rowCount !== expectedRowCount
    || !isPlainObject(page.payload)
    || !Array.isArray(page.payload.rows)
    || page.payload.rows.length !== page.rowCount
    || !Array.isArray(page.payload.columns)
    || stableStringify(page.payload.columns) !== stableStringify(manifest.metadata.columns)
  ) {
    throw new ResultStreamIntegrityError()
  }
  assertPlainJsonValue(page.payload)
  const checksum = sha256({
    runId: manifest.runId,
    attempt: manifest.attempt,
    pageIndex,
    payload: page.payload,
  })
  if (page.checksum !== checksum) throw new ResultStreamIntegrityError()
}

function assertPlainJsonValue(value: unknown) {
  const seen = new Set<object>()
  let nodes = 0
  const visit = (candidate: unknown) => {
    nodes += 1
    if (nodes > 1_000_000) throw new ResultStreamIntegrityError()
    if (
      candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
      || (typeof candidate === 'number' && Number.isFinite(candidate))
    ) return
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      throw new ResultStreamIntegrityError()
    }
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      seen.delete(candidate)
      return
    }
    if (!isPlainObject(candidate)) throw new ResultStreamIntegrityError()
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(candidate))) {
      if (!('value' in descriptor) || descriptor.enumerable !== true) {
        throw new ResultStreamIntegrityError()
      }
      visit(descriptor.value)
    }
    seen.delete(candidate)
  }
  visit(value)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sha256(value: unknown) {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')}`
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

function normalizeStreamRows(value?: number) {
  if (value === undefined) return MAX_DURABLE_RESULT_STREAM_ROWS
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DURABLE_RESULT_STREAM_ROWS
    ? value
    : undefined
}

function normalizeStreamBytes(value?: number) {
  if (value === undefined) return MAX_DURABLE_RESULT_STREAM_BYTES
  return Number.isSafeInteger(value)
    && value >= minimumResultStreamBytes
    && value <= MAX_DURABLE_RESULT_STREAM_BYTES
    ? value
    : undefined
}

function normalizeStreamDuration(value?: number) {
  if (value === undefined) return MAX_DURABLE_RESULT_STREAM_DURATION_MS
  return Number.isSafeInteger(value)
    && value >= minimumResultStreamDurationMs
    && value <= MAX_DURABLE_RESULT_STREAM_DURATION_MS
    ? value
    : undefined
}

function parseOffset(cursor?: string): number | undefined {
  if (!cursor) return 0
  const match = cursor.match(/^offset:(\d+)$/)
  if (!match) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) return 50
  return Number.isInteger(limit) && limit >= 1 && limit <= 500 ? limit : undefined
}

function parseSequence(value?: string): number | undefined {
  if (!value) return 0
  if (!/^\d+$/.test(value)) return undefined
  const sequence = Number(value)
  return Number.isSafeInteger(sequence) ? sequence : undefined
}

function normalizeEventLimit(limit?: number): number | undefined {
  if (limit === undefined) return 100
  return Number.isInteger(limit) && limit >= 1 && limit <= 1000 ? limit : undefined
}

function normalizeEventWait(waitMs?: number): number | undefined {
  if (waitMs === undefined) return DEFAULT_DURABLE_EVENT_WAIT_MS
  return Number.isInteger(waitMs) && waitMs >= 0 && waitMs <= MAX_DURABLE_EVENT_WAIT_MS ? waitMs : undefined
}

function assertManifestMetadata(metadata: TransactionalResultManifestMetadata): void {
  const validStorage = metadata.schemaVersion === 'chatbi_result_manifest.v1'
    ? metadata.pageStorage === undefined || (
      metadata.pageStorage.type === 'inline'
      && metadata.pageStorage.encoding === 'canonical-json'
      && metadata.pageStorage.contentType === 'application/vnd.insightflow.result-page+json'
    )
    : metadata.schemaVersion === 'chatbi_result_manifest.v2'
      && metadata.pageStorage?.type === 's3'
      && metadata.pageStorage.encoding === 'canonical-json'
      && metadata.pageStorage.contentType === 'application/vnd.insightflow.result-page+json'
  if (
    !validStorage
    || !Number.isInteger(metadata.pageSize)
    || metadata.pageSize < 1
    || metadata.pageSize > 10_000
    || !Array.isArray(metadata.columns)
    || !Array.isArray(metadata.warnings)
    || !Number.isFinite(Date.parse(metadata.freshnessAt))
    || !metadata.semanticVersion
    || !['full', 'partial'].includes(metadata.completeness)
  ) {
    throw new Error('published result manifest metadata is invalid')
  }
}

function isInlineResultPage(
  payload: TransactionalStoredResultPage,
): payload is TransactionalResultPage {
  return Boolean(
    payload
    && typeof payload === 'object'
    && Array.isArray((payload as TransactionalResultPage).columns)
    && Array.isArray((payload as TransactionalResultPage).rows),
  )
}

function failure<T>(
  requestId: string,
  traceId: string,
  code: PublicErrorCode,
  message: string,
  debugReference: string,
  retryable = false,
): ApiEnvelope<T> {
  return {
    ok: false,
    requestId,
    traceId,
    error: { code, message, retryable, debugReference },
  }
}
