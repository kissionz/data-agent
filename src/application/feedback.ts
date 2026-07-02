import {
  CONTRACT_VERSION,
  httpStatusForError,
  validateActor,
  validationError,
  type ApiEnvelope,
  type FeedbackAuditEvent,
  type FeedbackReasonTag,
  type FeedbackView,
  type PublicApiError,
  type SubmitFeedbackRequest,
} from '../contracts'

export interface FeedbackApplicationService {
  submitFeedback(request: SubmitFeedbackRequest): ApiEnvelope<FeedbackView>
}

export interface FeedbackApplicationOptions {
  now?: () => string
  authorizeRun?: (request: SubmitFeedbackRequest) => boolean
}

const reasonTags = new Set<FeedbackReasonTag>([
  'wrong_number',
  'wrong_metric',
  'wrong_filter',
  'misleading_chart',
  'stale_data',
  'incomplete_answer',
  'permission_issue',
  'other',
])

export function createFeedbackApplicationService(
  options: FeedbackApplicationOptions = {},
): FeedbackApplicationService {
  const now = options.now ?? (() => new Date().toISOString())
  const authorizeRun = options.authorizeRun ?? (() => true)
  let sequence = 0

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
  }

  function ids() {
    return { requestId: nextId('req'), traceId: nextId('trace') }
  }

  function success<T>(data: T): ApiEnvelope<T> {
    return { ok: true, ...ids(), data }
  }

  function failure(error: PublicApiError): ApiEnvelope<never> {
    return { ok: false, ...ids(), error }
  }

  return {
    submitFeedback(request) {
      const actorError = validateActor(request.actor)
      if (actorError) return failure(actorError)
      if (!request.runId || !request.conversationId || !request.requestId || !request.traceId || !request.semanticVersion) {
        return failure(validationError('反馈必须关联运行、会话、请求、链路和语义版本'))
      }
      if (!['helpful', 'unhelpful'].includes(request.vote)) {
        return failure(validationError('不支持的反馈类型'))
      }
      const uniqueReasons = [...new Set(request.reasonTags)]
      if (uniqueReasons.some((reason) => !reasonTags.has(reason))) {
        return failure(validationError('反馈包含不支持的原因标签'))
      }
      if (request.vote === 'unhelpful' && uniqueReasons.length === 0) {
        return failure(validationError('负反馈至少选择一个原因'))
      }
      if (!authorizeRun(request)) {
        return failure({
          code: 'PERMISSION_DENIED',
          message: '无权为该运行提交反馈',
          retryable: false,
          debugReference: 'feedback_run_scope',
        })
      }

      const note = sanitizeText(request.note)
      const correctedAnswer = sanitizeText(request.correctedAnswer)
      const sensitiveDataRedacted = note.redacted || correctedAnswer.redacted
      const feedbackId = nextId('feedback')
      const audit: FeedbackAuditEvent[] = [{
        id: nextId('feedback_audit'),
        at: now(),
        type: request.reportIssue ? 'feedback.issue_reported' : 'feedback.received',
        actorUserId: request.actor.userId,
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        runId: request.runId,
        summary: request.reportIssue
          ? `反馈 ${feedbackId} 已关联运行并进入问题处理队列。`
          : `反馈 ${feedbackId} 已关联运行。`,
      }]

      return success({
        contractVersion: CONTRACT_VERSION,
        id: feedbackId,
        status: 'new',
        vote: request.vote,
        reasonTags: uniqueReasons,
        ...(note.value ? { sanitizedNote: note.value } : {}),
        ...(correctedAnswer.value ? { sanitizedCorrectedAnswer: correctedAnswer.value } : {}),
        sensitiveDataRedacted,
        linkage: {
          runId: request.runId,
          conversationId: request.conversationId,
          requestId: request.requestId,
          traceId: request.traceId,
          semanticVersion: request.semanticVersion,
          tenantId: request.actor.tenantId,
          workspaceId: request.actor.workspaceId,
        },
        accessReauthorized: true,
        productionResultIncluded: false,
        candidateDatasetEligible:
          request.vote === 'unhelpful' &&
          Boolean(correctedAnswer.value) &&
          uniqueReasons.length > 0,
        audit,
      })
    },
  }
}

function sanitizeText(value?: string) {
  const trimmed = value?.trim()
  if (!trimmed) return { value: undefined, redacted: false }
  let sanitized = trimmed
    .replace(/\b1[3-9]\d{9}\b/g, '[手机号已脱敏]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[邮箱已脱敏]')
    .replace(/\b\d{17}[\dXx]\b/g, '[证件号已脱敏]')
  if (sanitized.length > 1000) sanitized = sanitized.slice(0, 1000)
  return { value: sanitized, redacted: sanitized !== trimmed }
}

export function httpStatusForFeedbackEnvelope(envelope: ApiEnvelope<unknown>) {
  return envelope.ok ? 200 : httpStatusForError(envelope.error.code)
}
