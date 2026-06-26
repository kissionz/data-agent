import {
  ANALYSIS_IR_VERSION,
  type ActorContext,
  type PlannerTraceView,
  type RetrievalTraceView,
} from '../contracts'

export interface RetrievalPlanningTrace {
  retrieval: RetrievalTraceView
  planner: PlannerTraceView
}

export function createRetrievalPlanningTrace(input: {
  question: string
  actor: ActorContext
  requiresClarification: boolean
  reasonCodes?: PlannerTraceView['ambiguity']['reasonCodes']
}): RetrievalPlanningTrace {
  const normalizedQuestion = normalizeQuestion(input.question)
  const metricAmbiguous = input.requiresClarification || /销售情况|收入怎么样/.test(normalizedQuestion)
  const entityLinks: RetrievalTraceView['entityLinks'] = [
    metricAmbiguous
      ? {
          entityType: 'metric',
          sourceText: metricSourceText(normalizedQuestion),
          label: '销售口径候选',
          confidence: 0.72,
          status: 'ambiguous',
          reason: '净收入与已完成订单数都匹配当前表达，必须澄清后才能执行查询。',
        }
      : {
          entityType: 'metric',
          sourceText: metricSourceText(normalizedQuestion),
          label: '净收入',
          semanticObjectId: 'net_revenue',
          confidence: 0.98,
          status: 'linked',
        },
    {
      entityType: 'dimension',
      sourceText: /区域|城市/.test(normalizedQuestion) ? '区域' : '时间',
      label: /区域|城市/.test(normalizedQuestion) ? '区域' : '订单日期',
      semanticObjectId: /区域|城市/.test(normalizedQuestion) ? 'region' : 'order_date',
      confidence: /区域|城市/.test(normalizedQuestion) ? 0.94 : 0.96,
      status: 'linked',
    },
    {
      entityType: 'time',
      sourceText: /最近/.test(normalizedQuestion) ? '最近' : '过去 12 个月',
      label: /最近/.test(normalizedQuestion) ? '最近 30 个完整自然日候选' : '过去 12 个完整自然月',
      confidence: /最近/.test(normalizedQuestion) ? 0.78 : 0.97,
      status: /最近/.test(normalizedQuestion) && metricAmbiguous ? 'ambiguous' : 'linked',
      reason: /最近/.test(normalizedQuestion) && metricAmbiguous ? '相对时间表达需要与指标口径一并确认。' : undefined,
    },
    {
      entityType: 'intent',
      sourceText: /区域|城市/.test(normalizedQuestion) ? '按区域' : '趋势',
      label: /区域|城市/.test(normalizedQuestion) ? 'breakdown' : 'trend',
      confidence: 0.93,
      status: 'linked',
    },
  ]

  const retrieval: RetrievalTraceView = {
    strategyVersion: 'local-retrieval-v0.2',
    normalizedQuestion,
    permissionFilter: {
      tenantId: input.actor.tenantId,
      workspaceId: input.actor.workspaceId,
      businessDomainId: input.actor.businessDomainId,
      semanticVersion: input.actor.semanticVersion,
      roles: input.actor.roles,
    },
    entityLinks,
    safeguards: {
      permissionFilteredBeforeRanking: true,
      exposesUnauthorizedCandidates: false,
      preservesOriginalConstraints: true,
    },
    qualityTargets: {
      entityLinkingF1: 0.95,
      lexicalCoverage: 0.95,
    },
  }

  const planner: PlannerTraceView = {
    plannerVersion: 'local-planner-v0.2',
    schemaVersion: ANALYSIS_IR_VERSION,
    normalizedQuestion,
    steps: [
      {
        id: 'load_context',
        input: 'actor + conversation state + original question',
        output: 'tenant/workspace/domain/semantic version constrained context',
        budget: { maxTokens: 256, maxQueries: 0, maxScanBytes: 0, timeoutMs: 100 },
        dependencies: [],
        terminationCondition: 'actor context validates and workspace boundary matches',
      },
      {
        id: 'retrieve_entities',
        input: 'normalized question + permission-filtered semantic catalog',
        output: 'ranked metric/dimension/time/intent links',
        budget: { maxTokens: 512, maxQueries: 1, maxScanBytes: 0, timeoutMs: 300 },
        dependencies: ['load_context'],
        terminationCondition: 'top candidates are linked or ambiguity is explicitly surfaced',
      },
      {
        id: input.requiresClarification ? 'request_clarification' : 'create_ir',
        input: 'entity links + budget guard + semantic compatibility checks',
        output: input.requiresClarification ? 'bounded clarification candidates without query execution' : 'AnalysisIR v1',
        budget: { maxTokens: 768, maxQueries: input.requiresClarification ? 0 : 1, maxScanBytes: input.requiresClarification ? 0 : 50 * 1024 * 1024, timeoutMs: 700 },
        dependencies: ['retrieve_entities'],
        terminationCondition: input.requiresClarification ? 'user selects a current candidate version' : 'IR passes JSON schema and safety guards',
      },
    ],
    ambiguity: {
      requiresClarification: input.requiresClarification,
      reasonCodes: input.reasonCodes ?? (input.requiresClarification ? ['metric_ambiguity', 'time_ambiguity'] : []),
      maxCandidates: 3,
    },
    replay: {
      originalQuestion: input.question,
      normalizedQuestion,
      retrievalStrategyVersion: retrieval.strategyVersion,
    },
  }

  return { retrieval, planner }
}

export function refreshClarificationCandidateVersions<T extends {
  candidateVersion: string
}>(candidates: T[], nextVersion = 'clarification-v2'): T[] {
  return candidates.map((candidate) => ({
    ...candidate,
    candidateVersion: nextVersion,
  }))
}

function normalizeQuestion(question: string) {
  return question.trim()
    .replace(/[？?]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/GMV/gi, '交易额')
}

function metricSourceText(question: string) {
  if (/净收入/.test(question)) return '净收入'
  if (/订单/.test(question)) return '订单'
  if (/销售|收入/.test(question)) return '销售/收入'
  return '核心指标'
}
