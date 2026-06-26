import { dataSources } from '../features/data-sources/fixtures'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type DataSourceAuditEvent,
  type DataSourceConnectionTestResult,
  type DataSourceLineageView,
  type DataSourceSchemaChangeReview,
  type DataSourceSchemaChangeReviewRequest,
  type DataSourceView,
  type GetDataSourceRequest,
  type GetDataSourceLineageRequest,
  type ListDataSourcesRequest,
  type PublicApiError,
  type TestDataSourceConnectionRequest,
} from '../contracts'

export interface DataSourceApplicationService {
  listDataSources(request: ListDataSourcesRequest): ApiEnvelope<{ items: DataSourceView[]; total: number }>
  getDataSource(request: GetDataSourceRequest): ApiEnvelope<DataSourceView>
  getLineage(request: GetDataSourceLineageRequest): ApiEnvelope<DataSourceLineageView>
  reviewSchemaChange(request: DataSourceSchemaChangeReviewRequest): ApiEnvelope<DataSourceSchemaChangeReview>
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

  function lineageView(source: typeof sources[number]): DataSourceLineageView {
    const restrictedFields = source.tables.flatMap((table) => table.columns)
      .filter((column) => column.classification === 'restricted')
    const downstream = source.id === 'warehouse_sales'
      ? [
          { id: 'metric_net_revenue', type: 'semantic_metric' as const, name: '认证指标：净收入', owner: '指标治理组', criticality: 'p0' as const },
          { id: 'dashboard_sales_exec', type: 'dashboard' as const, name: '经营驾驶舱', owner: '销售运营', criticality: 'p1' as const },
          { id: 'case_revenue_trend', type: 'verified_case' as const, name: '净收入趋势黄金问题', owner: '分析平台', criticality: 'p1' as const },
        ]
      : [
          { id: `${source.id}_quality_dashboard`, type: 'dashboard' as const, name: `${source.businessDomain}质量看板`, owner: source.owner, criticality: 'p2' as const },
        ]

    return {
      contractVersion: CONTRACT_VERSION,
      dataSourceId: source.id,
      upstream: [
        {
          id: `${source.id}_source_system`,
          type: 'source_system',
          name: `${source.engine} 只读源系统`,
          freshness: source.freshness,
        },
        {
          id: `${source.id}_scanner`,
          type: 'ingestion_job',
          name: '元数据扫描任务',
          freshness: source.lastSyncAt,
        },
      ],
      downstream,
      columnLineage: source.tables.flatMap((table) => table.columns.map((column) => ({
        tableId: table.id,
        columnName: column.name,
        upstreamExpression: `${table.name}.${column.name}`,
        downstreamRefs: downstream
          .filter((asset) => column.name === 'net_revenue' || column.name === 'order_date' || asset.criticality !== 'p0')
          .map((asset) => asset.id),
        classification: column.classification,
      }))),
      impactSummary: {
        certifiedMetricsAffected: downstream.filter((asset) => asset.type === 'semantic_metric').length,
        dashboardsAffected: downstream.filter((asset) => asset.type === 'dashboard').length,
        restrictedFields: restrictedFields.length,
        requiresApprovalForSchemaChange: true,
      },
      audit: auditEvents.get(source.id) ?? [],
    }
  }

  function reviewChange(source: typeof sources[number], request: DataSourceSchemaChangeReviewRequest): DataSourceSchemaChangeReview {
    const lineage = lineageView(source)
    const table = source.tables.find((candidate) => candidate.id === request.change.tableId)
    const column = table?.columns.find((candidate) => candidate.name === request.change.columnName)
    const impactedAssets = lineage.columnLineage
      .filter((item) => item.tableId === request.change.tableId && item.columnName === request.change.columnName)
      .flatMap((item) => item.downstreamRefs)
      .map((id) => lineage.downstream.find((asset) => asset.id === id))
      .filter((asset): asset is DataSourceLineageView['downstream'][number] => Boolean(asset))
    const reasons: string[] = []

    if (!table) reasons.push('变更引用的数据表不存在于当前元数据快照。')
    if (request.change.type !== 'add_column' && !column) reasons.push('变更引用的字段不存在于当前元数据快照。')
    if (request.change.type === 'drop_column' && impactedAssets.some((asset) => asset.criticality === 'p0')) {
      reasons.push('删除字段会影响 P0 认证指标或核心答案链路。')
    }
    if (request.change.type === 'change_type' && column?.classification === 'restricted') {
      reasons.push('受限字段类型变更必须进入安全评审。')
    }
    if (!request.change.reason.trim()) reasons.push('Schema 变更必须提供业务原因。')

    const decision: DataSourceSchemaChangeReview['decision'] = reasons.some((reason) => /P0|不存在/.test(reason))
      ? 'blocked'
      : impactedAssets.length > 0 || request.change.type === 'change_type'
        ? 'requires_review'
        : 'approved'

    return {
      contractVersion: CONTRACT_VERSION,
      dataSourceId: source.id,
      changeId: `schema_change_${nextId('chg')}`,
      decision,
      reasons: reasons.length ? reasons : ['Schema 变更未影响认证指标、看板或受限字段，可按低风险变更发布。'],
      impactedAssets,
      requiredApprovers: decision === 'approved' ? [] : ['data_admin', 'metric_admin', 'security_admin'],
      rolloutPlan: {
        requiresBackfill: request.change.type !== 'add_column',
        requiresSemanticReview: impactedAssets.some((asset) => asset.type === 'semantic_metric'),
        safeDeployWindow: 'Asia/Shanghai 22:00-06:00',
      },
      audit: auditEvents.get(source.id) ?? [],
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

    getLineage(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const source = findVisible(request.dataSourceId, request)
      if (!source) return failure(notFound(request.dataSourceId))
      audit('data_source.lineage_viewed', request, source.id, '用户查看字段级血缘和下游影响范围。')
      return success(lineageView(source))
    },

    reviewSchemaChange(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const source = findVisible(request.dataSourceId, request)
      if (!source) return failure(notFound(request.dataSourceId))
      const allowed = request.actor.roles.some((role) => ['data_admin', 'platform_ops'].includes(role))
      if (!allowed) {
        return failure({
          code: 'PERMISSION_DENIED',
          message: '无权评审数据源 Schema 变更',
          retryable: false,
          debugReference: `schema_review_${source.id}`,
        })
      }
      audit('data_source.schema_change_reviewed', request, source.id, `Schema 变更已评估：${request.change.type}/${request.change.tableId}.${request.change.columnName}。`)
      const review = reviewChange(source, request)
      return success(review)
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
