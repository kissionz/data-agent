import { describe, expect, it } from 'vitest'
import {
  prepareQuerySubmission,
  projectQueryRunOutcome,
  toQueryRunJobInput,
  type QueryRunJobPublication,
} from '../application'
import type { ActorContext } from '../contracts'
import { trendResult } from '../mocks'
import type { RunWorkerHandlerResult } from '../application/runWorker'

const at = '2026-07-15T14:00:00.000Z'
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

function prepared() {
  const submission = prepareQuerySubmission({
    idempotencyKey: 'projection',
    conversationId: 'conversation_projection',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
  }, { now: () => at })
  if (!submission.ok || !submission.job) throw new Error('expected querying submission')
  return { submission, payload: toQueryRunJobInput(submission.job).payload }
}

describe('pure query outcome projection', () => {
  it('projects an executed result, releases the conversation and returns the exact audit suffix', () => {
    const { submission, payload } = prepared()
    const outcome: RunWorkerHandlerResult<QueryRunJobPublication> = {
      type: 'completed',
      result: { type: 'executed', result: trendResult, summary: submission.record.queryExecution! },
      resultFingerprint: 'result-fingerprint',
      at,
    }

    const projected = projectQueryRunOutcome(submission.record, payload, outcome, submission.conversation)

    expect(projected.runRecord).toMatchObject({
      run: { displayStatus: 'completed', result: { id: trendResult.id } },
      executedQuery: true,
    })
    expect(projected.conversation?.activeRunId).toBeUndefined()
    expect(projected.newAuditEvents.map((event) => event.type)).toEqual(['query.completed', 'result.ready'])
    expect(projected.runRecord.audit.slice(-2)).toEqual(projected.newAuditEvents)
  })

  it('keeps retry state active without inventing an audit event', () => {
    const { submission, payload } = prepared()
    const outcome: RunWorkerHandlerResult<QueryRunJobPublication> = {
      type: 'retry',
      failure: { code: 'QUERY_UNAVAILABLE', message: 'retry', retryable: true },
      failedAt: at,
      availableAt: '2026-07-15T14:00:01.000Z',
    }

    const projected = projectQueryRunOutcome(submission.record, payload, outcome, submission.conversation)

    expect(projected.runRecord).toMatchObject({
      run: { displayStatus: 'querying' },
      queryExecution: { status: 'queued' },
    })
    expect(projected.conversation?.activeRunId).toBe(submission.record.run.id)
    expect(projected.newAuditEvents).toEqual([])
  })

  it('projects a terminal adapter failure without exposing its internal message', () => {
    const { submission, payload } = prepared()
    const outcome: RunWorkerHandlerResult<QueryRunJobPublication> = {
      type: 'failed',
      failedAt: at,
      failure: {
        code: 'QUERY_EXECUTION_FAILED',
        message: 'postgresql://admin:secret@db internal_table',
        retryable: false,
      },
    }

    const projected = projectQueryRunOutcome(submission.record, payload, outcome, submission.conversation)

    expect(projected.runRecord).toMatchObject({
      run: { displayStatus: 'failed', error: { code: 'INTERNAL_ERROR' } },
      executedQuery: false,
    })
    expect(projected.conversation?.activeRunId).toBeUndefined()
    expect(JSON.stringify(projected.runRecord)).not.toContain('admin:secret')
    expect(JSON.stringify(projected.runRecord)).not.toContain('secret')
    expect(JSON.stringify(projected.runRecord)).not.toContain('internal_table')
  })
})
