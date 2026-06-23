import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_IR_VERSION,
  analysisIrJsonSchema,
  assertAnalysisIR,
  validateSubmitQuestionRequest,
  type AnalysisIR,
  type SubmitQuestionRequest,
} from '../contracts'

const actor = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user' as const],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN' as const,
  timezone: 'Asia/Shanghai',
}

function questionRequest(patch: Partial<SubmitQuestionRequest> = {}): SubmitQuestionRequest {
  return {
    idempotencyKey: 'idem_001',
    conversationId: 'conversation_001',
    question: '过去 12 个月净收入趋势',
    mode: 'trusted',
    actor,
    ...patch,
  }
}

function analysisIr(patch: Partial<AnalysisIR> = {}): AnalysisIR {
  return {
    schemaVersion: ANALYSIS_IR_VERSION,
    irId: 'ir_001',
    revision: 1,
    mode: 'trusted',
    semanticVersion: actor.semanticVersion,
    intent: 'trend',
    metricIds: ['net_revenue'],
    dimensionIds: ['order_date'],
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
      executedQuery: false,
      permissionChecked: true,
      budgetChecked: true,
    },
    ...patch,
  }
}

describe('API contracts', () => {
  it('rejects unknown submit question fields instead of silently accepting them', () => {
    const request = {
      ...questionRequest(),
      unsafeSql: 'select * from customer',
    } as SubmitQuestionRequest

    expect(validateSubmitQuestionRequest(request)).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: true,
    })
  })

  it('requires actor, tenant, workspace, semantic version and supported locale', () => {
    expect(validateSubmitQuestionRequest(questionRequest({
      actor: { ...actor, workspaceId: '' },
    }))).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(validateSubmitQuestionRequest(questionRequest({
      actor: { ...actor, locale: 'en-US' as 'zh-CN' },
    }))).toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('publishes a no-extra-properties Analysis IR schema id', () => {
    expect(analysisIrJsonSchema.$id).toContain('analysis-ir.v1')
    expect(analysisIrJsonSchema.additionalProperties).toBe(false)
    expect(analysisIrJsonSchema.required).toContain('safety')
  })

  it('enforces trusted Analysis IR metric and clarification execution guards', () => {
    expect(() => assertAnalysisIR(analysisIr())).not.toThrow()
    expect(() => assertAnalysisIR(analysisIr({ metricIds: [] }))).toThrow('governed metric')
    expect(() => assertAnalysisIR(analysisIr({
      safety: {
        requiresClarification: true,
        executedQuery: true,
        permissionChecked: true,
        budgetChecked: true,
      },
    }))).toThrow('cannot execute')
  })
})
