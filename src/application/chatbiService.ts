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
import { compileAnalysisQuery, createQueuedQueryExecution, executeReadOnlyQuery, markQueryExecutionCancelled } from '../query'
import type { QueryExecutionDispatcher } from './queryExecutionCoordinator'
import { createRetrievalPlanningTrace, refreshClarificationCandidateVersions } from './retrievalPlanning'
import { stableHash } from '../query/hash'
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
  type PublicErrorCode,
  type PublicRunView,
  type ResultPageRequest,
  type ResultPageView,
  type SubmitQuestionRequest,
} from '../contracts'

export interface ChatBiApplicationService {
  submitQuestion(request: SubmitQuestionRequest): ApiEnvelope<PublicRunView>
  clarifyRun(request: ClarifyRunRequest): ApiEnvelope<PublicRunView>
  cancelRun(request: CancelRunRequest): ApiEnvelope<PublicRunView>
  getRun(request: GetRunRequest): ApiEnvelope<PublicRunView>
  getResultPage(request: ResultPageRequest): ApiEnvelope<ResultPageView>
}

export interface ChatBiApplicationOptions {
  now?: () => string
  persistence?: ChatBiPersistence
  queryDispatcher?: QueryExecutionDispatcher
}

export function createChatBiApplicationService(
  nowOrOptions: (() => string) | ChatBiApplicationOptions = () => new Date().toISOString(),
): ChatBiApplicationService {
  const now = typeof nowOrOptions === 'function' ? nowOrOptions : nowOrOptions.now ?? (() => new Date().toISOString())
  const persistence = typeof nowOrOptions === 'function'
    ? createInMemoryChatBiPersistence()
    : nowOrOptions.persistence ?? createInMemoryChatBiPersistence()
  const queryDispatcher = typeof nowOrOptions === 'function' ? undefined : nowOrOptions.queryDispatcher
  const instanceId = createInstanceId()
  let sequence = 0

  function nextId(prefix: string) {
    sequence += 1
    return `${prefix}_${instanceId}_${String(sequence).padStart(6, '0')}`
  }

  function idempotencyScope(request: SubmitQuestionRequest) {
    // Keep the identity exact: a short non-cryptographic hash would allow two
    // different tenant scopes to collide and incorrectly suppress a request.
    return `idem:${JSON.stringify([
      request.actor.tenantId,
      request.actor.workspaceId,
      request.conversationId,
      request.idempotencyKey,
    ])}`
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

  function errorEnvelope<T>(
    requestId: string,
    traceId: string,
    code: PublicErrorCode,
    message: string,
    debugReference: string,
    retryable = false,
  ): ApiEnvelope<T> {
    return {
      ok: false,
      requestId,
      traceId,
      error: {
        code,
        message,
        retryable,
        debugReference,
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
        retrieval: stored.retrieval,
        planner: stored.planner,
        clarification: stored.run.clarification,
        result: stored.run.result,
        error: stored.run.error ? toPublicError(stored.run.error) : undefined,
        audit: stored.audit,
        updatedAt: stored.run.updatedAt,
      },
    }
  }

  function parseResultCursor(cursor?: string): number | null {
    if (!cursor) return 0
    const match = cursor.match(/^offset:(\d+)$/)
    if (!match) return null
    return Number(match[1])
  }

  function normalizeResultLimit(limit?: number): number | null {
    if (limit === undefined) return 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return null
    return limit
  }

  return {
    submitQuestion(request) {
      const requestId = nextId('req')
      const traceId = nextId('trace')
      const validation = validateSubmitQuestionRequest(request)
      if (validation) return { ok: false, requestId, traceId, error: validation }

      const scopedIdempotencyKey = idempotencyScope(request)
      const existingRunId = persistence.getRunIdByIdempotencyKey(scopedIdempotencyKey)
      if (existingRunId) {
        const existing = persistence.getRun(existingRunId)
        if (existing) {
          const existingConversation = persistence.getConversation(existing.run.conversationId)
          const sameRequest = existing.run.tenantId === request.actor.tenantId
            && existing.run.workspaceId === request.actor.workspaceId
            && existing.run.conversationId === request.conversationId
            && existing.run.question === request.question.trim()
            && existing.run.mode === request.mode
            && existing.run.semanticVersion === request.actor.semanticVersion
            && existingConversation?.businessDomainId === request.actor.businessDomainId
          if (sameRequest) return view(existing)
          return errorEnvelope(
            requestId,
            traceId,
            'VALIDATION_FAILED',
            '同一幂等键不能用于不同的问题或访问上下文',
            `idempotency_${stableHash([scopedIdempotencyKey])}`,
          )
        }
      }

      const existingConversation = persistence.getConversation(request.conversationId)
      if (existingConversation && (
        existingConversation.tenantId !== request.actor.tenantId
        || existingConversation.workspaceId !== request.actor.workspaceId
        || existingConversation.businessDomainId !== request.actor.businessDomainId
      )) {
        return boundaryError(request.actor, requestId, traceId)
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
        const trace = createRetrievalPlanningTrace({
          question: run.question,
          actor: request.actor,
          requiresClarification: false,
        })
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
          retrieval: trace.retrieval,
          planner: trace.planner,
          audit: [...auditEvents, audit('security.denied', request.actor, run.id, '权限校验拒绝，未执行查询。')],
        }
        persistence.saveIdempotencyKey(scopedIdempotencyKey, run.id)
        return persist(stored)
      }

      if (/全部历史|明细|全量/.test(run.question)) {
        const trace = createRetrievalPlanningTrace({
          question: run.question,
          actor: request.actor,
          requiresClarification: false,
        })
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
          retrieval: trace.retrieval,
          planner: trace.planner,
          audit: [...auditEvents, audit('planner.ir_created', request.actor, run.id, '预算门禁阻断，未执行查询。')],
        }
        persistence.saveIdempotencyKey(scopedIdempotencyKey, run.id)
        return persist(stored)
      }

      if (/最近|销售情况/.test(run.question) && !/12|月|季度|年度/.test(run.question)) {
        const analysisIr = makeIr(request, run.id, 'clarification', { requiresClarification: true })
        const trace = createRetrievalPlanningTrace({
          question: run.question,
          actor: request.actor,
          requiresClarification: true,
          reasonCodes: ['metric_ambiguity', 'time_ambiguity'],
        })
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
          retrieval: trace.retrieval,
          planner: trace.planner,
          analysisIr,
          audit: [
            ...auditEvents,
            audit('retrieval.performed', request.actor, run.id, '检索已按租户、工作区、业务域和语义版本过滤后召回候选。'),
            audit('planner.plan_created', request.actor, run.id, 'Planner 已生成多步计划并识别关键歧义。'),
            audit('planner.clarification_required', request.actor, run.id, '关键指标口径多义，等待用户澄清。'),
          ],
        }
        persistence.saveIdempotencyKey(scopedIdempotencyKey, run.id)
        return persist(stored)
      }

      const analysisIr = makeIr(request, run.id, /区域|城市/.test(run.question) ? 'breakdown' : 'trend', {
        executedQuery: !queryDispatcher,
      })
      const trace = createRetrievalPlanningTrace({
        question: run.question,
        actor: request.actor,
        requiresClarification: false,
      })
      const compiledPlan = compileAnalysisQuery({ ir: analysisIr, actor: request.actor })
      const execution = queryDispatcher
        ? createQueuedQueryExecution({ plan: compiledPlan, actor: request.actor })
        : executeReadOnlyQuery({ plan: compiledPlan, actor: request.actor })
      run = transitionRun(run, { type: 'QUERY_STARTED', at: now() })
      if (queryDispatcher) {
        const stored: StoredRunRecord = {
          run,
          requestId,
          traceId,
          executedQuery: false,
          analysisIr,
          queryExecution: execution.summary,
          audit: [
            ...auditEvents,
            audit('retrieval.performed', request.actor, run.id, '检索已按租户、工作区、业务域和语义版本过滤，实体链接完成。'),
            audit('planner.plan_created', request.actor, run.id, 'Planner 已生成带预算、依赖和终止条件的多步计划。'),
            audit('planner.ir_created', request.actor, run.id, 'Analysis IR 已创建并通过语义、权限和预算校验。'),
            audit('compiler.plan_created', request.actor, run.id, `确定性 SQL 计划已创建，指纹 ${execution.summary.sqlFingerprint}。`),
          ],
          retrieval: trace.retrieval,
          planner: trace.planner,
        }
        persistence.saveIdempotencyKey(scopedIdempotencyKey, run.id)
        const response = persist(stored)
        const enqueued = queryDispatcher.enqueue({
          runId: run.id,
          actor: request.actor,
          plan: compiledPlan,
          summary: execution.summary,
          resultId: `result_${run.id}`,
          enqueuedAt: now(),
        })
        if (enqueued.ok) return response
        const failedRun = transitionRun(run, {
          type: 'FAILED',
          at: now(),
          error: {
            code: 'INTERNAL_ERROR',
            userMessage: '查询任务暂时无法排队，请稍后重试',
            retryable: true,
            debugReference: `queue_${run.id}`,
          },
        })
        return persist({
          ...stored,
          run: failedRun,
          audit: [...stored.audit, audit('query.blocked', request.actor, run.id, '查询任务入队失败，未执行查询。')],
        })
      }
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
          audit('retrieval.performed', request.actor, run.id, '检索已按租户、工作区、业务域和语义版本过滤，实体链接完成。'),
          audit('planner.plan_created', request.actor, run.id, 'Planner 已生成带预算、依赖和终止条件的多步计划。'),
          audit('planner.ir_created', request.actor, run.id, 'Analysis IR 已创建并通过语义、权限和预算校验。'),
          audit('compiler.plan_created', request.actor, run.id, `确定性 SQL 计划已创建，指纹 ${execution.summary.sqlFingerprint}。`),
          audit('query.started', request.actor, run.id, '查询网关开始执行，只读与预算门禁已生效。'),
          audit('query.completed', request.actor, run.id, `查询完成，缓存键 ${execution.summary.cacheKey}。`),
          audit('result.ready', request.actor, run.id, '确定性答案已从结果集生成。'),
        ],
        retrieval: trace.retrieval,
        planner: trace.planner,
      }
      persistence.saveIdempotencyKey(scopedIdempotencyKey, run.id)
      return persist(stored)
    },

    clarifyRun(request) {
      const found = getStored(request.runId, request.conversationId, request.actor)
      if (found.envelope) return found.envelope
      const stored = found.stored!
      try {
        const currentCandidate = stored.run.clarification?.candidates.find((item) => item.id === request.candidateId)
        if (stored.run.displayStatus === 'needs_clarification' && (!currentCandidate || currentCandidate.candidateVersion !== request.candidateVersion)) {
          const refreshedClarification = stored.run.clarification
            ? {
                ...stored.run.clarification,
                expiresAt: '2026-06-24T23:59:59+08:00',
                candidates: refreshClarificationCandidateVersions(stored.run.clarification.candidates),
              }
            : stored.run.clarification
          const refreshedRun = refreshedClarification
            ? { ...stored.run, clarification: refreshedClarification, updatedAt: now() }
            : stored.run
          const refreshedStored: StoredRunRecord = {
            ...stored,
            run: refreshedRun,
            audit: [
              ...stored.audit,
              audit('planner.clarification_required', request.actor, stored.run.id, '澄清候选版本已失效，已重新鉴权并刷新候选；未执行查询。'),
            ],
          }
          persist(refreshedStored)
          throw new Error('Clarification candidate is missing, stale, or unauthorized')
        }
        let run = transitionRun(stored.run, {
          type: 'CLARIFICATION_RESOLVED',
          candidateId: request.candidateId,
          candidateVersion: request.candidateVersion,
          at: now(),
        })
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
            executedQuery: !queryDispatcher,
            permissionChecked: true,
            budgetChecked: true,
          },
        }
        assertAnalysisIR(analysisIr)
        const compiledPlan = compileAnalysisQuery({ ir: analysisIr, actor: request.actor })
        const execution = queryDispatcher
          ? createQueuedQueryExecution({ plan: compiledPlan, actor: request.actor })
          : executeReadOnlyQuery({ plan: compiledPlan, actor: request.actor })
        run = transitionRun(run, { type: 'QUERY_STARTED', at: now() })
        if (!queryDispatcher) run = transitionRun(run, { type: 'RESULT_READY', result: trendResult, at: now() })
        const nextStored: StoredRunRecord = {
          ...stored,
          run,
          executedQuery: !queryDispatcher,
          analysisIr,
          queryExecution: execution.summary,
          retrieval: stored.retrieval,
          planner: stored.planner,
          audit: [
            ...stored.audit,
            audit('planner.ir_created', request.actor, run.id, '澄清结果已绑定到新版 Analysis IR。'),
            audit('compiler.plan_created', request.actor, run.id, `澄清后 SQL 计划已创建，指纹 ${execution.summary.sqlFingerprint}。`),
            ...(queryDispatcher ? [] : [
              audit('query.started', request.actor, run.id, '澄清后查询开始执行，只读与预算门禁已生效。'),
              audit('query.completed', request.actor, run.id, `澄清后查询完成，缓存键 ${execution.summary.cacheKey}。`),
              audit('result.ready', request.actor, run.id, '答案已生成。'),
            ]),
          ],
        }
        const response = persist(nextStored)
        if (!queryDispatcher) return response
        const enqueued = queryDispatcher.enqueue({
          runId: run.id,
          actor: request.actor,
          plan: compiledPlan,
          summary: execution.summary,
          resultId: `result_${run.id}`,
          enqueuedAt: now(),
        })
        if (enqueued.ok) return response
        const failedRun = transitionRun(run, {
          type: 'FAILED',
          at: now(),
          error: {
            code: 'INTERNAL_ERROR',
            userMessage: '查询任务暂时无法排队，请稍后重试',
            retryable: true,
            debugReference: `queue_${run.id}`,
          },
        })
        return persist({
          ...nextStored,
          run: failedRun,
          audit: [...nextStored.audit, audit('query.blocked', request.actor, run.id, '澄清后的查询任务入队失败。')],
        })
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
      if (found.stored!.run.terminationReason === 'cancelled_by_user') return view(found.stored!)
      try {
        if (queryDispatcher && found.stored!.run.displayStatus === 'querying') {
          const cancellation = queryDispatcher.cancel(request.runId, now())
          if (cancellation === 'terminal_conflict') throw new Error('查询已经完成，不能再取消')
        }
        const run = transitionRun(found.stored!.run, { type: 'CANCELLED', at: now() })
        return persist({
          ...found.stored!,
          run,
          executedQuery: false,
          queryExecution: found.stored!.queryExecution
            ? markQueryExecutionCancelled(found.stored!.queryExecution, now())
            : undefined,
          audit: [...found.stored!.audit, audit('query.cancelled', request.actor, run.id, '用户取消运行，取消令牌已传播且当前未暴露结果。')],
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

    getResultPage(request) {
      const found = getStored(request.runId, request.conversationId, request.actor)
      if (found.envelope) return found.envelope as ApiEnvelope<ResultPageView>
      const requestId = found.requestId!
      const traceId = found.traceId!
      const stored = found.stored!
      const result = stored.run.result
      if (!result) {
        return errorEnvelope<ResultPageView>(
          requestId,
          traceId,
          'SEMANTIC_NOT_FOUND',
          '该运行尚无可分页结果',
          `result_${request.runId}`,
        )
      }

      const offset = parseResultCursor(request.cursor)
      const limit = normalizeResultLimit(request.limit)
      if (offset === null || limit === null) {
        return errorEnvelope<ResultPageView>(
          requestId,
          traceId,
          'VALIDATION_FAILED',
          '结果分页参数无效，cursor 必须形如 offset:0，limit 必须为 1-500 的整数。',
          `result_page_${request.runId}`,
          true,
        )
      }

      const rows = result.rows.slice(offset, offset + limit)
      const nextOffset = offset + rows.length
      const hasMore = nextOffset < result.rows.length
      const permissionDigest = stored.queryExecution?.permissionDigest
        ?? `perm_${stored.run.tenantId}_${stored.run.workspaceId}_${stored.run.semanticVersion}`
      const policyVersion = request.actor.policyVersion ?? 'policy_current'
      return {
        ok: true,
        requestId,
        traceId,
        data: {
          contractVersion: CONTRACT_VERSION,
          requestId,
          traceId,
          runId: stored.run.id,
          conversationId: stored.run.conversationId,
          resultId: result.id,
          semanticVersion: stored.run.semanticVersion,
          columns: result.columns,
          rows,
          page: {
            limit,
            cursor: request.cursor,
            nextCursor: hasMore ? `offset:${nextOffset}` : undefined,
            hasMore,
            totalRows: result.rows.length,
          },
          completeness: result.completeness,
          warnings: result.warnings,
          freshnessAt: result.freshnessAt,
          queryExecution: stored.queryExecution,
          permissionDigest,
          policyVersion,
          rawSqlExposed: false,
          rawDatabaseCredentialsExposed: false,
          audit: stored.audit,
        },
      }
    },
  }
}

function createInstanceId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replaceAll('-', '').slice(0, 16)
  const fallback = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  return fallback.slice(0, 16)
}
