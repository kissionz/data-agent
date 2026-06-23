import {
  createWaitingRun,
  transitionRun,
  type Clarification,
  type Run,
  type RunError,
  type RunResult,
} from '../domain'

export type ScenarioId =
  | 'success'
  | 'clarification'
  | 'permission_denied'
  | 'over_budget'
  | 'empty_result'
  | 'cancelled'

export interface QuestionScenario {
  id: ScenarioId
  question: string
  run: Run
  executedQuery: boolean
}

const semanticVersion = 'sales-semantic-2026.06.1'
const baseTime = '2026-06-22T09:00:00+08:00'

function waitingRun(id: string, question: string): Run {
  return createWaitingRun({
    id,
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    conversationId: 'conversation_sales_demo',
    question,
    mode: 'trusted',
    semanticVersion,
    createdAt: baseTime,
  })
}

function submitted(id: string, question: string): Run {
  return transitionRun(waitingRun(id, question), {
    type: 'QUESTION_SUBMITTED',
    at: '2026-06-22T09:00:00.100+08:00',
  })
}

export const trendResult: RunResult = {
  id: 'result_trend_12m',
  columns: [
    { id: 'month', label: '月份', type: 'date' },
    { id: 'net_revenue', label: '净收入', type: 'currency', unit: 'CNY' },
  ],
  rows: [
    { key: '2026-03', values: { month: '2026-03', net_revenue: 1184000 } },
    { key: '2026-04', values: { month: '2026-04', net_revenue: 1268000 } },
    { key: '2026-05', values: { month: '2026-05', net_revenue: 1326000 } },
  ],
  completeness: 'full',
  incompleteSteps: [],
  warnings: [],
  answer: {
    headline: '净收入连续三个月增长',
    summary: '2026 年 5 月净收入为 132.6 万元，高于 4 月。',
    semanticVersion,
    generatedFrom: 'fixture_result',
    facts: [
      {
        id: 'latest_revenue',
        label: '2026 年 5 月净收入',
        value: 1326000,
        formattedValue: '¥1,326,000',
        references: [{ resultId: 'result_trend_12m', rowKey: '2026-05', columnId: 'net_revenue' }],
      },
      {
        id: 'previous_revenue',
        label: '2026 年 4 月净收入',
        value: 1268000,
        formattedValue: '¥1,268,000',
        references: [{ resultId: 'result_trend_12m', rowKey: '2026-04', columnId: 'net_revenue' }],
      },
    ],
  },
  freshnessAt: '2026-06-22T08:00:00+08:00',
}

export const partialTrendResult: RunResult = {
  ...trendResult,
  id: 'result_trend_partial',
  completeness: 'partial',
  incompleteSteps: ['regional_contribution'],
  warnings: ['区域贡献步骤超时，趋势结果仍可用。'],
  answer: {
    ...trendResult.answer,
    headline: '净收入趋势已就绪，区域贡献未完成',
    facts: trendResult.answer.facts.map((fact) => ({
      ...fact,
      references: fact.references.map((reference) => ({ ...reference, resultId: 'result_trend_partial' })),
    })),
  },
}

export const emptyResult: RunResult = {
  id: 'result_empty_region',
  columns: [
    { id: 'region', label: '区域', type: 'string' },
    { id: 'net_revenue', label: '净收入', type: 'currency', unit: 'CNY' },
  ],
  rows: [],
  completeness: 'full',
  incompleteSteps: [],
  warnings: ['查询成功，但当前筛选和时间范围内没有数据。'],
  answer: {
    headline: '当前条件下没有数据',
    summary: '查询已成功完成。请调整时间范围或筛选条件后重试。',
    facts: [],
    semanticVersion,
    generatedFrom: 'fixture_result',
  },
  freshnessAt: '2026-06-22T08:00:00+08:00',
}

const metricClarification: Clarification = {
  reasonCode: 'metric_ambiguity',
  prompt: '你说的“收入”是指哪个认证指标？',
  irRevision: 1,
  expiresAt: '2026-06-22T09:15:00+08:00',
  candidates: [
    {
      id: 'candidate_net_revenue',
      label: '净收入',
      description: '已完成订单收入扣除退款',
      semanticObjectId: 'net_revenue',
      candidateVersion: 'clarification-v1',
    },
    {
      id: 'candidate_gross_revenue',
      label: '含税收入',
      description: '退款扣减前的订单含税收入',
      semanticObjectId: 'gross_revenue',
      candidateVersion: 'clarification-v1',
    },
  ],
}

const permissionError: RunError = {
  code: 'PERMISSION_DENIED',
  userMessage: '无权访问该内容',
  retryable: false,
  debugReference: 'sec_demo_001',
}

const budgetError: RunError = {
  code: 'QUERY_TOO_EXPENSIVE',
  userMessage: '查询范围过大，请缩短时间或增加筛选条件',
  retryable: true,
  debugReference: 'budget_demo_001',
  safeDetails: '预计扫描量超过工作空间预算',
}

function successRun(): Run {
  const querying = transitionRun(submitted('run_success', '过去三个月净收入趋势'), {
    type: 'QUERY_STARTED',
    at: '2026-06-22T09:00:00.500+08:00',
  })
  return transitionRun(querying, { type: 'RESULT_READY', result: trendResult, at: '2026-06-22T09:00:01+08:00' })
}

function emptyRun(): Run {
  const querying = transitionRun(submitted('run_empty', '查看尚未上线区域的昨日收入'), {
    type: 'QUERY_STARTED',
    at: '2026-06-22T09:00:00.500+08:00',
  })
  return transitionRun(querying, { type: 'RESULT_READY', result: emptyResult, at: '2026-06-22T09:00:01+08:00' })
}

export const questionScenarios: Readonly<Record<ScenarioId, QuestionScenario>> = {
  success: { id: 'success', question: '过去三个月净收入趋势', run: successRun(), executedQuery: true },
  clarification: {
    id: 'clarification',
    question: '最近收入怎么样？',
    run: transitionRun(submitted('run_clarification', '最近收入怎么样？'), {
      type: 'CLARIFICATION_REQUIRED', clarification: metricClarification, at: '2026-06-22T09:00:00.500+08:00',
    }),
    executedQuery: false,
  },
  permission_denied: {
    id: 'permission_denied',
    question: '列出其他事业部的客户手机号和订单',
    run: transitionRun(submitted('run_denied', '列出其他事业部的客户手机号和订单'), {
      type: 'FAILED', error: permissionError, at: '2026-06-22T09:00:00.500+08:00',
    }),
    executedQuery: false,
  },
  over_budget: {
    id: 'over_budget',
    question: '查询全部历史订单明细',
    run: transitionRun(submitted('run_budget', '查询全部历史订单明细'), {
      type: 'FAILED', error: budgetError, at: '2026-06-22T09:00:00.500+08:00',
    }),
    executedQuery: false,
  },
  empty_result: { id: 'empty_result', question: '查看尚未上线区域的昨日收入', run: emptyRun(), executedQuery: true },
  cancelled: {
    id: 'cancelled',
    question: '按城市分析过去一年净收入',
    run: transitionRun(submitted('run_cancelled', '按城市分析过去一年净收入'), {
      type: 'CANCELLED', at: '2026-06-22T09:00:00.300+08:00',
    }),
    executedQuery: false,
  },
}

export function getQuestionScenario(id: ScenarioId): QuestionScenario {
  return questionScenarios[id]
}
