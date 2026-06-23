import type { Run, RunMode } from './run'
import { isRunActive } from './run'

export type ConstraintSource = 'user' | 'system_default'

export interface Constraint<T> {
  value: T
  source: ConstraintSource
}

export interface ConversationState {
  metrics: Constraint<string[]>
  dimensions: Constraint<string[]>
  filters: Constraint<Record<string, string[]>>
  timeRange: Constraint<string>
  grain: Constraint<'day' | 'week' | 'month' | 'quarter' | 'year'>
  presentation: Constraint<'kpi' | 'table' | 'line' | 'bar'>
  assumptions: string[]
}

export interface Conversation {
  id: string
  tenantId: string
  workspaceId: string
  title: string
  businessDomainId: string
  mode: RunMode
  semanticVersion: string
  state: ConversationState
  activeRunId?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}

export function attachRun(conversation: Conversation, run: Run): Conversation {
  if (conversation.id !== run.conversationId || conversation.tenantId !== run.tenantId || conversation.workspaceId !== run.workspaceId) {
    throw new Error('Run does not belong to this conversation boundary')
  }
  if (conversation.activeRunId && conversation.activeRunId !== run.id) throw new Error('RUN_ALREADY_ACTIVE')
  return isRunActive(run)
    ? { ...conversation, activeRunId: run.id, updatedAt: run.updatedAt }
    : { ...conversation, activeRunId: undefined, updatedAt: run.updatedAt }
}

export function applyConstraint<T>(current: Constraint<T>, incoming: Constraint<T>): Constraint<T> {
  if (current.source === 'user' && incoming.source === 'system_default') return current
  return incoming
}

export function updateConversationState(
  current: ConversationState,
  patch: Partial<{ [K in keyof Omit<ConversationState, 'assumptions'>]: ConversationState[K] }> & { assumptions?: string[] },
): ConversationState {
  return {
    metrics: patch.metrics ? applyConstraint(current.metrics, patch.metrics) : current.metrics,
    dimensions: patch.dimensions ? applyConstraint(current.dimensions, patch.dimensions) : current.dimensions,
    filters: patch.filters ? applyConstraint(current.filters, patch.filters) : current.filters,
    timeRange: patch.timeRange ? applyConstraint(current.timeRange, patch.timeRange) : current.timeRange,
    grain: patch.grain ? applyConstraint(current.grain, patch.grain) : current.grain,
    presentation: patch.presentation ? applyConstraint(current.presentation, patch.presentation) : current.presentation,
    assumptions: patch.assumptions ?? current.assumptions,
  }
}
