import type { ApiEnvelope, PublicRunView, SubmitQuestionRequest } from '../contracts'
import type { Conversation } from '../domain'
import { createInMemoryChatBiPersistence } from '../persistence/memory'
import type { StoredRunRecord } from '../persistence/ports'
import {
  createChatBiApplicationService,
  queryRequestFingerprint,
  scopedQueryIdempotencyKey,
} from './chatbiService'
import type {
  EnqueueQueryRunInput,
  QueryExecutionDispatcher,
} from './queryExecutionCoordinator'

export type PreparedQuerySubmission =
  | {
      ok: false
      envelope: ApiEnvelope<PublicRunView>
    }
  | {
      ok: true
      envelope: ApiEnvelope<PublicRunView> & { ok: true }
      idempotencyKey: string
      requestFingerprint: string
      conversation: Conversation
      record: StoredRunRecord
      job?: EnqueueQueryRunInput
    }

export interface PrepareQuerySubmissionOptions {
  now?: () => string
  existingConversation?: Conversation
}

/**
 * Runs the existing deterministic planning/domain flow against an isolated
 * unit-of-work. Nothing here is durable: callers must commit the returned
 * conversation, run, idempotency identity and optional job in one transaction.
 */
export function prepareQuerySubmission(
  request: SubmitQuestionRequest,
  options: PrepareQuerySubmissionOptions = {},
): PreparedQuerySubmission {
  const persistence = createInMemoryChatBiPersistence()
  if (options.existingConversation) persistence.saveConversation(options.existingConversation)

  let capturedJob: EnqueueQueryRunInput | undefined
  const dispatcher: QueryExecutionDispatcher = {
    enqueue(input) {
      if (capturedJob && capturedJob.runId !== input.runId) {
        return { ok: false, reason: 'multiple_jobs_in_one_submission' }
      }
      capturedJob = structuredClone(input)
      return { ok: true, created: true }
    },
    cancel() {
      return 'not_found'
    },
    async runOnce() {
      return { status: 'idle' }
    },
  }
  const service = createChatBiApplicationService({
    persistence,
    queryDispatcher: dispatcher,
    now: options.now,
  })
  const envelope = service.submitQuestion(request)
  if (!envelope.ok) return { ok: false, envelope }

  const record = persistence.getRun(envelope.data.runId)
  const conversation = persistence.getConversation(envelope.data.conversationId)
  if (!record || !conversation) throw new Error('submission planner did not produce a complete unit-of-work')
  if (record.run.displayStatus === 'querying' && !capturedJob) {
    throw new Error('querying submission did not produce a durable job input')
  }
  if (capturedJob && capturedJob.runId !== record.run.id) {
    throw new Error('submission job does not belong to the prepared run')
  }

  return {
    ok: true,
    envelope,
    idempotencyKey: scopedQueryIdempotencyKey(request),
    requestFingerprint: queryRequestFingerprint(request),
    conversation,
    record,
    ...(capturedJob ? { job: capturedJob } : {}),
  }
}
