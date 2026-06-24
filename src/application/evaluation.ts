import { gateMetrics, replayRuns } from '../features/operations/fixtures'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type EvaluationAuditEvent,
  type EvaluationGateMetricView,
  type EvaluationGateReport,
  type EvaluateReleaseGateRequest,
  type GetReplayRunRequest,
  type ListReplayRunsRequest,
  type PublicApiError,
  type ReplayRunView,
} from '../contracts'

export interface EvaluationApplicationService {
  evaluateReleaseGate(request: EvaluateReleaseGateRequest): ApiEnvelope<EvaluationGateReport>
  listReplayRuns(request: ListReplayRunsRequest): ApiEnvelope<{ items: ReplayRunView[]; total: number }>
  getReplayRun(request: GetReplayRunRequest): ApiEnvelope<ReplayRunView>
}

export interface EvaluationApplicationOptions {
  now?: () => string
}

const P0_METRICS = new Set(['意图准确率', '实体链接 F1', '计划准确率', '执行准确率', '澄清召回率'])

export function createEvaluationApplicationService(options: EvaluationApplicationOptions = {}): EvaluationApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const auditEvents: EvaluationAuditEvent[] = []

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

  function invalidActor(request: { actor: ListReplayRunsRequest['actor'] }) {
    const error = validateActor(request.actor)
    return error ? failure(error) : null
  }

  function notFound(runId: string): PublicApiError {
    return {
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可回放的运行记录',
      retryable: false,
      debugReference: `replay_${runId}`,
    }
  }

  function audit(type: EvaluationAuditEvent['type'], request: { actor: ListReplayRunsRequest['actor'] }, summary: string) {
    const event: EvaluationAuditEvent = {
      id: nextId('eval_audit'),
      at: now(),
      type,
      actorUserId: request.actor.userId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      summary,
    }
    auditEvents.push(event)
    return event
  }

  function metrics(): EvaluationGateMetricView[] {
    return gateMetrics.map((metric) => ({
      name: metric.name,
      value: metric.value,
      target: metric.target,
      result: metric.value >= metric.target ? 'pass' : 'fail',
      severity: P0_METRICS.has(metric.name) ? 'p0' : 'p1',
    }))
  }

  function gateReport(request: EvaluateReleaseGateRequest): EvaluationGateReport {
    const evaluatedMetrics = metrics()
    const failedP0 = evaluatedMetrics.filter((metric) => metric.severity === 'p0' && metric.result === 'fail')
    const decision = failedP0.length > 0 ? 'blocked' : 'pass'
    const event = audit(
      decision === 'blocked' ? 'evaluation.release_blocked' : 'evaluation.gate_evaluated',
      request,
      decision === 'blocked'
        ? `候选版本 ${request.candidateVersion ?? 'planner-3.3-rc2'} 被黄金集 P0 门禁阻断。`
        : `候选版本 ${request.candidateVersion ?? 'planner-3.3-rc2'} 通过黄金集门禁。`,
    )
    return {
      contractVersion: CONTRACT_VERSION,
      candidateVersion: request.candidateVersion ?? 'planner-3.3-rc2',
      sampleSize: 2480,
      decision,
      failedP0: failedP0.length,
      failedMetrics: evaluatedMetrics.filter((metric) => metric.result === 'fail'),
      metrics: evaluatedMetrics,
      releaseAllowed: decision === 'pass',
      summary: decision === 'blocked'
        ? `${failedP0.map((metric) => metric.name).join('、')} 未达 P0 门槛，禁止发布。`
        : '全部 P0 门槛达标，可以进入灰度发布。',
      audit: [...auditEvents],
    }
  }

  function canSeeReplay(run: typeof replayRuns[number], request: ListReplayRunsRequest) {
    if (run.status === 'blocked') return request.actor.roles.some((role) => ['security_admin', 'platform_ops', 'analyst'].includes(role))
    return true
  }

  function replayView(run: typeof replayRuns[number]): ReplayRunView {
    const requiresDesensitization = /手机号|权限|PII|客户/.test(`${run.question} ${run.reason}`)
    return {
      contractVersion: CONTRACT_VERSION,
      ...run,
      safeForReplay: !requiresDesensitization || run.status === 'blocked',
      replayPlan: {
        candidateVersion: 'planner-3.3-rc2',
        requiresDesensitization,
        canUseProductionCredentials: false,
      },
      audit: auditEvents.filter((event) => event.summary.includes(run.id)),
    }
  }

  return {
    evaluateReleaseGate(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      return success(gateReport(request))
    },

    listReplayRuns(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const normalized = request.query?.trim().toLowerCase()
      const items = replayRuns
        .filter((run) => canSeeReplay(run, request))
        .filter((run) => !request.status || request.status === 'all' || run.status === request.status)
        .filter((run) => !request.domain || request.domain === 'all' || run.domain === request.domain)
        .filter((run) => {
          if (!normalized) return true
          return [run.id, run.question, run.reason, run.stage]
            .some((value) => value.toLowerCase().includes(normalized))
        })
        .map((run) => replayView(run))
      audit('evaluation.replay_listed', request, `用户查看失败回放列表，共 ${items.length} 条。`)
      return success({ items, total: items.length })
    },

    getReplayRun(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      const run = replayRuns.find((candidate) => candidate.id === request.runId)
      if (!run || !canSeeReplay(run, { actor: request.actor })) return failure(notFound(request.runId))
      audit('evaluation.replay_viewed', request, `用户查看回放 ${run.id}，不会使用生产凭据。`)
      return success(replayView(run))
    },
  }
}

export function httpStatusForEvaluationEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
