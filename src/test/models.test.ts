import { describe, expect, it } from 'vitest'
import {
  assertCertifiedMetric,
  attachRun,
  updateConversationState,
  type SemanticMetric,
} from '../domain'
import { questionScenarios, salesConversation, semanticMetrics } from '../mocks'
import { createLocalSemanticCatalog } from '../semantic'
import { ANALYSIS_IR_VERSION, type ActorContext, type AnalysisIR } from '../contracts'

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

function analysisIr(patch: Partial<AnalysisIR> = {}): AnalysisIR {
  return {
    schemaVersion: ANALYSIS_IR_VERSION,
    irId: 'ir_semantic_001',
    revision: 1,
    mode: 'trusted',
    semanticVersion: actor.semanticVersion,
    intent: 'trend',
    metricIds: ['net_revenue'],
    dimensionIds: ['region'],
    filters: [],
    timeRange: {
      kind: 'relative',
      expression: 'last_12_complete_months',
      timezone: 'Asia/Shanghai',
      grain: 'month',
    },
    limit: 500,
    assumptions: ['使用认证指标。'],
    safety: {
      requiresClarification: false,
      executedQuery: true,
      permissionChecked: true,
      budgetChecked: true,
    },
    ...patch,
  }
}

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

describe('Semantic catalog and Join Graph', () => {
  it('resolves certified metrics, compatible dimensions and approved Join Graph paths', () => {
    const catalog = createLocalSemanticCatalog()
    const plan = catalog.resolvePlan(analysisIr(), actor)

    expect(plan.metrics.map((metric) => metric.id)).toEqual(['net_revenue'])
    expect(plan.dimensions.map((dimension) => dimension.id)).toEqual(['region'])
    expect(plan.joins).toEqual([
      'LEFT JOIN semantic_sales.dim_sales_region r ON r.region_id = f.region_id AND r.tenant_id = f.tenant_id',
    ])
  })

  it('rejects draft metrics, semantic version mismatch and high-risk joins in trusted mode', () => {
    const catalog = createLocalSemanticCatalog()

    expect(() => catalog.resolvePlan(analysisIr({ metricIds: ['refund_rate'] }), actor)).toThrow('not certified')
    expect(() => catalog.resolvePlan(analysisIr({ semanticVersion: 'sales-semantic-2026.04.1' }), actor)).toThrow('version')
    expect(() => catalog.resolvePlan(analysisIr({ dimensionIds: ['product_line'] }), actor)).toThrow('high risk')
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
