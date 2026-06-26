import { catalogDimensions, catalogMetrics, joinEdges, type CatalogMetric } from '../semantic'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  validationError,
  type ApiEnvelope,
  type CertifySemanticMetricRequest,
  type GetSemanticMetricRequest,
  type JoinGraphEdgeView,
  type ListSemanticMetricsRequest,
  type PlanSemanticMetricReleaseRequest,
  type PublicApiError,
  type ReconcileSemanticMetricRequest,
  type RollbackSemanticMetricRequest,
  type SemanticDimensionGovernanceView,
  type SemanticGovernanceAuditEvent,
  type SemanticMetricGovernanceView,
  type SemanticMetricReleasePlanView,
  type SemanticReferenceReconciliationView,
  type SubmitSemanticMetricReviewRequest,
} from '../contracts'

export interface SemanticGovernanceApplicationService {
  listMetrics(request: ListSemanticMetricsRequest): ApiEnvelope<{
    metrics: SemanticMetricGovernanceView[]
    dimensions: SemanticDimensionGovernanceView[]
    joinGraph: JoinGraphEdgeView[]
    total: number
  }>
  getMetric(request: GetSemanticMetricRequest): ApiEnvelope<SemanticMetricGovernanceView>
  submitForReview(request: SubmitSemanticMetricReviewRequest): ApiEnvelope<SemanticMetricGovernanceView>
  reconcileReferenceSql(request: ReconcileSemanticMetricRequest): ApiEnvelope<SemanticReferenceReconciliationView>
  certifyMetric(request: CertifySemanticMetricRequest): ApiEnvelope<SemanticMetricGovernanceView>
  planRelease(request: PlanSemanticMetricReleaseRequest): ApiEnvelope<SemanticMetricReleasePlanView>
  rollbackMetric(request: RollbackSemanticMetricRequest): ApiEnvelope<SemanticMetricGovernanceView>
}

export interface SemanticGovernanceApplicationOptions {
  now?: () => string
}

export function createSemanticGovernanceApplicationService(
  options: SemanticGovernanceApplicationOptions = {},
): SemanticGovernanceApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const metrics = catalogMetrics.map((metric) => ({ ...metric, immutableVersion: true, certifiedBy: undefined as string | undefined }))
  const auditEvents = new Map<string, SemanticGovernanceAuditEvent[]>()
  const reconciliations = new Map<string, SemanticReferenceReconciliationView>()
  const releasePlans = new Map<string, SemanticMetricReleasePlanView>()

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

  function invalidActor(request: { actor: ListSemanticMetricsRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function notFound(metricId: string): PublicApiError {
    return {
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可访问的语义指标',
      retryable: false,
      debugReference: `semantic_metric_${metricId}`,
    }
  }

  function canManage(actor: ListSemanticMetricsRequest['actor']) {
    return actor.roles.some((role) => ['metric_admin', 'data_admin', 'platform_ops'].includes(role))
  }

  function canRollback(actor: ListSemanticMetricsRequest['actor']) {
    return actor.roles.some((role) => ['metric_admin', 'platform_ops', 'security_admin'].includes(role))
  }

  function canSee(metric: CatalogMetric, actor: ListSemanticMetricsRequest['actor']) {
    return metric.tenantId === actor.tenantId
      && metric.workspaceId === actor.workspaceId
      && metric.businessDomainId === actor.businessDomainId
      && metric.semanticVersion === actor.semanticVersion
  }

  function findVisible(metricId: string, request: { actor: ListSemanticMetricsRequest['actor'] }) {
    const metric = metrics.find((candidate) => candidate.id === metricId)
    if (!metric || !canSee(metric, request.actor)) return undefined
    return metric
  }

  function audit(
    type: SemanticGovernanceAuditEvent['type'],
    request: { actor: ListSemanticMetricsRequest['actor'] },
    semanticObjectId: string,
    summary: string,
  ) {
    const event: SemanticGovernanceAuditEvent = {
      id: nextId('sem_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      semanticObjectId,
      summary,
    }
    auditEvents.set(semanticObjectId, [...(auditEvents.get(semanticObjectId) ?? []), event])
    return event
  }

  function blockingReasons(metric: typeof metrics[number]) {
    const reasons: string[] = []
    if (metric.lifecycle !== 'review' && metric.lifecycle !== 'certified') reasons.push('指标尚未进入评审或认证状态。')
    if (!metric.immutableVersion) reasons.push('语义版本未锁定。')
    return reasons
  }

  function joinGraphRiskReasons(metric: typeof metrics[number]) {
    const reasons: string[] = []
    const unapprovedJoins = metric.compatibleDimensions
      .map((dimensionId) => catalogDimensions.find((dimension) => dimension.id === dimensionId && dimension.semanticVersion === metric.semanticVersion))
      .filter((dimension): dimension is NonNullable<typeof dimension> => Boolean(dimension?.requiresJoin))
      .map((dimension) => joinEdges.find((edge) => edge.id === dimension.requiresJoin))
      .filter((edge): edge is NonNullable<typeof edge> => Boolean(edge))
      .filter((edge) => !edge.approved || edge.risk === 'high' || edge.cardinality === 'many_to_many')
    if (unapprovedJoins.length > 0) reasons.push(`Join Graph 存在未批准或高风险路径：${unapprovedJoins.map((edge) => edge.id).join(', ')}。`)
    return reasons
  }

  function view(metric: typeof metrics[number]): SemanticMetricGovernanceView {
    const reasons = blockingReasons(metric)
    const joinReasons = joinGraphRiskReasons(metric)
    const reconciliation = reconciliations.get(metric.id)
    const releasePlan = releasePlans.get(metric.id)
    return {
      contractVersion: CONTRACT_VERSION,
      id: metric.id,
      name: metric.name,
      businessDomainId: metric.businessDomainId,
      semanticVersion: metric.semanticVersion,
      lifecycle: metric.lifecycle,
      expression: metric.expression,
      sourceTable: metric.sourceTable,
      supportedGrains: metric.supportedGrains,
      compatibleDimensions: metric.compatibleDimensions,
      immutableVersion: metric.immutableVersion,
      canUseInTrustedMode: metric.lifecycle === 'certified',
      releaseReadiness: {
        referenceSqlReconciled: metric.lifecycle === 'certified' || reconciliation?.status === 'passed',
        approvedJoinGraph: joinReasons.length === 0,
        certifiedBy: metric.certifiedBy,
        blockingReasons: [...reasons, ...joinReasons],
        reconciliation: reconciliation
          ? {
              status: reconciliation.status,
              maxDeltaPct: reconciliation.maxDeltaPct,
              comparedRows: reconciliation.comparedRows,
              tolerancePct: reconciliation.tolerancePct,
            }
          : { status: 'not_run' },
        releasePlan: releasePlan
          ? {
              status: releasePlan.status,
              rolloutPercentages: releasePlan.stages.map((stage) => stage.percentage),
              rollbackThresholds: releasePlan.automaticRollback.rollbackThresholds,
            }
          : {
              status: 'not_planned',
              rolloutPercentages: [],
              rollbackThresholds: [],
            },
      },
      audit: auditEvents.get(metric.id) ?? [],
    }
  }

  function rolloutPercentages(request: PlanSemanticMetricReleaseRequest) {
    const percentages = request.rolloutPercentages && request.rolloutPercentages.length > 0
      ? request.rolloutPercentages
      : [5, 20, 50, 100]
    const invalid = percentages.some((percentage) => percentage <= 0 || percentage > 100)
    if (invalid) return undefined
    return percentages
  }

  function dimensions(actor: ListSemanticMetricsRequest['actor']): SemanticDimensionGovernanceView[] {
    return catalogDimensions
      .filter((dimension) => dimension.tenantId === actor.tenantId
        && dimension.workspaceId === actor.workspaceId
        && dimension.businessDomainId === actor.businessDomainId
        && dimension.semanticVersion === actor.semanticVersion)
      .map((dimension) => ({
        id: dimension.id,
        name: dimension.name,
        semanticVersion: dimension.semanticVersion,
        lifecycle: dimension.lifecycle,
        requiresJoin: dimension.requiresJoin,
      }))
  }

  function joinGraph(): JoinGraphEdgeView[] {
    return joinEdges.map((edge) => ({
      id: edge.id,
      leftTable: edge.leftTable,
      rightTable: edge.rightTable,
      cardinality: edge.cardinality,
      direction: edge.direction,
      risk: edge.risk,
      approved: edge.approved,
    }))
  }

  return {
    listMetrics(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const needle = request.query?.trim().toLowerCase()
      const visible = metrics
        .filter((metric) => canSee(metric, request.actor))
        .filter((metric) => !request.lifecycle || request.lifecycle === 'all' || metric.lifecycle === request.lifecycle)
        .filter((metric) => {
          if (!needle) return true
          return [metric.id, metric.name, metric.expression, metric.sourceTable].some((value) => value.toLowerCase().includes(needle))
        })
      for (const metric of visible) {
        audit('semantic.metric_listed', request, metric.id, '语义指标进入当前用户可见列表。')
      }
      return success({
        metrics: visible.map((metric) => view(metric)),
        dimensions: dimensions(request.actor),
        joinGraph: joinGraph(),
        total: visible.length,
      })
    },

    getMetric(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const metric = findVisible(request.metricId, request)
      if (!metric) return failure(notFound(request.metricId))
      audit('semantic.metric_viewed', request, metric.id, '用户查看语义指标详情与发布就绪状态。')
      return success(view(metric))
    },

    submitForReview(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManage(request.actor)) return failure({ code: 'PERMISSION_DENIED', message: '无权提交语义指标评审', retryable: false, debugReference: 'semantic_review_role' })
      const metric = findVisible(request.metricId, request)
      if (!metric) return failure(notFound(request.metricId))
      if (metric.lifecycle !== 'draft') return failure(validationError('只有草稿指标可以提交评审'))
      metric.lifecycle = 'review'
      audit('semantic.metric_submitted', request, metric.id, `指标提交评审：${request.note || '无备注'}。`)
      return success(view(metric))
    },

    reconcileReferenceSql(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManage(request.actor)) return failure({ code: 'PERMISSION_DENIED', message: '无权执行参考 SQL 对账', retryable: false, debugReference: 'semantic_reconcile_role' })
      const metric = findVisible(request.metricId, request)
      if (!metric) return failure(notFound(request.metricId))
      if (request.tolerancePct < 0 || request.comparedRows < 1 || request.maxDeltaPct < 0) return failure(validationError('对账容差、样本行数和最大偏差必须有效'))
      const passed = request.maxDeltaPct <= request.tolerancePct
      audit(
        passed ? 'semantic.reference_reconciled' : 'semantic.release_blocked',
        request,
        metric.id,
        passed
          ? `参考 SQL 自动对账通过：${request.comparedRows} 行，最大偏差 ${request.maxDeltaPct}%。`
          : `参考 SQL 自动对账失败：最大偏差 ${request.maxDeltaPct}% 超过容差 ${request.tolerancePct}%。`,
      )
      const result: SemanticReferenceReconciliationView = {
        contractVersion: CONTRACT_VERSION,
        metricId: metric.id,
        status: passed ? 'passed' : 'failed',
        referenceSqlFingerprint: request.referenceSqlFingerprint,
        compiledSqlFingerprint: request.compiledSqlFingerprint,
        tolerancePct: request.tolerancePct,
        comparedRows: request.comparedRows,
        maxDeltaPct: request.maxDeltaPct,
        blocksCertification: !passed,
        audit: auditEvents.get(metric.id) ?? [],
      }
      reconciliations.set(metric.id, result)
      return success(result)
    },

    certifyMetric(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManage(request.actor)) return failure({ code: 'PERMISSION_DENIED', message: '无权认证语义指标', retryable: false, debugReference: 'semantic_certify_role' })
      const metric = findVisible(request.metricId, request)
      if (!metric) return failure(notFound(request.metricId))
      if (metric.lifecycle !== 'review') return failure(validationError('只有评审中的指标可以认证'))
      const reconciliationPassed = reconciliations.get(metric.id)?.status === 'passed'
      if (!request.referenceSqlReconciled && !reconciliationPassed) {
        audit('semantic.release_blocked', request, metric.id, '参考 SQL 对账未通过，认证发布被阻断。')
        return failure({
          code: 'VALIDATION_FAILED',
          message: '参考 SQL 对账未通过，不能认证发布',
          retryable: true,
          debugReference: `semantic_reconcile_${metric.id}`,
        })
      }
      const joinBlockingReason = joinGraphRiskReasons(metric).find((reason) => reason.includes('Join Graph'))
      if (joinBlockingReason) {
        audit('semantic.release_blocked', request, metric.id, joinBlockingReason)
        return failure({
          code: 'VALIDATION_FAILED',
          message: 'Join Graph 未批准或风险过高，不能认证发布',
          retryable: true,
          debugReference: `semantic_join_${metric.id}`,
        })
      }
      metric.lifecycle = 'certified'
      metric.certifiedBy = request.actor.userId
      audit('semantic.metric_certified', request, metric.id, `指标已认证发布：${request.note || '无备注'}。`)
      return success(view(metric))
    },

    planRelease(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canManage(request.actor)) return failure({ code: 'PERMISSION_DENIED', message: '无权规划语义灰度发布', retryable: false, debugReference: 'semantic_release_role' })
      const metric = findVisible(request.metricId, request)
      if (!metric) return failure(notFound(request.metricId))
      if (metric.lifecycle !== 'certified') return failure(validationError('只有已认证指标可以规划灰度发布'))
      const percentages = rolloutPercentages(request)
      if (!percentages) return failure(validationError('灰度百分比必须在 1 到 100 之间'))
      const plan: SemanticMetricReleasePlanView = {
        contractVersion: CONTRACT_VERSION,
        metricId: metric.id,
        currentSemanticVersion: metric.semanticVersion,
        targetSemanticVersion: `${metric.semanticVersion}+${metric.id}.release`,
        status: 'planned',
        stages: percentages.map((percentage, index) => ({
          percentage,
          gate: index === 0
            ? 'offline_eval'
            : index === 1
              ? 'shadow_traffic'
              : percentage < 100
                ? 'tenant_canary'
                : 'business_cycle_observation',
          autoRollbackThreshold: percentage < 100 ? 'P0 准确率 < 100% 或 P95 延迟超预算 20%' : '观察一个业务周期内无 P0 回归',
        })),
        automaticRollback: {
          enabled: true,
          rollbackThresholds: ['P0 认证指标准确率低于 100%', '受限权限样本泄漏', 'P95 延迟连续 10 分钟超过预算 20%'],
          runbook: 'runbooks/semantic-release-rollback.md',
        },
        requiresApproval: true,
        audit: auditEvents.get(metric.id) ?? [],
      }
      audit('semantic.release_planned', request, metric.id, `语义指标灰度发布计划已生成：${request.note || '无备注'}。`)
      releasePlans.set(metric.id, plan)
      return success({
        ...plan,
        audit: auditEvents.get(metric.id) ?? [],
      })
    },

    rollbackMetric(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!canRollback(request.actor)) return failure({ code: 'PERMISSION_DENIED', message: '无权回滚语义指标', retryable: false, debugReference: 'semantic_rollback_role' })
      const metric = findVisible(request.metricId, request)
      if (!metric) return failure(notFound(request.metricId))
      if (metric.lifecycle !== 'certified') return failure(validationError('只有已认证指标可以回滚'))
      metric.lifecycle = 'deprecated'
      const existingPlan = releasePlans.get(metric.id)
      if (existingPlan) {
        releasePlans.set(metric.id, {
          ...existingPlan,
          status: 'rolled_back',
          audit: auditEvents.get(metric.id) ?? [],
        })
      }
      audit('semantic.rollback_completed', request, metric.id, `语义指标已回滚到 ${request.targetSemanticVersion || metric.semanticVersion}：${request.reason || '无备注'}。`)
      return success(view(metric))
    },
  }
}

export function httpStatusForSemanticEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
