import { isRunActive, type Conversation } from '../domain'
import type {
  ControlPlaneRunKey,
  QueryControlPlane,
  SubmitAndEnqueueInput,
  SubmitAndEnqueueResult,
} from './controlPlanePorts'
import type { EnqueueRunJobInput } from './jobPorts'
import type { StoredRunRecord } from './ports'

interface StoredConversation {
  tenantId: string
  workspaceId: string
  value: Conversation
}

interface StoredRun {
  tenantId: string
  workspaceId: string
  value: StoredRunRecord
}

interface StoredIdempotency {
  requestFingerprint: string
  runId: string
}

interface StoredJob<TPayload> {
  tenantId: string
  workspaceId: string
  value: EnqueueRunJobInput<TPayload>
}

export interface InMemoryQueryControlPlane<TPayload = unknown> extends QueryControlPlane<TPayload> {
  /** Test/diagnostic read; production consumers enqueue through submitAndEnqueue. */
  getJob(input: ControlPlaneRunKey): Promise<EnqueueRunJobInput<TPayload> | undefined>
}

/**
 * Single-process reference implementation of the durable submission contract.
 * The write path intentionally contains no await/yield point: validation and all
 * map publications happen in one synchronous critical section.
 */
export function createInMemoryQueryControlPlane<TPayload = unknown>(): InMemoryQueryControlPlane<TPayload> {
  const conversations = new Map<string, StoredConversation>()
  const runs = new Map<string, StoredRun>()
  const idempotency = new Map<string, StoredIdempotency>()
  const jobs = new Map<string, StoredJob<TPayload>>()
  let writing = false

  function criticalSection<T>(operation: () => T): T {
    if (writing) throw new Error('query control-plane write is already in progress')
    writing = true
    try {
      return operation()
    } finally {
      writing = false
    }
  }

  return {
    async getConversation(input) {
      const stored = conversations.get(input.conversationId)
      if (!stored || !sameScope(stored, input)) return undefined
      return clone(stored.value)
    },

    async getRun(input) {
      const stored = runs.get(input.runId)
      if (!stored || !sameScope(stored, input)) return undefined
      return clone(stored.value)
    },

    async getRunByIdempotency(input) {
      const stored = idempotency.get(idempotencyKey(input))
      if (!stored) return { status: 'not_found' }
      if (stored.requestFingerprint !== input.requestFingerprint) {
        return { status: 'conflict', existingRunId: stored.runId }
      }
      const run = runs.get(stored.runId)
      if (!run || !sameScope(run, input)) return { status: 'not_found' }
      return { status: 'match', runRecord: clone(run.value) }
    },

    async submitAndEnqueue(input) {
      return criticalSection(() => submit(input))
    },

    async getJob(input) {
      const stored = jobs.get(input.runId)
      if (!stored || !sameScope(stored, input)) return undefined
      return clone(stored.value)
    },
  }

  function submit(input: SubmitAndEnqueueInput<TPayload>): SubmitAndEnqueueResult {
    const conversation = input.conversation
    const record = input.runRecord
    const run = record.run

    if (
      conversation.tenantId !== run.tenantId
      || conversation.workspaceId !== run.workspaceId
      || conversation.id !== run.conversationId
    ) {
      return { ok: false, reason: 'conversation_scope_conflict' }
    }

    const existingConversation = conversations.get(conversation.id)
    if (existingConversation && (
      !sameScope(existingConversation, conversation)
      || existingConversation.value.businessDomainId !== conversation.businessDomainId
    )) {
      return { ok: false, reason: 'conversation_scope_conflict' }
    }

    if (record.idempotencyFingerprint !== input.requestFingerprint) {
      return { ok: false, reason: 'run_identity_conflict' }
    }

    const storedIdempotency = idempotency.get(idempotencyKey({
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      idempotencyKey: input.idempotencyKey,
    }))
    if (storedIdempotency) {
      if (storedIdempotency.requestFingerprint !== input.requestFingerprint) {
        return {
          ok: false,
          reason: 'idempotency_conflict',
          existingRunId: storedIdempotency.runId,
        }
      }
      const storedRun = runs.get(storedIdempotency.runId)
      const storedConversationForReplay = conversations.get(conversation.id)
      if (!storedRun || !storedConversationForReplay) {
        throw new Error('query control-plane idempotency invariant is broken')
      }
      return {
        ok: true,
        created: false,
        conversation: clone(storedConversationForReplay.value),
        runRecord: clone(storedRun.value),
      }
    }

    if (runs.has(run.id)) return { ok: false, reason: 'run_identity_conflict' }

    if (existingConversation?.value.activeRunId && existingConversation.value.activeRunId !== run.id) {
      return {
        ok: false,
        reason: 'conversation_active_run_conflict',
        activeRunId: existingConversation.value.activeRunId,
      }
    }

    const expectedActiveRunId = isRunActive(run) ? run.id : undefined
    if (conversation.activeRunId !== expectedActiveRunId) {
      return { ok: false, reason: 'run_identity_conflict' }
    }
    if (run.displayStatus === 'querying' && !input.job) {
      return { ok: false, reason: 'run_identity_conflict' }
    }
    if (run.displayStatus !== 'querying' && input.job) {
      return { ok: false, reason: 'run_identity_conflict' }
    }
    if (input.job && (
      input.job.runId !== run.id
      || input.job.tenantId !== run.tenantId
      || input.job.workspaceId !== run.workspaceId
    )) {
      return { ok: false, reason: 'run_identity_conflict' }
    }

    // Clone before publication so later caller mutation cannot alter committed state.
    const committedConversation = clone(conversation)
    const committedRecord = clone(record)
    const committedJob = input.job ? clone(input.job) : undefined

    conversations.set(conversation.id, {
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      value: committedConversation,
    })
    runs.set(run.id, {
      tenantId: run.tenantId,
      workspaceId: run.workspaceId,
      value: committedRecord,
    })
    idempotency.set(idempotencyKey({
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
      idempotencyKey: input.idempotencyKey,
    }), { requestFingerprint: input.requestFingerprint, runId: run.id })
    if (committedJob) {
      jobs.set(run.id, {
        tenantId: run.tenantId,
        workspaceId: run.workspaceId,
        value: committedJob,
      })
    }

    return {
      ok: true,
      created: true,
      conversation: clone(committedConversation),
      runRecord: clone(committedRecord),
    }
  }
}

function idempotencyKey(input: {
  tenantId: string
  workspaceId: string
  conversationId: string
  idempotencyKey: string
}): string {
  return JSON.stringify([
    input.tenantId,
    input.workspaceId,
    input.conversationId,
    input.idempotencyKey,
  ])
}

function sameScope(
  stored: { tenantId: string; workspaceId: string },
  input: { tenantId: string; workspaceId: string },
): boolean {
  return stored.tenantId === input.tenantId && stored.workspaceId === input.workspaceId
}

function clone<T>(value: T): T {
  return structuredClone(value)
}
