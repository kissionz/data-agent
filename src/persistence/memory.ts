import type { Conversation } from '../domain'
import type { ChatBiPersistence, StoredRunRecord } from './ports'

export function createInMemoryChatBiPersistence(): ChatBiPersistence {
  const conversations = new Map<string, Conversation>()
  const runs = new Map<string, StoredRunRecord>()
  const idempotency = new Map<string, string>()

  return {
    getConversation(conversationId) {
      return clone(conversations.get(conversationId))
    },
    saveConversation(conversation) {
      conversations.set(conversation.id, clone(conversation))
    },
    getRun(runId) {
      return clone(runs.get(runId))
    },
    saveRun(record) {
      runs.set(record.run.id, clone(record))
    },
    getRunIdByIdempotencyKey(idempotencyKey) {
      return idempotency.get(idempotencyKey)
    },
    saveIdempotencyKey(idempotencyKey, runId) {
      idempotency.set(idempotencyKey, runId)
    },
    listAuditEvents(runId) {
      return clone(runs.get(runId)?.audit ?? [])
    },
  }
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}
