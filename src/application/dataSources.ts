import { dataSources } from '../features/data-sources/fixtures'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type DataSourceAuditEvent,
  type DataSourceConnectionTestResult,
  type DataSourceView,
  type GetDataSourceRequest,
  type ListDataSourcesRequest,
  type PublicApiError,
  type TestDataSourceConnectionRequest,
} from '../contracts'

export interface DataSourceApplicationService {
  listDataSources(request: ListDataSourcesRequest): ApiEnvelope<{ items: DataSourceView[]; total: number }>
  getDataSource(request: GetDataSourceRequest): ApiEnvelope<DataSourceView>
  testConnection(request: TestDataSourceConnectionRequest): ApiEnvelope<DataSourceConnectionTestResult>
}

export interface DataSourceApplicationOptions {
  now?: () => string
}

export function createDataSourceApplicationService(options: DataSourceApplicationOptions = {}): DataSourceApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const sources = dataSources.map((source) => ({
    ...source,
    qualityGates: source.qualityGates.map((gate) => ({ ...gate })),
    syncEvents: source.syncEvents.map((event) => ({ ...event })),
    tables: source.tables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({ ...column })),
    })),
  }))
  const auditEvents = new Map<string, DataSourceAuditEvent[]>()

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
  }

  function requestIds() {
    return { requestId: nextId('req'), traceId: nextId('trace') }
  }

  function success<T>(data: T): ApiEnvelope<T> {
    return { ok: true, ...requestIds(), data }
  }

  function failure(error: PublicApiError): ApiEnvelope<never> {
    return { ok: false, ...requestIds(), error }
  }

  function invalidActor(request: { actor: ListDataSourcesRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function notFound(dataSourceId: string): PublicApiError {
    return {
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可访问的数据源',
      retryable: false,
      debugReference: `data_source_${dataSourceId}`,
    }
  }

  function canSeeSource(source: typeof sources[number], request: { actor: ListDataSourcesRequest['actor'] }) {
    if (source.businessDomain === '销售经营' && request.actor.businessDomainId !== 'sales') return false
    if (source.status === 'draft') return request.actor.roles.some((role) => ['data_admin', 'platform_ops'].includes(role))
    return true
  }

  function findVisible(dataSourceId: string, request: { actor: ListDataSourcesRequest['actor'] }) {
    const source = sources.find((candidate) => candidate.id === dataSourceId)
    if (!source || !canSeeSource(source, request)) return undefined
    return source
  }

  function audit(
    type: DataSourceAuditEvent['type'],
    request: { actor: ListDataSourcesRequest['actor'] },
    dataSourceId: string,
    summary: string,
  ) {
    const event: DataSourceAuditEvent = {
      id: nextId('ds_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      dataSourceId,
      summary,
    }
    const existing = auditEvents.get(dataSourceId) ?? []
    auditEvents.set(dataSourceId, [...existing, event])
    return event
  }

  function view(source: typeof sources[number]): DataSourceView {
    const hasBlockingGate = source.qualityGates.some((gate) => gate.status === 'fail')
    return {
      contractVersion: CONTRACT_VERSION,
      ...source,
      safetySummary: {
        readOnlyCredential: /只读/.test(source.connection),
        credentialRefOnly: source.credentialRef.startsWith('vault://'),
        restrictedFieldsExcludedFromSamples: source.tables.every((table) => table.columns
          .filter((column) => column.classification === 'restricted')
          .every((column) => /默认不可见|不参与候选值/.test(column.samplePolicy))),
        usableInTrustedMode: source.status === 'healthy' && !hasBlockingGate,
      },
      audit: [
        {
          id: `${source.id}_seed`,
          at: source.lastSyncAt,
          type: 'data_source.metadata_viewed',
          actorUserId: 'system',
          tenantId: 'tenant_demo',
          workspaceId: 'workspace_sales',
          dataSourceId: source.id,
          summary: `最近同步：${source.syncEvents[0]?.summary ?? '暂无同步事件'}`,
        },
        ...(auditEvents.get(source.id) ?? []),
      ],
    }
  }

  return {
    listDataSources(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const needle = request.query?.trim().toLocaleLowerCase('zh-CN')
      const items = sources
        .filter((source) => canSeeSource(source, request))
        .filter((source) => !request.status || request.status === 'all' || source.status === request.status)
        .filter((source) => {
          if (!needle) return true
          return [source.name, source.engine, source.businessDomain, source.owner]
            .some((value) => value.toLocaleLowerCase('zh-CN').includes(needle))
        })
        .map((source) => {
          audit('data_source.listed', request, source.id, '数据源进入当前用户可见列表，已按业务域和状态过滤。')
          return view(source)
        })
      return success({ items, total: items.length })
    },

    getDataSource(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const source = findVisible(request.dataSourceId, request)
      if (!source) return failure(notFound(request.dataSourceId))
      audit('data_source.metadata_viewed', request, source.id, '用户查看数据源元数据目录和字段分类。')
      return success(view(source))
    },

    testConnection(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const source = findVisible(request.dataSourceId, request)
      if (!source) return failure(notFound(request.dataSourceId))
      const failingGate = source.qualityGates.find((gate) => gate.status === 'fail')
      const warningGate = source.qualityGates.find((gate) => gate.status === 'warning')
      const status = failingGate ? 'failed' : warningGate || source.status === 'degraded' || source.status === 'syncing' ? 'warning' : 'passed'
      const latencyMs = Number(source.qualityGates.find((gate) => gate.name === '连通性')?.value.replace('ms', '')) || 250
      audit(
        failingGate ? 'data_source.quality_blocked' : 'data_source.connection_tested',
        request,
        source.id,
        failingGate ? `连接测试被质量门禁阻断：${failingGate.detail}` : `只读连接测试完成，状态 ${status}。`,
      )
      return success({
        dataSourceId: source.id,
        status,
        latencyMs,
        readOnlyCredential: /只读/.test(source.connection),
        credentialRef: source.credentialRef,
        blockedReason: failingGate?.detail,
        audit: auditEvents.get(source.id) ?? [],
      })
    },
  }
}

export function httpStatusForDataSourceEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
