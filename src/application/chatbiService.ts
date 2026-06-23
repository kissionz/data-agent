import {
  createWaitingRun,
  sanitizeRunError,
  transitionRun,
  type Conversation,
  type Run,
  type RunError,
  type RunResult,
} from '../domain'
import { attachRun } from '../domain'
import { emptyResult, partialTrendResult, trendResult } from '../mocks'
import { createInMemoryChatBiPersistence } from '../persistence/memory'
import type { ChatBiPersistence, StoredRunRecord } from '../persistence/ports'
import { compileAnalysisQuery, executeReadOnlyQuery } from '../query'
import {
  ANALYSIS_IR_VERSION,
  CONTRACT_VERSION,
  assertAnalysisIR,
  toPublicError,
  validateActor,
  validateSubmitQuestionRequest,
  type ActorContext,
  type AnalysisIR,
  type ApiEnvelope,
  type AuditEvent,
  type CancelRunRequest,
  type ClarifyRunRequest,
  type GetRunRequest,
  type PublicRunView,
  type SubmitQuestionRequest,
} from '../contracts'

export interface ChatBiApplicationService {
  submitQuestion(request: SubmitQuestionRequest): ApiEnvelope<PublicRunView>
  clarifyRun(request: ClarifyRunRequest): ApiEnvelope<PublicRunView>
  cancelRun(request: CancelRunRequest): ApiEnvelope<PublicRunView>
  getRun(request: GetRunRequest): ApiEnvelope<PublicRunView>
}

export interface ChatBiApplicationOptions {
  now?: () => string
  persistence?: ChatBiPersistence
}

export function createChatBiApplicationService(
  nowOrOptions: (() => string) | ChatBiApplicationOptions = () => new Date().toISOString(),
): ChatBiApplicationService {
  const now = typeof nowOrOptions === 'function' ? nowOrOptions : nowOrOptions.now ?? (() => new Date().toISOString())
  const persistence = typeof nowOrOptions === 'function'
    ? createInMemoryChatBiPersistence()
    : nowOrOptions.persistence ?? createInMemoryChatBiPersistence()
  let sequence = 0

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${String(sequence).padStart(4, '0')}`
  }

  function ensureConversation(request: SubmitQuestionRequest): Conversation {
    const existing = persistence.getConversation(request.conversationId)
    if (existing) return existing
    const createdAt = now()
    const conversation: Conversation = {
      id: request.conversationId,
      tenantId: request.actor.tenantId,
      workspaceId: request.actor.workspaceId,
      title: request.question.slice(0, 32),
      businessDomainId: request.actor.businessDomainId,
      mode: request.mode,
      semanticVersion: request.actor.semanticVersion,
      createdBy: request.actor.userId,
      createdAt,
      updatedAt: createdAt,
      state: {
        metrics: { value: ['net_revenue'], source: 'system_default' },
        dimensions: { value: ['order_date'], source: 'system_default' },
        filters: { value: {}, source: 'system_default' },
        timeRange: { value: 'last_12_complete_months', source: 'system_default' },
        grain: { value: 'month', source: 'system_default' },
        presentation: { value: 'line', source: 'system_default' },
        assumptions: ['默认使用已认证指标和完整自然月。'],
      },
    }
    persistence.saveConversation(conversation)
    return conversation
  }

  function persist(stored: StoredRunRecord) {
    persistence.saveRun(stored)
    const conversation = persistence.getConversation(stored.run.conversationId)
    if (conversation) persistence.saveConversation(attachRun(conversation, stored.run))
    return view(stored)
  }

  function boundaryError(actor: ActorContext, requestId: string, traceId: string): ApiEnvelope<PublicRunView> {
    return {
      ok: false,
      requestId,
      traceId,
      error: {
        code: 'PERMISSION_DENIED',
        message: '无权访问该内容',
        retryable: false,
        debugReference: `sec_${actor.workspaceId}`,
      },
    }
  }

  function getStored(runId: string, conversationId: string, actor: ActorContext, requestId = nextId('req'), traceId = nextId('trace')) {
    const actorError = validateActor(actor)
    if (actorError) return { envelope: { ok: false, error: actorError, requestId, traceId } as ApiEnvelope<PublicRunView> }
    const stored = persistence.getRun(runId)
    if (!stored) {
      return {
        envelope: {
          ok: false,
          requestId,
          traceId,
          error: {
            code: 'SEMANTIC_NOT_FOUND',
            message: '没有找到对应运行记录',
            retryable: false,
            debugReference: `run_${runId}`,
          },
        } as ApiEnvelope<PublicRunView>,
      }
    }
    if (
      stored.run.conversationId !== conversationId
      || stored.run.tenantId !== actor.tenantId
      || stored.run.workspaceId !== actor.workspaceId
    ) {
      return { envelope: boundaryError(actor, requestId, traceId) }
    }
    return { stored, requestId, traceId }
  }

  function audit(type: AuditEvent['type'], actor: ActorContext, runId: string, summary: string): AuditEvent {
    return {
      id: nextId('audit'),
      at: now(),
      type,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      workspaceId: actor.workspaceId,
      runId,
      summary,
    }
  }

  function makeIr(request: SubmitQuestionRequest, runId: string, intent: AnalysisIR['intent'], options: Partial<AnalysisIR['safety']> = {}): AnalysisIR {
    const ir: AnalysisIR = {
      schemaVersion: ANALYSIS_IR_VERSION,
      irId: `ir_${runId}`,
      revision: 1,
      mode: request.mode,
      semanticVersion: request.actor.semanticVersion,
      intent,
      metricIds: ['net_revenue'],
      dimensionIds: intent === 'breakdown' ? ['region'] : ['order_date'],
      filters: [],
      timeRange: {
        kind: 'relative',
        expression: /最近/.test(request.question) ? 'last_30_complete_days' : 'last_12_complete_months',
        timezone: request.actor.timezone,
        grain: /最近/.test(request.question) ? 'day' : 'month',
      },
      limit: 500,
      assumptions: ['使用当前工作空间授权范围内的认证指标。'],
      safety: {
        requiresClarification: false,
        executedQuery: false,
        permissionChecked: true,
        budgetChecked: true,
        ...options,
      },
    }
    assertAnalysisIR(ir)
    return ir
  }

  function selectResult(question: string): RunResult {
    if (/尚未上线|没有数据|空结果/.test(question)) return emptyResult
    if (/部分|区域贡献|超时/.test(question)) return partialTrendResult
    return trendResult
  }

  function view(stored: StoredRunRecord): ApiEnvelope<PublicRunView> {
    return {
      ok: true,
      requestId: stored.requestId,
      traceId: stored.traceId,
      data: {
        contractVersion: CONTRACT_VERSION,
        requestId: stored.requestId,
        traceId: stored.traceId,
        runId: stored.run.id,
        conversationId: stored.run.conversationId,
        question: stored.run.question,
        displayStatus: stored.run.displayStatus,
        mode: stored.run.mode,
        semanticVersion: stored.run.semanticVersion,
        version: stored.run.version,
        executedQuery: stored.executedQuery,
        analysisIr: stored.analysisIr,
        queryExecution: stored.queryExecution,
        clarification: stored.run.clarification,
        result: stored.run.result,
        error: stored.run.error ? toPublicError(stored.run.error) : undefined,
        audit: stored.audit,
        updatedAt: stored.run.updatedAt,
      },
    }
  }

  return {
    submitQuestion(request) {
      const requestId = nextId('req')
      const traceId = nextId('trace')
      const validation = validateSubmitQuestionRequest(request)
      if (validation) return { ok: false, requestId, traceId, error: validation }

      const existingRunId = persistence.getRunIdByIdempotencyKey(request.idempotencyKey)
      if (existingRunId) {
        const existing = persistence.getRun(existingRunId)
        if (existing) return view(existing)
      }

      const conversation = ensureConversation(request)
      if (conversation.activeRunId) {
        return {
          ok: false,
          requestId,
          traceId,
          error: {
            code: 'RUN_ALREADY_ACTIVE',
            message: '当前会话已有运行中的问题，请先完成、澄清或取消。',
            retryable: true,
            debugReference: conversation.activeRunId,
          },
        }
      }

      const createdAt = now()
      let run = createWaitingRun({
        id: nextId('run'),
        tenantId: request.actor.tenantId,
        workspaceId: request.actor.workspaceId,
        conversationId: request.conversationId,
        question: request.question.trim(),
        mode: request.mode,
        semanticVersion: request.actor.semanticVersion,
        createdAt,
      })
      run = transitionRun(run, { type: 'QUESTION_SUBMITTED', at: now() })
      const auditEvents = [audit('question.accepted', request.actor, run.id, '问题已接收并进入规划。')]

      if (/其他事业部|手机号|忽略权限/.test(run.question)) {
        const error: RunError = sanitizeRunError({
          code: 'PERMISSION_DENIED',
          userMessage: '无权访问该内容',
          retryable: false,
          debugReference: `sec_${run.id}`,
        })
        run = transitionRun(run, { type: 'FAILED', error, at: now() })
        const stored: StoredRunRecord = {
          run,
          requestId,
          traceId,
          executedQuery: false,
          audit: [...auditEvents, audit('security.denied', request.actor, run.id, '权限校验拒绝，未执行查询。')],
        }
        persistence.saveIdempotencyKey(request.idempotencyKey, run.id)
        return persist(stored)
      }

      if (/全部历史|明细|全量/.test(run.question)) {
        const error: RunError = {
          code: 'QUERY_TOO_EXPENSIVE',
          userMessage: '查询范围过大，请缩短时间或增加筛选条件',
          retryable: true,
          debugReference: `budget_${run.id}`,
          safeDetails: '预计扫描量超过工作空间预算',
        }
        run = transitionRun(run, { type: 'FAILED', error, at: now() })
        const stored: StoredRunRecord = {
          run,
          requestId,
          traceId,
          executedQuery: false,
          audit: [...auditEvents, audit('planner.ir_created', request.actor, run.id, '预算门禁阻断，未执行查询。')],
        }
        persistence.saveIdempotencyKey(request.idempotencyKey, run.id)
        return persist(stored)
      }

      if (/最近|销售情况/.test(run.question) && !/12|月|季度|年度/.test(run.question)) {
        const analysisIr = makeIr(request, run.id, 'clarification', { requiresClarification: true })
        const clarification = {
          reasonCode: 'metric_ambiguity' as const,
          prompt: '“销售情况”需要确认口径',
          irRevision: analysisIr.revision,
          expiresAt: '2026-06-23T23:59:59+08:00',
          candidates: [
            {
              id: 'candidate_net_revenue',
              label: '净收入',
              description: '最近 30 个完整自然日，扣除退款后的认证收入。',
              semanticObjectId: 'net_revenue',
              candidateVersion: 'clarification-v1',
            },
            {
              id: 'candidate_completed_orders',
              label: '已完成订单数',
              description: '最近 30 个完整自然日，完成支付且未全额退款订单。',
              semanticObjectId: 'completed_order_count',
              candidateVersion: 'clarification-v1',
            },
          ],
        }
        run = transitionRun(run, { type: 'CLARIFICATION_REQUIRED', clarification, at: now() })
        const stored: StoredRunRecord = {
          run,
          requestId,
          traceId,
          executedQuery: false,
          analysisIr,
          audit: [...auditEvents, audit('planner.clarification_required', request.actor, run.id, '关键指标口径多义，等待用户澄清。')],
        }
        persistence.saveIdempotencyKey(request.idempotencyKey, run.id)
        return persist(stored)
      }

      const analysisIr = makeIr(request, run.id, /区域|城市/.test(run.question) ? 'breakdown' : 'trend', { executedQuery: true })
      const compiledPlan = compileAnalysisQuery({ ir: analysisIr, actor: request.actor })
      const execution = executeReadOnlyQuery({ plan: compiledPlan, actor: request.actor })
      run = transitionRun(run, { type: 'QUERY_STARTED', at: now() })
      const result = selectResult(run.question)
      run = transitionRun(run, { type: 'RESULT_READY', result, at: now() })
      const stored: StoredRunRecord = {
        run,
        requestId,
        traceId,
        executedQuery: true,
        analysisIr,
        queryExecution: execution.summary,
        audit: [
          ...auditEvents,
          audit('planner.ir_created', request.actor, run.id, 'Analysis IR 已创建并通过语义、权限和预算校验。'),
          audit('compiler.plan_created', request.actor, run.id, `确定性 SQL 计划已创建，指纹 ${execution.summary.sqlFingerprint}。`),
          audit('query.started', request.actor, run.id, '查询网关开始执行，只读与预算门禁已生效。'),
          audit('query.completed', request.actor, run.id, `查询完成，缓存键 ${execution.summary.cacheKey}。`),
          audit('result.ready', request.actor, run.id, '确定性答案已从结果集生成。'),
        ],
      }
      persistence.saveIdempotencyKey(request.idempotencyKey, run.id)
      return persist(stored)
    },

    clarifyRun(request) {
      const found = getStored(request.runId, request.conversationId, request.actor)
      if (found.envelope) return found.envelope
      const stored = found.stored!
      try {
        let run = transitionRun(stored.run, {
          type: 'CLARIFICATION_RESOLVED',
          candidateId: request.candidateId,
          candidateVersion: request.candidateVersion,
          at: now(),
        })
        run = transitionRun(run, { type: 'QUERY_STARTED', at: now() })
        run = transitionRun(run, { type: 'RESULT_READY', result: trendResult, at: now() })
        const analysisIr: AnalysisIR = {
          ...(stored.analysisIr ?? makeIr({
            idempotencyKey: `clarify_${request.runId}`,
            conversationId: request.conversationId,
            question: run.question,
            mode: run.mode,
            actor: request.actor,
          }, run.id, 'trend')),
          intent: 'trend',
          metricIds: [request.candidateId.includes('orders') ? 'completed_order_count' : 'net_revenue'],
          filters: [{
            dimensionId: 'clarified_metric',
            operator: 'eq',
            values: [request.candidateId],
            source: 'clarification',
          }],
          safety: {
            requiresClarification: false,
            executedQuery: true,
            permissionChecked: true,
            budgetChecked: true,
          },
        }
        assertAnalysisIR(analysisIr)
        const compiledPlan = compileAnalysisQuery({ ir: analysisIr, actor: request.actor })
        const execution = executeReadOnlyQuery({ plan: compiledPlan, actor: request.actor })
        const nextStored: StoredRunRecord = {
          ...stored,
          run,
          executedQuery: true,
          analysisIr,
          queryExecution: execution.summary,
          audit: [
            ...stored.audit,
            audit('planner.ir_created', request.actor, run.id, '澄清结果已绑定到新版 Analysis IR。'),
            audit('compiler.plan_created', request.actor, run.id, `澄清后 SQL 计划已创建，指纹 ${execution.summary.sqlFingerprint}。`),
            audit('query.started', request.actor, run.id, '澄清后查询开始执行，只读与预算门禁已生效。'),
            audit('query.completed', request.actor, run.id, `澄清后查询完成，缓存键 ${execution.summary.cacheKey}。`),
            audit('result.ready', request.actor, run.id, '答案已生成。'),
          ],
        }
        return persist(nextStored)
      } catch (error) {
        return {
          ok: false,
          requestId: found.requestId!,
          traceId: found.traceId!,
          error: {
            code: 'VALIDATION_FAILED',
            message: error instanceof Error ? error.message : '澄清请求无效',
            retryable: true,
            debugReference: `clarify_${request.runId}`,
          },
        }
      }
    },

    cancelRun(request) {
      const found = getStored(request.runId, request.conversationId, request.actor)
      if (found.envelope) return found.envelope
      try {
        const run = transitionRun(found.stored!.run, { type: 'CANCELLED', at: now() })
        return persist({
          ...found.stored!,
          run,
          executedQuery: false,
          audit: [...found.stored!.audit, audit('query.cancelled', request.actor, run.id, '用户取消运行，当前未暴露结果。')],
        })
      } catch (error) {
        return {
          ok: false,
          requestId: found.requestId!,
          traceId: found.traceId!,
          error: {
            code: 'RUN_CANCELLED',
            message: error instanceof Error ? error.message : '当前运行不可取消',
            retryable: false,
            debugReference: `cancel_${request.runId}`,
          },
        }
      }
    },

    getRun(request) {
      const found = getStored(request.runId, request.conversationId, request.actor)
      if (found.envelope) return found.envelope
      return view(found.stored!)
    },
  }
}
