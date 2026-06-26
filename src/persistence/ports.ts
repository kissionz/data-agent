import type { Conversation, Run } from '../domain'
import type { AnalysisIR, AuditEvent, PlannerTraceView, QueryExecutionSummary, RetrievalTraceView } from '../contracts'

export interface StoredRunRecord {
  run: Run
  executedQuery: boolean
  retrieval?: RetrievalTraceView
  planner?: PlannerTraceView
  analysisIr?: AnalysisIR
  queryExecution?: QueryExecutionSummary
  audit: AuditEvent[]
  requestId: string
  traceId: string
}

export interface ChatBiPersistence {
  getConversation(conversationId: string): Conversation | undefined
  saveConversation(conversation: Conversation): void
  getRun(runId: string): StoredRunRecord | undefined
  saveRun(record: StoredRunRecord): void
  getRunIdByIdempotencyKey(idempotencyKey: string): string | undefined
  saveIdempotencyKey(idempotencyKey: string, runId: string): void
  listAuditEvents(runId: string): AuditEvent[]
}
