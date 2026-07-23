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
import type { ResultPageStore, RunEventStore, StoredRunEvent } from '../../../src/persistence/resultPorts'
import type {
  TransactionalResultManifestMetadata,
  TransactionalResultPage,
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

export interface DurableQueryReadService<TEvent = unknown> {
  getResultPage(request: ResultPageRequest): Promise<ApiEnvelope<ResultPageView>>
  getRunEvents(request: DurableRunEventsRequest): Promise<ApiEnvelope<DurableRunEventsView<TEvent>>>
}

export interface DurableQueryReadServiceOptions<TEvent = unknown> {
  controlPlane: QueryControlPlane
  resultPageStore: ResultPageStore<TransactionalResultPage, TransactionalResultManifestMetadata>
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
          const page = await options.resultPageStore.getPage({ ...authorized.scope, runId: request.runId, pageIndex })
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
  if (
    metadata?.schemaVersion !== 'chatbi_result_manifest.v1'
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
