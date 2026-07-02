import { describe, expect, it } from 'vitest'
import { createChatBiBffRouter } from '../api'
import { createFeedbackApplicationService } from '../application'
import type { ActorContext } from '../contracts'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const headers = {
  'x-tenant-id': actor.tenantId,
  'x-workspace-id': actor.workspaceId,
  'x-user-id': actor.userId,
  'x-business-domain-id': actor.businessDomainId,
  'x-semantic-version': actor.semanticVersion,
}

function feedbackRequest() {
  return {
    actor,
    runId: 'run_001',
    conversationId: 'conversation_001',
    requestId: 'req_001',
    traceId: 'trace_001',
    semanticVersion: actor.semanticVersion,
    vote: 'unhelpful' as const,
    reasonTags: ['wrong_number' as const],
    note: '联系 13800138000 或 owner@example.com',
    correctedAnswer: '正确结果是 1,420 万元',
    reportIssue: true,
  }
}

describe('FeedbackApplicationService', () => {
  it('requires a reason for negative feedback and reauthorizes the source run', () => {
    const denied = createFeedbackApplicationService({ authorizeRun: () => false })
      .submitFeedback(feedbackRequest())
    expect(denied.ok).toBe(false)
    if (denied.ok) return
    expect(denied.error).toMatchObject({ code: 'PERMISSION_DENIED' })

    const service = createFeedbackApplicationService({ authorizeRun: () => true })
    const missingReason = service.submitFeedback({
      ...feedbackRequest(),
      reasonTags: [],
    })
    expect(missingReason.ok).toBe(false)
    if (missingReason.ok) return
    expect(missingReason.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '负反馈至少选择一个原因',
    })
  })

  it('redacts sensitive feedback text and keeps only public-safe chain linkage', () => {
    const service = createFeedbackApplicationService({
      now: () => '2026-06-25T09:00:00+08:00',
      authorizeRun: () => true,
    })
    const response = service.submitFeedback(feedbackRequest())
    expect(response.ok).toBe(true)
    if (!response.ok) return

    expect(response.data).toMatchObject({
      status: 'new',
      vote: 'unhelpful',
      reasonTags: ['wrong_number'],
      sanitizedNote: '联系 [手机号已脱敏] 或 [邮箱已脱敏]',
      sensitiveDataRedacted: true,
      accessReauthorized: true,
      productionResultIncluded: false,
      candidateDatasetEligible: true,
      linkage: {
        runId: 'run_001',
        requestId: 'req_001',
        traceId: 'trace_001',
        tenantId: 'tenant_demo',
        workspaceId: 'workspace_sales',
      },
      audit: [
        expect.objectContaining({
          type: 'feedback.issue_reported',
          runId: 'run_001',
        }),
      ],
    })
    expect(JSON.stringify(response.data)).not.toContain('13800138000')
    expect(JSON.stringify(response.data)).not.toContain('owner@example.com')
  })

  it('exposes POST /v1/feedback and refuses feedback for an invisible run', () => {
    const router = createChatBiBffRouter()
    const submitted = router.handle({
      method: 'POST',
      path: '/v1/questions',
      headers: { ...headers, 'idempotency-key': 'feedback_run' },
      body: {
        conversation_id: 'conversation_feedback',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })
    expect(submitted.status).toBe(200)
    const run = (submitted.body as { data: { runId: string; requestId: string; traceId: string } }).data

    const feedback = router.handle({
      method: 'POST',
      path: '/v1/feedback',
      headers,
      body: {
        run_id: run.runId,
        conversation_id: 'conversation_feedback',
        request_id: 'req_spoofed',
        trace_id: 'trace_spoofed',
        semantic_version: 'semantic-spoofed',
        vote: 'helpful',
        reason_tags: [],
        report_issue: false,
      },
    })
    expect(feedback.status).toBe(200)
    expect(feedback.body).toMatchObject({
      ok: true,
      data: {
        vote: 'helpful',
        accessReauthorized: true,
        productionResultIncluded: false,
        linkage: {
          requestId: run.requestId,
          traceId: run.traceId,
          semanticVersion: actor.semanticVersion,
        },
      },
    })

    const invisible = router.handle({
      method: 'POST',
      path: '/v1/feedback',
      headers,
      body: {
        run_id: 'run_missing',
        conversation_id: 'conversation_feedback',
        vote: 'helpful',
      },
    })
    expect(invisible.status).toBe(404)
  })
})
