import { overviewMetrics, replayRuns, sloItems, trendData } from '../features/operations/fixtures'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  validationError,
  type ApiEnvelope,
  type EvaluatePerformanceBudgetRequest,
  type GetSloReportRequest,
  type PerformanceBudgetDecisionView,
  type PublicApiError,
  type SloAlertView,
  type SloAuditEvent,
  type SloObjectiveStatus,
  type SloObjectiveView,
  type SloReportView,
  type SloWindow,
} from '../contracts'

export interface SloApplicationService {
  getReport(request: GetSloReportRequest): ApiEnvelope<SloReportView>
  evaluateBudget(request: EvaluatePerformanceBudgetRequest): ApiEnvelope<PerformanceBudgetDecisionView>
}

export interface SloApplicationOptions {
  now?: () => string
}

const DEFAULT_WINDOW: SloWindow = '7d'
const VALID_WINDOWS = new Set<SloWindow>(['7d', '30d', '90d'])

const thresholds = {
  latencySeconds: 15,
  latencyBlockSeconds: 60,
  costCny: 0.08,
  costBlockCny: 0.2,
  scanBytes: 100_000_000,
  scanBlockBytes: 500_000_000,
  cancelSeconds: 3,
  cancelBlockSeconds: 10,
}

export function createSloApplicationService(options: SloApplicationOptions = {}): SloApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0

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

  function invalidActor(request: { actor: GetSloReportRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function audit(type: SloAuditEvent['type'], request: { actor: GetSloReportRequest['actor'] }, summary: string): SloAuditEvent {
    return {
      id: nextId('slo_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      summary,
    }
  }

  function numberFromMetric(label: string) {
    const metric = overviewMetrics.find((item) => item.label === label)
    return metric ? Number(metric.value.replace(/[¥%s]/g, '')) : 0
  }

  function objective(input: Omit<SloObjectiveView, 'window'>, window: SloWindow): SloObjectiveView {
    return { ...input, window }
  }

  function reportObjectives(window: SloWindow): SloObjectiveView[] {
    const availability = sloItems.find((item) => item.name === '核心问答可用性')!
    const firstFeedback = sloItems.find((item) => item.name === '首个状态反馈 P95')!
    const queryLatency = sloItems.find((item) => item.name === '常规查询 P95')!
    const cancel = sloItems.find((item) => item.name === '取消传递 P95')!
    const partialRun = replayRuns.find((run) => run.id === 'RUN-28361')

    return [
      objective({
        name: availability.name,
        category: 'availability',
        value: 99.94,
        formattedValue: availability.value,
        target: 99.9,
        comparator: 'gte',
        formattedTarget: availability.target,
        status: 'healthy',
        errorBudgetRemaining: 40,
        evidence: ['运营中心 SLO fixture', '本地 BFF 健康检查契约', '核心问答状态机测试'],
      }, window),
      objective({
        name: firstFeedback.name,
        category: 'latency',
        value: 1.2,
        formattedValue: firstFeedback.value,
        target: 1.5,
        comparator: 'lte',
        formattedTarget: firstFeedback.target,
        status: 'healthy',
        errorBudgetRemaining: 20,
        evidence: ['状态反馈 P95 mock 指标', 'Run SSE 事件序列契约'],
      }, window),
      objective({
        name: queryLatency.name,
        category: 'latency',
        value: numberFromMetric('P95 完整答案'),
        formattedValue: queryLatency.value,
        target: thresholds.latencySeconds,
        comparator: 'lte',
        formattedTarget: queryLatency.target,
        status: 'healthy',
        errorBudgetRemaining: 21,
        evidence: [
          `最近趋势 ${trendData[0].latency}s → ${trendData[trendData.length - 1].latency}s`,
          'Query Gateway timeout/budget guard',
        ],
      }, window),
      objective({
        name: '单次成功成本',
        category: 'cost',
        value: numberFromMetric('单次成功成本'),
        formattedValue: '¥0.084',
        target: thresholds.costCny,
        comparator: 'lte',
        formattedTarget: '≤ ¥0.080',
        status: 'warning',
        errorBudgetRemaining: 0,
        evidence: ['运营中心成本指标高于目标约 5%', '模型路由配额与降级链已纳入本地契约'],
      }, window),
      objective({
        name: cancel.name,
        category: 'cancellation',
        value: 2.7,
        formattedValue: cancel.value,
        target: thresholds.cancelSeconds,
        comparator: 'lte',
        formattedTarget: cancel.target,
        status: 'warning',
        errorBudgetRemaining: 10,
        evidence: [
          '取消传递 P95 距阈值剩余 0.3s',
          partialRun ? `${partialRun.id} 记录了 60 秒预算降级链路` : '回放队列记录了预算降级链路',
        ],
      }, window),
    ]
  }

  function alerts(objectives: SloObjectiveView[], createdAt: string): SloAlertView[] {
    return objectives
      .filter((item) => item.status !== 'healthy')
      .map((item) => ({
        id: nextId('slo_alert'),
        severity: item.status === 'breach' ? 'critical' : 'warning',
        status: 'open',
        objective: item.name,
        message: item.category === 'cost'
          ? '单次成功成本超过目标 5%，需要检查模型路由、缓存命中和降级链。'
          : '取消传递 P95 接近 3 秒阈值，需要验证查询取消传播和下游连接池释放。',
        runbook: item.category === 'cost' ? 'runbooks/model-cost.md' : 'runbooks/cancel-propagation.md',
        rollbackRequired: item.status === 'breach',
        createdAt,
      }))
  }

  function worstStatus(objectives: SloObjectiveView[]): SloObjectiveStatus {
    if (objectives.some((item) => item.status === 'breach')) return 'breach'
    if (objectives.some((item) => item.status === 'warning')) return 'warning'
    return 'healthy'
  }

  function budgetStatus(actual: number, target: number, block: number): SloObjectiveStatus {
    if (!Number.isFinite(actual) || actual < 0) return 'breach'
    if (actual > block) return 'breach'
    if (actual > target) return 'warning'
    return 'healthy'
  }

  return {
    getReport(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const window = request.window ?? DEFAULT_WINDOW
      if (!VALID_WINDOWS.has(window)) return failure(validationError('SLO 窗口仅支持 7d、30d 或 90d'))

      const generatedAt = now()
      const objectives = reportObjectives(window)
      const auditEvent = audit('slo.report_generated', request, `生成 ${window} SLO 报告，状态为 ${worstStatus(objectives)}。`)
      return success({
        contractVersion: CONTRACT_VERSION,
        window,
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        generatedAt,
        summary: {
          status: worstStatus(objectives),
          healthy: objectives.filter((item) => item.status === 'healthy').length,
          warning: objectives.filter((item) => item.status === 'warning').length,
          breach: objectives.filter((item) => item.status === 'breach').length,
          costPerSuccessCny: numberFromMetric('单次成功成本'),
          p95LatencySeconds: numberFromMetric('P95 完整答案'),
          p95CancelSeconds: 2.7,
        },
        objectives,
        alerts: alerts(objectives, generatedAt),
        audit: [auditEvent],
      })
    },

    evaluateBudget(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!request.runId) return failure(validationError('缺少 runId'))

      const latencyStatus = budgetStatus(request.latencySeconds, thresholds.latencySeconds, thresholds.latencyBlockSeconds)
      const costStatus = budgetStatus(request.costCny, thresholds.costCny, thresholds.costBlockCny)
      const scanStatus = budgetStatus(request.scanBytes, thresholds.scanBytes, thresholds.scanBlockBytes)
      const cancelStatus = request.cancelledPropagationSeconds === undefined
        ? undefined
        : budgetStatus(request.cancelledPropagationSeconds, thresholds.cancelSeconds, thresholds.cancelBlockSeconds)
      const statuses = [latencyStatus, costStatus, scanStatus, cancelStatus].filter(Boolean) as SloObjectiveStatus[]

      const reasons = [
        latencyStatus !== 'healthy' ? `完整答案延迟 ${request.latencySeconds}s 超过 ${thresholds.latencySeconds}s 目标` : '',
        costStatus !== 'healthy' ? `单次成本 ¥${request.costCny.toFixed(3)} 超过 ¥${thresholds.costCny.toFixed(3)} 目标` : '',
        scanStatus !== 'healthy' ? `扫描量 ${request.scanBytes} bytes 超过 ${thresholds.scanBytes} bytes 预算` : '',
        cancelStatus && cancelStatus !== 'healthy' ? `取消传播 ${request.cancelledPropagationSeconds}s 超过 ${thresholds.cancelSeconds}s 目标` : '',
      ].filter(Boolean)

      const decision = statuses.includes('breach') ? 'block' : statuses.includes('warning') ? 'warn' : 'allow'
      const auditEvents = [
        audit('slo.budget_evaluated', request, `${request.runId} 性能预算评估结果为 ${decision}。`),
      ]
      if (decision !== 'allow') {
        auditEvents.push(audit('slo.alert_triggered', request, `${request.runId} 触发性能预算${decision === 'block' ? '阻断' : '预警'}。`))
      }

      return success({
        contractVersion: CONTRACT_VERSION,
        runId: request.runId,
        decision,
        reasons,
        budgets: {
          latencySeconds: { actual: request.latencySeconds, target: thresholds.latencySeconds, status: latencyStatus },
          costCny: { actual: request.costCny, target: thresholds.costCny, status: costStatus },
          scanBytes: { actual: request.scanBytes, target: thresholds.scanBytes, status: scanStatus },
          ...(cancelStatus
            ? { cancelledPropagationSeconds: { actual: request.cancelledPropagationSeconds!, target: thresholds.cancelSeconds, status: cancelStatus } }
            : {}),
        },
        audit: auditEvents,
      })
    },
  }
}

export function httpStatusForSloEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
