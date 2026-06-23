import { describe, expect, it } from 'vitest'
import {
  assertCertifiedMetric,
  attachRun,
  updateConversationState,
  type SemanticMetric,
} from '../domain'
import { questionScenarios, salesConversation, semanticMetrics } from '../mocks'

describe('Conversation model', () => {
  it('does not let a system default overwrite an explicit user constraint', () => {
    const updated = updateConversationState(salesConversation.state, {
      timeRange: { value: 'last_30_days', source: 'system_default' },
      presentation: { value: 'table', source: 'user' },
    })
    expect(updated.timeRange).toEqual({ value: 'last_12_complete_months', source: 'user' })
    expect(updated.presentation).toEqual({ value: 'table', source: 'user' })
  })

  it('allows at most one active run per conversation', () => {
    const activeRun = questionScenarios.clarification.run
    const attached = attachRun(salesConversation, activeRun)
    expect(attached.activeRunId).toBe(activeRun.id)
    expect(() => attachRun(attached, { ...activeRun, id: 'another_run' })).toThrow('RUN_ALREADY_ACTIVE')
  })

  it('rejects a run from another tenant boundary', () => {
    expect(() => attachRun(salesConversation, {
      ...questionScenarios.clarification.run,
      tenantId: 'other_tenant',
    })).toThrow('boundary')
  })
})

describe('Semantic metric model', () => {
  it('ships complete immutable certified metrics for trusted mode', () => {
    expect(semanticMetrics).toHaveLength(3)
    for (const metric of semanticMetrics) expect(() => assertCertifiedMetric(metric)).not.toThrow()
  })

  it('rejects a draft metric in trusted mode', () => {
    const draft: SemanticMetric = { ...semanticMetrics[0], lifecycle: 'draft' }
    expect(() => assertCertifiedMetric(draft)).toThrow('Only certified metrics')
  })
})

describe('Deterministic question fixtures', () => {
  it('covers the six required scenarios', () => {
    expect(Object.keys(questionScenarios).sort()).toEqual([
      'cancelled',
      'clarification',
      'empty_result',
      'over_budget',
      'permission_denied',
      'success',
    ])
  })

  it('distinguishes empty success from failure', () => {
    const empty = questionScenarios.empty_result.run
    expect(empty.displayStatus).toBe('completed')
    expect(empty.result?.rows).toEqual([])
    expect(empty.result?.answer.headline).toContain('没有数据')
    expect(empty.error).toBeUndefined()
  })

  it('does not execute a query before clarification', () => {
    const scenario = questionScenarios.clarification
    expect(scenario.run.displayStatus).toBe('needs_clarification')
    expect(scenario.executedQuery).toBe(false)
    expect(scenario.run.result).toBeUndefined()
    expect(scenario.run.clarification?.candidates.length).toBeLessThanOrEqual(3)
  })
})
