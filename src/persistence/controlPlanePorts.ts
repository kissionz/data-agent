import type { ActorContext, AuditEvent } from '../contracts'
import type { Conversation } from '../domain'
import type {
  CompleteRunJobInput,
  EnqueueRunJobInput,
  FailRunJobInput,
  RetryRunJobInput,
  RunJobMutationResult,
} from './jobPorts'
import type { StoredRunRecord } from './ports'
import type { PublishResultManifestInput, StageResultPageInput } from './resultPorts'

export interface QueryControlPlaneScope {
  tenantId: string
  workspaceId: string
}

export interface ControlPlaneConversationKey extends QueryControlPlaneScope {
  conversationId: string
}

export interface ControlPlaneRunKey extends QueryControlPlaneScope {
  runId: string
}

export interface ControlPlaneIdempotencyLookup extends ControlPlaneConversationKey {
  idempotencyKey: string
  requestFingerprint: string
}

export type ControlPlaneIdempotencyLookupResult =
  | { status: 'not_found' }
  | { status: 'match'; runRecord: StoredRunRecord }
  | { status: 'conflict'; existingRunId: string }

export interface SubmitAndEnqueueInput<TPayload> {
  /** The caller key is scoped by tenant/workspace/conversation in durable storage. */
  idempotencyKey: string
  /** Exact canonical identity of every request field that can change query meaning. */
  requestFingerprint: string
  conversation: Conversation
  runRecord: StoredRunRecord
  /** Present only for a querying Run; terminal and clarification Runs must not enqueue work. */
  job?: EnqueueRunJobInput<TPayload>
}

export type SubmitAndEnqueueConflictReason =
  | 'idempotency_conflict'
  | 'conversation_scope_conflict'
  | 'conversation_active_run_conflict'
  | 'run_identity_conflict'

export type SubmitAndEnqueueResult =
  | {
      ok: true
      created: boolean
      conversation: Conversation
      runRecord: StoredRunRecord
    }
  | {
      ok: false
      reason: SubmitAndEnqueueConflictReason
      existingRunId?: string
      activeRunId?: string
    }

/**
 * Durable submission boundary. Implementations must publish the idempotency
 * reservation, conversation active-run CAS, Run, audit and job atomically.
 */
export interface QueryControlPlane<TPayload = unknown> {
  getConversation(input: ControlPlaneConversationKey): Promise<Conversation | undefined>
  getRun(input: ControlPlaneRunKey): Promise<StoredRunRecord | undefined>
  getRunByIdempotency(input: ControlPlaneIdempotencyLookup): Promise<ControlPlaneIdempotencyLookupResult>
  submitAndEnqueue(input: SubmitAndEnqueueInput<TPayload>): Promise<SubmitAndEnqueueResult>
}

export interface ControlPlaneEventInput<TEvent = unknown> {
  eventId: string
  event: TEvent
  occurredAt: string
}

export interface CancelControlPlaneRunInput<TEvent = unknown> extends ControlPlaneRunKey {
  conversationId: string
  actor: ActorContext
  cancelledAt: string
  event: ControlPlaneEventInput<TEvent>
}

export type CancelControlPlaneRunResult =
  | {
      ok: true
      applied: boolean
      conversation: Conversation
      runRecord: StoredRunRecord
    }
  | {
      ok: false
      reason: 'not_found' | 'terminal_conflict' | 'scope_conflict' | 'invalid_state'
    }

export type ControlPlaneAttemptMutation<TResult = unknown> =
  | { type: 'complete'; input: CompleteRunJobInput<TResult> }
  | { type: 'fail'; input: FailRunJobInput }
  | { type: 'retry'; input: RetryRunJobInput }

export interface ControlPlaneResultPublication<TPage = unknown, TMetadata = unknown> {
  pages: StageResultPageInput<TPage>[]
  manifest: PublishResultManifestInput<TMetadata>
}

export interface CommitControlPlaneAttemptInput<TResult = unknown, TEvent = unknown, TPage = unknown, TMetadata = unknown> {
  job: ControlPlaneAttemptMutation<TResult>
  conversation: Conversation
  runRecord: StoredRunRecord
  /** Must be the exact audit suffix added to the previously stored record. */
  newAuditEvents: AuditEvent[]
  event: ControlPlaneEventInput<TEvent>
  /** Required when the committed Run exposes a completed result. */
  resultPublication?: ControlPlaneResultPublication<TPage, TMetadata>
}

/**
 * Execution extension used by production workers. Queue terminal state and all
 * public Run state are committed through this single boundary; no post-commit
 * callback is required for correctness.
 */
export interface QueryExecutionControlPlane<
  TPayload = unknown,
  TResult = unknown,
  TEvent = unknown,
  TPage = unknown,
  TMetadata = unknown,
> extends QueryControlPlane<TPayload> {
  cancelRun(input: CancelControlPlaneRunInput<TEvent>): Promise<CancelControlPlaneRunResult>
  commitAttempt(
    input: CommitControlPlaneAttemptInput<TResult, TEvent, TPage, TMetadata>,
  ): Promise<RunJobMutationResult<TPayload, TResult>>
}
