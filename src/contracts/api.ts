import type {
  Clarification,
  PublicErrorCode,
  RunDisplayStatus,
  RunMode,
  RunResult,
} from '../domain'

export type { PublicErrorCode } from '../domain'

export const CONTRACT_VERSION = 'chatbi.contracts.v0.2' as const
export const ANALYSIS_IR_VERSION = 'analysis_ir.v1' as const

export type UserRole =
  | 'business_user'
  | 'business_owner'
  | 'analyst'
  | 'metric_admin'
  | 'data_admin'
  | 'security_admin'
  | 'platform_ops'
  | 'service_account'

export interface ActorContext {
  tenantId: string
  workspaceId: string
  userId: string
  roles: UserRole[]
  businessDomainId: string
  semanticVersion: string
  locale: 'zh-CN'
  timezone: string
}

export interface TimeRangeIR {
  kind: 'relative' | 'absolute'
  expression: string
  timezone: string
  grain: 'day' | 'week' | 'month' | 'quarter' | 'year'
}

export interface FilterIR {
  dimensionId: string
  operator: 'eq' | 'in' | 'between' | 'contains'
  values: string[]
  source: 'user' | 'system_default' | 'clarification'
}

export interface AnalysisIR {
  schemaVersion: typeof ANALYSIS_IR_VERSION
  irId: string
  revision: number
  mode: RunMode
  semanticVersion: string
  intent: 'trend' | 'breakdown' | 'ranking' | 'lookup' | 'clarification' | 'empty_check'
  metricIds: string[]
  dimensionIds: string[]
  filters: FilterIR[]
  timeRange: TimeRangeIR
  limit: number
  assumptions: string[]
  safety: {
    requiresClarification: boolean
    executedQuery: boolean
    permissionChecked: boolean
    budgetChecked: boolean
  }
}

export interface AuditEvent {
  id: string
  at: string
  type:
    | 'question.accepted'
    | 'planner.ir_created'
    | 'planner.clarification_required'
    | 'security.denied'
    | 'query.started'
    | 'query.completed'
    | 'query.cancelled'
    | 'result.ready'
  actorUserId: string
  tenantId: string
  workspaceId: string
  runId: string
  summary: string
}

export interface PublicRunView {
  contractVersion: typeof CONTRACT_VERSION
  requestId: string
  traceId: string
  runId: string
  conversationId: string
  question: string
  displayStatus: RunDisplayStatus
  mode: RunMode
  semanticVersion: string
  version: number
  executedQuery: boolean
  analysisIr?: AnalysisIR
  clarification?: Clarification
  result?: RunResult
  error?: PublicApiError
  audit: AuditEvent[]
  updatedAt: string
}

export interface PublicApiError {
  code: PublicErrorCode
  message: string
  retryable: boolean
  debugReference: string
}

export interface PublicErrorCatalogItem {
  httpStatus: 200 | 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503
  title: string
  retryableDefault: boolean
  safeForUser: boolean
}

export const PUBLIC_ERROR_CATALOG = {
  AMBIGUOUS_QUERY: { httpStatus: 422, title: '问题需要澄清', retryableDefault: true, safeForUser: true },
  SEMANTIC_NOT_FOUND: { httpStatus: 404, title: '语义对象不存在或不可见', retryableDefault: false, safeForUser: true },
  PERMISSION_DENIED: { httpStatus: 403, title: '无权访问该内容', retryableDefault: false, safeForUser: true },
  QUERY_TOO_EXPENSIVE: { httpStatus: 422, title: '查询范围过大', retryableDefault: true, safeForUser: true },
  DATA_STALE: { httpStatus: 422, title: '数据新鲜度不足', retryableDefault: true, safeForUser: true },
  PARTIAL_RESULT: { httpStatus: 200, title: '结果部分完成', retryableDefault: true, safeForUser: true },
  MODEL_UNAVAILABLE: { httpStatus: 503, title: '模型服务不可用', retryableDefault: true, safeForUser: true },
  RUN_ALREADY_ACTIVE: { httpStatus: 409, title: '当前会话已有运行中的问题', retryableDefault: true, safeForUser: true },
  RUN_CANCELLED: { httpStatus: 409, title: '运行已取消或不可取消', retryableDefault: false, safeForUser: true },
  VALIDATION_FAILED: { httpStatus: 400, title: '请求契约无效', retryableDefault: true, safeForUser: true },
  INTERNAL_ERROR: { httpStatus: 500, title: '内部错误', retryableDefault: false, safeForUser: false },
} as const satisfies Record<PublicErrorCode, PublicErrorCatalogItem>

export function httpStatusForError(code: PublicErrorCode): PublicErrorCatalogItem['httpStatus'] {
  return PUBLIC_ERROR_CATALOG[code].httpStatus
}

export type ApiEnvelope<T> =
  | { ok: true; data: T; requestId: string; traceId: string }
  | { ok: false; error: PublicApiError; requestId: string; traceId: string }

export interface SubmitQuestionRequest {
  idempotencyKey: string
  conversationId: string
  question: string
  mode: RunMode
  actor: ActorContext
}

export interface ClarifyRunRequest {
  runId: string
  conversationId: string
  candidateId: string
  candidateVersion: string
  actor: ActorContext
}

export interface CancelRunRequest {
  runId: string
  conversationId: string
  actor: ActorContext
}

export interface GetRunRequest {
  runId: string
  conversationId: string
  actor: ActorContext
}

export const analysisIrJsonSchema = {
  $id: 'https://insightflow.local/schemas/analysis-ir.v1.json',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'irId',
    'revision',
    'mode',
    'semanticVersion',
    'intent',
    'metricIds',
    'dimensionIds',
    'filters',
    'timeRange',
    'limit',
    'assumptions',
    'safety',
  ],
  properties: {
    schemaVersion: { const: ANALYSIS_IR_VERSION },
    irId: { type: 'string', minLength: 1 },
    revision: { type: 'integer', minimum: 1 },
    mode: { enum: ['trusted', 'exploration', 'expert'] },
    semanticVersion: { type: 'string', minLength: 1 },
    intent: { enum: ['trend', 'breakdown', 'ranking', 'lookup', 'clarification', 'empty_check'] },
    metricIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    dimensionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    filters: { type: 'array' },
    timeRange: { type: 'object' },
    limit: { type: 'integer', minimum: 1, maximum: 1000 },
    assumptions: { type: 'array', items: { type: 'string' } },
    safety: {
      type: 'object',
      additionalProperties: false,
      required: ['requiresClarification', 'executedQuery', 'permissionChecked', 'budgetChecked'],
      properties: {
        requiresClarification: { type: 'boolean' },
        executedQuery: { type: 'boolean' },
        permissionChecked: { type: 'boolean' },
        budgetChecked: { type: 'boolean' },
      },
    },
  },
} as const

const QUESTION_REQUEST_KEYS = new Set(['idempotencyKey', 'conversationId', 'question', 'mode', 'actor'])

export function validateSubmitQuestionRequest(input: SubmitQuestionRequest): PublicApiError | null {
  const unknown = Object.keys(input as unknown as Record<string, unknown>).filter((key) => !QUESTION_REQUEST_KEYS.has(key))
  if (unknown.length > 0) return validationError(`未知字段：${unknown.join(', ')}`)
  if (!input.idempotencyKey || input.idempotencyKey.length > 128) return validationError('缺少有效幂等键')
  if (!input.conversationId) return validationError('缺少会话 ID')
  if (!input.question || input.question.trim().length === 0) return validationError('问题不能为空')
  if (input.question.length > 500) return validationError('问题不能超过 500 个字符')
  if (!['trusted', 'exploration', 'expert'].includes(input.mode)) return validationError('不支持的运行模式')
  return validateActor(input.actor)
}

export function validateActor(actor: ActorContext): PublicApiError | null {
  if (!actor?.tenantId || !actor.workspaceId || !actor.userId || !actor.businessDomainId) {
    return validationError('缺少身份、租户、工作空间或业务域上下文')
  }
  if (!actor.semanticVersion) return validationError('缺少语义版本')
  if (actor.locale !== 'zh-CN') return validationError('当前演示契约仅支持 zh-CN')
  return null
}

export function assertAnalysisIR(ir: AnalysisIR): void {
  if (ir.schemaVersion !== ANALYSIS_IR_VERSION) throw new Error('Invalid Analysis IR schema version')
  if (!ir.irId || ir.revision < 1) throw new Error('Analysis IR requires id and positive revision')
  if (ir.mode === 'trusted' && ir.metricIds.length === 0) throw new Error('Trusted Analysis IR requires a governed metric')
  if (ir.limit < 1 || ir.limit > 1000) throw new Error('Analysis IR limit is outside the allowed range')
  if (ir.safety.requiresClarification && ir.safety.executedQuery) {
    throw new Error('Analysis IR cannot execute a query while clarification is required')
  }
}

export function validationError(message: string): PublicApiError {
  return {
    code: 'VALIDATION_FAILED',
    message,
    retryable: true,
    debugReference: 'validation_contract',
  }
}

export function toPublicError(input: {
  code: PublicErrorCode
  userMessage: string
  retryable: boolean
  debugReference: string
}): PublicApiError {
  return {
    code: input.code,
    message: input.userMessage,
    retryable: input.retryable,
    debugReference: input.debugReference,
  }
}
