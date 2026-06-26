import { describe, expect, it } from 'vitest'
import {
  InvalidRunTransitionError,
  RUN_DISPLAY_STATUSES,
  assertResultIntegrity,
  createWaitingRun,
  transitionRun,
  validateResultGrounding,
  type Clarification,
} from '../domain'
import { emptyResult, partialTrendResult, trendResult } from '../mocks'

const at = '2026-06-22T09:00:00+08:00'

function waiting() {
  return createWaitingRun({
    id: 'run_test',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    conversationId: 'conversation_test',
    question: '过去三个月净收入趋势',
    mode: 'trusted',
    semanticVersion: 'sales-semantic-2026.06.1',
    createdAt: at,
  })
}

describe('Run six-state contract', () => {
  it('defines exactly the six user-visible statuses once', () => {
    expect(RUN_DISPLAY_STATUSES).toEqual([
      'waiting_input',
      'understanding',
      'querying',
      'completed',
      'needs_clarification',
      'failed',
    ])
    expect(new Set(RUN_DISPLAY_STATUSES).size).toBe(6)
  })

  it('follows the successful transition path and increments optimistic version', () => {
    const understanding = transitionRun(waiting(), { type: 'QUESTION_SUBMITTED', at })
    const querying = transitionRun(understanding, { type: 'QUERY_STARTED', at })
    const completed = transitionRun(querying, { type: 'RESULT_READY', result: trendResult, at })

    expect([understanding.displayStatus, querying.displayStatus, completed.displayStatus]).toEqual([
      'understanding', 'querying', 'completed',
    ])
    expect(completed.version).toBe(3)
    expect(completed.result?.completeness).toBe('full')
  })

  it('represents partial delivery as completed plus completeness=partial', () => {
    const understanding = transitionRun(waiting(), { type: 'QUESTION_SUBMITTED', at })
    const querying = transitionRun(understanding, { type: 'QUERY_STARTED', at })
    const completed = transitionRun(querying, { type: 'RESULT_READY', result: partialTrendResult, at })

    expect(completed.displayStatus).toBe('completed')
    expect(completed.result?.completeness).toBe('partial')
    expect(completed.result?.incompleteSteps).toEqual(['regional_contribution'])
    expect(completed.result?.warnings).not.toHaveLength(0)
    expect(RUN_DISPLAY_STATUSES).not.toContain('partial_result')
  })

  it('rejects a partial result without an incomplete step and explanation', () => {
    expect(() => assertResultIntegrity({
      ...partialTrendResult,
      incompleteSteps: [],
      warnings: [],
    })).toThrow('A partial result must identify incomplete steps')
  })

  it('requires every deterministic numeric fact to reference a real result cell', () => {
    expect(() => assertResultIntegrity({
      ...trendResult,
      answer: {
        ...trendResult.answer,
        facts: [{
          ...trendResult.answer.facts[0],
          references: [{ resultId: trendResult.id, rowKey: 'missing-row', columnId: 'net_revenue' }],
        }],
      },
    })).toThrow('invalid cell reference')
  })

  it('rejects deterministic facts whose values do not match their referenced cells', () => {
    expect(() => assertResultIntegrity({
      ...trendResult,
      answer: {
        ...trendResult.answer,
        facts: [{
          ...trendResult.answer.facts[0],
          value: 9999999,
        }],
      },
    })).toThrow('value does not match any referenced cell')
  })

  it('reports grounded facts and a safe chart recommendation for trend results', () => {
    const report = validateResultGrounding(trendResult)

    expect(report).toMatchObject({
      grounded: true,
      checkedFacts: 2,
      checkedReferences: 2,
      chartSafety: {
        safe: true,
        recommendedVisualization: 'line',
        warnings: [],
      },
    })
  })

  it('keeps empty results grounded while recommending a table or empty state', () => {
    const report = validateResultGrounding(emptyResult)

    expect(report.grounded).toBe(true)
    expect(report.checkedFacts).toBe(0)
    expect(report.chartSafety).toMatchObject({
      safe: true,
      recommendedVisualization: 'table',
    })
    expect(report.chartSafety.warnings[0]).toContain('Empty result')
  })

  it('only resolves a clarification with the bound candidate version', () => {
    const clarification: Clarification = {
      reasonCode: 'metric_ambiguity',
      prompt: '请选择指标',
      irRevision: 1,
      expiresAt: '2026-06-22T10:00:00+08:00',
      candidates: [{
        id: 'net', label: '净收入', description: '认证指标', semanticObjectId: 'net_revenue', candidateVersion: 'v1',
      }],
    }
    const understanding = transitionRun(waiting(), { type: 'QUESTION_SUBMITTED', at })
    const needsClarification = transitionRun(understanding, { type: 'CLARIFICATION_REQUIRED', clarification, at })

    expect(() => transitionRun(needsClarification, {
      type: 'CLARIFICATION_RESOLVED', candidateId: 'net', candidateVersion: 'stale', at,
    })).toThrow('missing, stale, or unauthorized')
    expect(transitionRun(needsClarification, {
      type: 'CLARIFICATION_RESOLVED', candidateId: 'net', candidateVersion: 'v1', at,
    }).displayStatus).toBe('understanding')
  })

  it('returns cancellation to waiting_input and prevents later completion', () => {
    const understanding = transitionRun(waiting(), { type: 'QUESTION_SUBMITTED', at })
    const cancelled = transitionRun(understanding, { type: 'CANCELLED', at })

    expect(cancelled.displayStatus).toBe('waiting_input')
    expect(cancelled.internalStatus).toBe('cancelled')
    expect(cancelled.terminationReason).toBe('cancelled_by_user')
    expect(() => transitionRun(cancelled, { type: 'RESULT_READY', result: trendResult, at }))
      .toThrow(InvalidRunTransitionError)
  })

  it('rejects illegal status shortcuts', () => {
    expect(() => transitionRun(waiting(), { type: 'QUERY_STARTED', at })).toThrow(InvalidRunTransitionError)
    expect(() => transitionRun(waiting(), { type: 'RESULT_READY', result: trendResult, at })).toThrow(InvalidRunTransitionError)
  })
})
