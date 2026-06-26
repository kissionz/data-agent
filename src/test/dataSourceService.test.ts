import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createDataSourceApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_data_admin',
  roles: ['data_admin'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const actorHeaders = {
  'x-tenant-id': actor.tenantId,
  'x-workspace-id': actor.workspaceId,
  'x-user-id': actor.userId,
  'x-user-roles': actor.roles.join(','),
  'x-business-domain-id': actor.businessDomainId,
  'x-semantic-version': actor.semanticVersion,
}

describe('Data source service', () => {
  it('lists visible data sources with safe credential and sampling summaries', () => {
    const service = createDataSourceApplicationService({ now: () => '2026-06-24T10:00:00+08:00' })
    const response = service.listDataSources({ actor, status: 'healthy', query: '销售' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.total).toBe(1)
    expect(response.data.items[0]).toMatchObject({
      id: 'warehouse_sales',
      contractVersion: 'chatbi.contracts.v0.2',
      credentialRef: 'vault://prod/snowflake/sales-reader',
      safetySummary: {
        readOnlyCredential: true,
        credentialRefOnly: true,
        restrictedFieldsExcludedFromSamples: true,
        usableInTrustedMode: true,
      },
    })
    expect(JSON.stringify(response.data.items[0])).not.toContain('password')
  })

  it('returns metadata details and writes a public audit event', () => {
    const service = createDataSourceApplicationService({ now: () => '2026-06-24T10:01:00+08:00' })
    const response = service.getDataSource({ actor, dataSourceId: 'warehouse_sales' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data.tables[0].columns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'customer_phone',
        classification: 'restricted',
        samplePolicy: '默认不可见，不参与候选值展示',
      }),
    ]))
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'data_source.metadata_viewed', actorUserId: 'user_data_admin' }),
    ]))
  })

  it('returns field-level lineage and downstream impact before schema changes', () => {
    const service = createDataSourceApplicationService({ now: () => '2026-06-24T10:03:00+08:00' })
    const response = service.getLineage({ actor, dataSourceId: 'warehouse_sales' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      dataSourceId: 'warehouse_sales',
      impactSummary: {
        certifiedMetricsAffected: 1,
        dashboardsAffected: 1,
        restrictedFields: 1,
        requiresApprovalForSchemaChange: true,
      },
    })
    expect(response.data.downstream).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'metric_net_revenue', type: 'semantic_metric', criticality: 'p0' }),
    ]))
    expect(response.data.columnLineage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        columnName: 'net_revenue',
        downstreamRefs: expect.arrayContaining(['metric_net_revenue']),
      }),
    ]))
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'data_source.lineage_viewed' }),
    ]))
  })

  it('blocks schema changes that would break certified metric lineage', () => {
    const service = createDataSourceApplicationService({ now: () => '2026-06-24T10:04:00+08:00' })
    const response = service.reviewSchemaChange({
      actor,
      dataSourceId: 'warehouse_sales',
      change: {
        type: 'drop_column',
        tableId: 'dwd_order_settlement',
        columnName: 'net_revenue',
        reason: '上游字段计划下线',
      },
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      decision: 'blocked',
      rolloutPlan: {
        requiresBackfill: true,
        requiresSemanticReview: true,
      },
    })
    expect(response.data.impactedAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'metric_net_revenue', criticality: 'p0' }),
    ]))
    expect(response.data.reasons.join(' ')).toContain('P0')
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'data_source.schema_change_reviewed' }),
    ]))
  })

  it('approves low-risk additive schema changes and denies non-admin reviewers', () => {
    const service = createDataSourceApplicationService({ now: () => '2026-06-24T10:05:00+08:00' })
    const approved = service.reviewSchemaChange({
      actor,
      dataSourceId: 'warehouse_sales',
      change: {
        type: 'add_column',
        tableId: 'dwd_order_settlement',
        columnName: 'campaign_code',
        newType: 'varchar',
        reason: '补充营销活动维度',
      },
    })
    expect(approved.ok).toBe(true)
    if (!approved.ok) return
    expect(approved.data).toMatchObject({
      decision: 'approved',
      impactedAssets: [],
      requiredApprovers: [],
      rolloutPlan: {
        requiresBackfill: false,
        requiresSemanticReview: false,
      },
    })

    const denied = service.reviewSchemaChange({
      actor: { ...actor, roles: ['business_user'] },
      dataSourceId: 'warehouse_sales',
      change: {
        type: 'add_column',
        tableId: 'dwd_order_settlement',
        columnName: 'campaign_code',
        reason: '普通用户尝试变更',
      },
    })
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error.code).toBe('PERMISSION_DENIED')
  })

  it('tests read-only connections without exposing raw credentials', () => {
    const service = createDataSourceApplicationService({ now: () => '2026-06-24T10:02:00+08:00' })
    const response = service.testConnection({ actor, dataSourceId: 'warehouse_finance' })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.data).toMatchObject({
      dataSourceId: 'warehouse_finance',
      status: 'warning',
      readOnlyCredential: true,
      credentialRef: 'vault://prod/postgres/finance-reader',
    })
    expect(JSON.stringify(response.data)).not.toMatch(/secret|password|token/i)
    expect(response.data.audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'data_source.connection_tested' }),
    ]))
  })

  it('keeps business-domain boundaries on data source reads', () => {
    const service = createDataSourceApplicationService()
    const denied = service.getDataSource({
      actor: { ...actor, businessDomainId: 'finance' },
      dataSourceId: 'warehouse_sales',
    })

    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toMatchObject({
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可访问的数据源',
    })
  })

  it('exposes data source list, details and connection tests through the BFF', () => {
    const router = createChatBiBffRouter()
    const listed = router.handle({
      method: 'GET',
      path: '/v1/data-sources',
      headers: actorHeaders,
      query: { q: '销售', status: 'healthy' },
    })
    expect(listed.status).toBe(200)
    expect(listed.body).toMatchObject({
      ok: true,
      data: {
        total: 1,
        items: [expect.objectContaining({ id: 'warehouse_sales' })],
      },
    })

    const detail = router.handle({
      method: 'GET',
      path: '/v1/data-sources/warehouse_sales',
      headers: actorHeaders,
    })
    expect(detail.status).toBe(200)
    expect(detail.body).toMatchObject({ ok: true, data: { id: 'warehouse_sales', scannedTables: 42 } })

    const connection = router.handle({
      method: 'POST',
      path: '/v1/data-sources/warehouse_sales/test-connection',
      headers: actorHeaders,
    })
    expect(connection.status).toBe(200)
    expect(connection.body).toMatchObject({
      ok: true,
      data: {
        status: 'warning',
        latencyMs: 238,
        readOnlyCredential: true,
      },
    })

    const lineage = router.handle({
      method: 'GET',
      path: '/v1/data-sources/warehouse_sales/lineage',
      headers: actorHeaders,
    })
    expect(lineage.status).toBe(200)
    expect(lineage.body).toMatchObject({
      ok: true,
      data: {
        impactSummary: { certifiedMetricsAffected: 1 },
      },
    })

    const schemaReview = router.handle({
      method: 'POST',
      path: '/v1/data-sources/warehouse_sales/schema-review',
      headers: actorHeaders,
      body: {
        type: 'drop_column',
        table_id: 'dwd_order_settlement',
        column_name: 'net_revenue',
        reason: '测试下线',
      },
    })
    expect(schemaReview.status).toBe(200)
    expect(schemaReview.body).toMatchObject({
      ok: true,
      data: {
        decision: 'blocked',
      },
    })
  })
})
