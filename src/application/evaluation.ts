import { gateMetrics, replayRuns } from '../features/operations/fixtures'
import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  type ApiEnvelope,
  type ApproveGoldenSampleRequest,
  type EvaluationAuditEvent,
  type EvaluationGateMetricView,
  type EvaluationGateReport,
  type EvaluateReleaseGateRequest,
  type GetGoldenSampleRequest,
  type GetRegressionRunRequest,
  type GetReplayRunRequest,
  type GoldenSampleStatus,
  type GoldenSampleView,
  type IngestGoldenSampleRequest,
  type ListGoldenSamplesRequest,
  type ListRegressionRunsRequest,
  type ListReplayRunsRequest,
  type PublicApiError,
  type RegressionRunStatus,
  type RegressionRunPlanView,
  type ReplayRunView,
  type ScheduleRegressionRunRequest,
} from '../contracts'

export interface EvaluationApplicationService {
  evaluateReleaseGate(request: EvaluateReleaseGateRequest): ApiEnvelope<EvaluationGateReport>
  listReplayRuns(request: ListReplayRunsRequest): ApiEnvelope<{ items: ReplayRunView[]; total: number }>
  getReplayRun(request: GetReplayRunRequest): ApiEnvelope<ReplayRunView>
  listGoldenSamples(request: ListGoldenSamplesRequest): ApiEnvelope<{ items: GoldenSampleView[]; total: number }>
  getGoldenSample(request: GetGoldenSampleRequest): ApiEnvelope<GoldenSampleView>
  ingestGoldenSample(request: IngestGoldenSampleRequest): ApiEnvelope<GoldenSampleView>
  approveGoldenSample(request: ApproveGoldenSampleRequest): ApiEnvelope<GoldenSampleView>
  scheduleRegressionRun(request: ScheduleRegressionRunRequest): ApiEnvelope<RegressionRunPlanView>
  listRegressionRuns(request: ListRegressionRunsRequest): ApiEnvelope<{ items: RegressionRunPlanView[]; total: number }>
  getRegressionRun(request: GetRegressionRunRequest): ApiEnvelope<RegressionRunPlanView>
}

export interface EvaluationApplicationOptions {
  now?: () => string
  seedGoldenSamples?: boolean
}

interface ScopedGoldenSample {
  tenantId: string
  workspaceId: string
  view: GoldenSampleView
}

interface ScopedRegressionRun {
  tenantId: string
  workspaceId: string
  view: RegressionRunPlanView
}

const P0_METRICS = new Set(['意图准确率', '实体链接 F1', '计划准确率', '执行准确率', '澄清召回率'])
const GOLDEN_SAMPLE_STATUSES = new Set<GoldenSampleStatus>([
  'new',
  'triaged',
  'in_review',
  'resolved',
  'rejected',
  'candidate_dataset',
  'golden_approved',
])
const REGRESSION_RUN_STATUSES = new Set<RegressionRunStatus>([
  'queued',
  'running',
  'passed',
  'failed',
  'release_blocked',
])
const GOLDEN_SAMPLE_INTENTS = new Set<GoldenSampleView['expectedIntent']>([
  'trend',
  'breakdown',
  'ranking',
  'lookup',
  'clarification',
  'empty_check',
])
const EVALUATION_READ_ROLES = new Set(['platform_ops', 'analyst', 'metric_admin'])
const EVALUATION_INGEST_ROLES = new Set(['platform_ops', 'analyst'])
const EVALUATION_APPROVE_ROLES = new Set(['platform_ops', 'metric_admin'])
const EVALUATION_SCHEDULE_ROLES = new Set(['platform_ops', 'analyst'])

export function createEvaluationApplicationService(options: EvaluationApplicationOptions = {}): EvaluationApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  let sequence = 0
  const auditEvents: EvaluationAuditEvent[] = []
  const goldenSamples = new Map<string, ScopedGoldenSample>()
  const regressionRuns = new Map<string, ScopedRegressionRun>()
  const seededScopes = new Set<string>()

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

  function hasEvaluationRole(
    request: { actor: ListReplayRunsRequest['actor'] },
    allowedRoles: Set<string>,
  ) {
    return request.actor.roles.some((role) => allowedRoles.has(role))
  }

  function invalidEvaluationInput(message: string, debugReference: string): PublicApiError {
    return {
      code: 'VALIDATION_FAILED',
      message,
      retryable: true,
      debugReference,
    }
  }

  function sanitizeAuditNote(value: string) {
    return value
      .trim()
      .replace(/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]')
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[邮箱已脱敏]')
      .replace(/\b\d{17}[\dXx]\b/g, '[证件号已脱敏]')
      .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[敏感值已脱敏]')
  }

  function scopeKey(actor: ListReplayRunsRequest['actor']) {
    return `${actor.tenantId}:${actor.workspaceId}`
  }

  function scopedStoreKey(actor: ListReplayRunsRequest['actor'], id: string) {
    return `${scopeKey(actor)}:${id}`
  }

  function inScope<T extends { tenantId: string; workspaceId: string }>(
    value: T,
    actor: ListReplayRunsRequest['actor'],
  ) {
    return value.tenantId === actor.tenantId && value.workspaceId === actor.workspaceId
  }

  function sampleAudit(sampleId: string, actor: ListReplayRunsRequest['actor']) {
    return auditEvents.filter((event) => (
      event.tenantId === actor.tenantId &&
      event.workspaceId === actor.workspaceId &&
      event.summary.includes(sampleId)
    ))
  }

  function scopedSamples(actor: ListReplayRunsRequest['actor']) {
    return [...goldenSamples.values()].filter((sample) => inScope(sample, actor))
  }

  function scopedRegressionRuns(actor: ListReplayRunsRequest['actor']) {
    return [...regressionRuns.values()].filter((run) => inScope(run, actor))
  }

  function visibleApprovedSamples(request: { actor: ListReplayRunsRequest['actor'] }) {
    return scopedSamples(request.actor)
      .map((sample) => sample.view)
      .filter((sample) => sample.status === 'golden_approved')
  }

  function goldenNotFound(sampleId: string): PublicApiError {
    return {
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可见的黄金集样本',
      retryable: false,
      debugReference: `golden_${sampleId}`,
    }
  }

  function regressionNotFound(regressionRunId: string): PublicApiError {
    return {
      code: 'SEMANTIC_NOT_FOUND',
      message: '没有找到可见的回归计划',
      retryable: false,
      debugReference: `regression_${regressionRunId}`,
    }
  }

  function ensureSeeded(actor: ListReplayRunsRequest['actor']) {
    if (!options.seedGoldenSamples) return
    const key = scopeKey(actor)
    if (seededScopes.has(key)) return
    seededScopes.add(key)
    const samples: GoldenSampleView[] = [
      {
        contractVersion: CONTRACT_VERSION,
        id: 'golden_seed_001',
        sourceRunId: 'RUN-28112',
        status: 'golden_approved',
        domain: '销售分析',
        sanitizedQuestion: '过去 12 个完整自然月净收入趋势。',
        expectedIntent: 'trend',
        expectedMetricIds: ['net_revenue'],
        expectedDimensionIds: ['order_date'],
        semanticVersion: actor.semanticVersion,
        tags: ['标准', '时间变体'],
        createdAt: '2026-06-20T09:30:00+08:00',
        qualityGates: {
          desensitized: true,
          deduplicated: true,
          humanLabeled: true,
          productionCredentialsRemoved: true,
        },
        approvedBy: 'user_analyst',
        approvedAt: '2026-06-20T11:10:00+08:00',
        audit: [],
      },
      {
        contractVersion: CONTRACT_VERSION,
        id: 'golden_seed_002',
        sourceRunId: 'RUN-28419',
        status: 'candidate_dataset',
        domain: '销售分析',
        sanitizedQuestion: '最近销售情况怎么样？',
        expectedIntent: 'clarification',
        expectedMetricIds: ['net_revenue'],
        expectedDimensionIds: [],
        semanticVersion: actor.semanticVersion,
        tags: ['口语', '时间歧义', '澄清'],
        createdAt: '2026-06-24T10:32:00+08:00',
        qualityGates: {
          desensitized: true,
          deduplicated: true,
          humanLabeled: true,
          productionCredentialsRemoved: true,
        },
        audit: [],
      },
      {
        contractVersion: CONTRACT_VERSION,
        id: 'golden_seed_003',
        sourceRunId: 'RUN-28370',
        status: 'golden_approved',
        domain: '经营分析',
        sanitizedQuestion: '上季度净收入最高的 10 个区域。',
        expectedIntent: 'ranking',
        expectedMetricIds: ['net_revenue'],
        expectedDimensionIds: ['region'],
        semanticVersion: actor.semanticVersion,
        tags: ['排名', '维度切换'],
        createdAt: '2026-06-21T14:20:00+08:00',
        qualityGates: {
          desensitized: true,
          deduplicated: true,
          humanLabeled: true,
          productionCredentialsRemoved: true,
        },
        approvedBy: 'user_analyst',
        approvedAt: '2026-06-21T15:45:00+08:00',
        audit: [],
      },
    ]
    samples.forEach((view) => {
      goldenSamples.set(scopedStoreKey(actor, view.id), {
        tenantId: actor.tenantId,
        workspaceId: actor.workspaceId,
        view,
      })
    })
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

    listGoldenSamples(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_READ_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权查看黄金集样本',
        retryable: false,
        debugReference: 'evaluation_sample_read_role',
      })
      if (request.status && request.status !== 'all' && !GOLDEN_SAMPLE_STATUSES.has(request.status)) {
        return failure(invalidEvaluationInput('黄金样本状态无效', 'evaluation_sample_status'))
      }
      ensureSeeded(request.actor)
      const normalized = request.query?.trim().toLowerCase()
      const normalizedTag = request.tag?.trim().toLowerCase()
      const items = scopedSamples(request.actor)
        .map((sample) => sample.view)
        .filter((sample) => !request.status || request.status === 'all' || sample.status === request.status)
        .filter((sample) => !request.domain || request.domain === 'all' || sample.domain === request.domain)
        .filter((sample) => !request.semanticVersion || sample.semanticVersion === request.semanticVersion)
        .filter((sample) => !normalizedTag || sample.tags.some((tag) => tag.toLowerCase() === normalizedTag))
        .filter((sample) => {
          if (!normalized) return true
          return [
            sample.id,
            sample.sourceRunId,
            sample.sanitizedQuestion,
            sample.expectedIntent,
            ...sample.tags,
          ].some((value) => value.toLowerCase().includes(normalized))
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      audit('evaluation.samples_listed', request, `用户查看黄金集样本列表，共 ${items.length} 条。`)
      return success({ items, total: items.length })
    },

    getGoldenSample(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_READ_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权查看黄金集样本',
        retryable: false,
        debugReference: 'evaluation_sample_read_role',
      })
      ensureSeeded(request.actor)
      const sample = goldenSamples.get(scopedStoreKey(request.actor, request.sampleId))
      if (!sample || !inScope(sample, request.actor)) return failure(goldenNotFound(request.sampleId))
      return success({
        ...sample.view,
        audit: sampleAudit(sample.view.id, request.actor),
      })
    },

    ingestGoldenSample(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_INGEST_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权管理黄金集样本',
        retryable: false,
        debugReference: 'evaluation_sample_role',
      })
      if (
        !request.sourceRunId.trim() ||
        !request.sanitizedQuestion.trim() ||
        !request.domain.trim() ||
        !request.semanticVersion.trim()
      ) {
        return failure(invalidEvaluationInput(
          '黄金样本缺少来源、脱敏问题、业务域或语义版本',
          'golden_required_fields',
        ))
      }
      if (request.sanitizedQuestion.length > 500) {
        return failure(invalidEvaluationInput('脱敏问题不能超过 500 个字符', 'golden_question_length'))
      }
      if (!GOLDEN_SAMPLE_INTENTS.has(request.expectedIntent)) {
        return failure(invalidEvaluationInput('黄金样本意图无效', 'golden_expected_intent'))
      }
      if (
        request.expectedMetricIds.some((value) => !value.trim()) ||
        request.expectedDimensionIds.some((value) => !value.trim()) ||
        request.tags.some((value) => !value.trim())
      ) {
        return failure(invalidEvaluationInput('指标、维度和标签不能包含空值', 'golden_empty_labels'))
      }
      if (!request.desensitized || !request.deduplicated || !request.humanLabeled) return failure({
        code: 'VALIDATION_FAILED',
        message: '线上样本必须先脱敏、去重并人工标注，不能直接进入候选集',
        retryable: true,
        debugReference: `golden_gate_${request.sourceRunId}`,
      })
      const id = nextId('golden_sample')
      audit('evaluation.sample_ingested', request, `黄金集样本 ${id} 已进入候选集，来源 ${request.sourceRunId}。`)
      const sample: GoldenSampleView = {
        contractVersion: CONTRACT_VERSION,
        id,
        sourceRunId: request.sourceRunId,
        status: 'candidate_dataset',
        domain: request.domain,
        sanitizedQuestion: request.sanitizedQuestion,
        expectedIntent: request.expectedIntent,
        expectedMetricIds: request.expectedMetricIds,
        expectedDimensionIds: request.expectedDimensionIds,
        semanticVersion: request.semanticVersion,
        tags: request.tags,
        createdAt: now(),
        qualityGates: {
          desensitized: request.desensitized,
          deduplicated: request.deduplicated,
          humanLabeled: request.humanLabeled,
          productionCredentialsRemoved: true,
        },
        audit: sampleAudit(id, request.actor),
      }
      goldenSamples.set(scopedStoreKey(request.actor, id), {
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        view: sample,
      })
      return success({
        ...sample,
        audit: sampleAudit(id, request.actor),
      })
    },

    approveGoldenSample(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_APPROVE_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权审批黄金集样本',
        retryable: false,
        debugReference: 'evaluation_approve_role',
      })
      const rawNote = request.note.trim()
      if (!rawNote) {
        return failure(invalidEvaluationInput('审批说明不能为空', 'evaluation_approve_note_required'))
      }
      if (rawNote.length > 500) {
        return failure(invalidEvaluationInput('审批说明不能超过 500 个字符', 'evaluation_approve_note_length'))
      }
      ensureSeeded(request.actor)
      const scopedSample = goldenSamples.get(scopedStoreKey(request.actor, request.sampleId))
      if (!scopedSample || !inScope(scopedSample, request.actor)) return failure(goldenNotFound(request.sampleId))
      const sample = scopedSample.view
      if (sample.status !== 'candidate_dataset') return failure({
        code: 'VALIDATION_FAILED',
        message: '只有候选集样本可以审批进入黄金集',
        retryable: true,
        debugReference: `golden_status_${sample.status}`,
      })
      const sanitizedNote = sanitizeAuditNote(rawNote)
      audit('evaluation.golden_approved', request, `黄金集样本 ${sample.id} 已审批通过：${sanitizedNote}。`)
      const approved: GoldenSampleView = {
        ...sample,
        status: 'golden_approved',
        approvedBy: request.actor.userId,
        approvedAt: now(),
        audit: sampleAudit(sample.id, request.actor),
      }
      goldenSamples.set(scopedStoreKey(request.actor, sample.id), {
        ...scopedSample,
        view: approved,
      })
      return success(approved)
    },

    scheduleRegressionRun(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_SCHEDULE_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权调度批量回归',
        retryable: false,
        debugReference: 'evaluation_regression_role',
      })
      const candidateVersion = request.candidateVersion.trim()
      if (!candidateVersion || candidateVersion.length > 128 || /[\u0000-\u001f\u007f]/.test(candidateVersion)) {
        return failure(invalidEvaluationInput('候选版本不能为空、超过 128 个字符或包含控制字符', 'regression_candidate_version'))
      }
      ensureSeeded(request.actor)
      const approved = visibleApprovedSamples(request)
      const requestedSampleIds = request.sampleIds?.map((sampleId) => sampleId.trim())
      if (requestedSampleIds?.some((sampleId) => !sampleId)) {
        return failure(invalidEvaluationInput('回归样本 ID 不能为空', 'regression_sample_id'))
      }
      const uniqueRequestedSampleIds = requestedSampleIds
        ? [...new Set(requestedSampleIds)]
        : undefined
      const approvedSampleIds = new Set(approved.map((sample) => sample.id))
      if (uniqueRequestedSampleIds?.some((sampleId) => !approvedSampleIds.has(sampleId))) {
        return failure(invalidEvaluationInput(
          '回归范围包含不可见或未审批的黄金样本，未创建缩水计划',
          'regression_sample_scope',
        ))
      }
      const sampleIds = uniqueRequestedSampleIds && uniqueRequestedSampleIds.length > 0
        ? uniqueRequestedSampleIds
        : approved.map((sample) => sample.id)
      if (sampleIds.length === 0) return failure({
        code: 'VALIDATION_FAILED',
        message: '批量回归至少需要一个已审批黄金集样本',
        retryable: true,
        debugReference: 'regression_empty_samples',
      })
      const id = nextId('regression')
      audit('evaluation.regression_scheduled', request, `批量回归 ${id} 已排队，候选版本 ${candidateVersion}，样本 ${sampleIds.length} 条。`)
      const plan: RegressionRunPlanView = {
        contractVersion: CONTRACT_VERSION,
        id,
        candidateVersion,
        status: 'queued',
        createdAt: now(),
        requestedBy: request.actor.userId,
        sampleIds,
        sampleCount: sampleIds.length,
        stages: ['retrieval', 'planner', 'compiler', 'query_gateway', 'answer_grounding'],
        usesProductionCredentials: false,
        releaseGateLinked: true,
        completedStages: [],
        audit: auditEvents.filter((event) => event.summary.includes(id)),
      }
      regressionRuns.set(scopedStoreKey(request.actor, id), {
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        view: plan,
      })
      return success(plan)
    },

    listRegressionRuns(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_READ_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权查看回归计划',
        retryable: false,
        debugReference: 'evaluation_regression_read_role',
      })
      if (request.status && request.status !== 'all' && !REGRESSION_RUN_STATUSES.has(request.status)) {
        return failure(invalidEvaluationInput('回归运行状态无效', 'evaluation_regression_status'))
      }
      const items = scopedRegressionRuns(request.actor)
        .map((run) => run.view)
        .filter((run) => !request.status || request.status === 'all' || run.status === request.status)
        .filter((run) => !request.candidateVersion || run.candidateVersion === request.candidateVersion)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      audit('evaluation.regressions_listed', request, `用户查看批量回归计划列表，共 ${items.length} 条。`)
      return success({ items, total: items.length })
    },

    getRegressionRun(request) {
      const invalid = invalidActor(request)
      if (invalid) return invalid
      if (!hasEvaluationRole(request, EVALUATION_READ_ROLES)) return failure({
        code: 'PERMISSION_DENIED',
        message: '无权查看回归计划',
        retryable: false,
        debugReference: 'evaluation_regression_read_role',
      })
      const run = regressionRuns.get(scopedStoreKey(request.actor, request.regressionRunId))
      if (!run || !inScope(run, request.actor)) return failure(regressionNotFound(request.regressionRunId))
      return success(run.view)
    },
  }
}

export function httpStatusForEvaluationEnvelope<T>(envelope: ApiEnvelope<T>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
