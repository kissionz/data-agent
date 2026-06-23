import { dirname } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Conversation } from '../domain'
import type { ChatBiPersistence, StoredRunRecord } from './ports'

interface FilePersistenceState {
  schemaVersion: 1
  conversations: Record<string, Conversation>
  runs: Record<string, StoredRunRecord>
  idempotency: Record<string, string>
}

export function createFileChatBiPersistence(filePath: string): ChatBiPersistence {
  let state = loadState(filePath)

  function commit(nextState: FilePersistenceState): void {
    state = clone(nextState)
    writeState(filePath, state)
  }

  return {
    getConversation(conversationId) {
      return clone(state.conversations[conversationId])
    },
    saveConversation(conversation) {
      commit({
        ...state,
        conversations: { ...state.conversations, [conversation.id]: clone(conversation) },
      })
    },
    getRun(runId) {
      return clone(state.runs[runId])
    },
    saveRun(record) {
      commit({
        ...state,
        runs: { ...state.runs, [record.run.id]: clone(record) },
      })
    },
    getRunIdByIdempotencyKey(idempotencyKey) {
      return state.idempotency[idempotencyKey]
    },
    saveIdempotencyKey(idempotencyKey, runId) {
      commit({
        ...state,
        idempotency: { ...state.idempotency, [idempotencyKey]: runId },
      })
    },
    listAuditEvents(runId) {
      return clone(state.runs[runId]?.audit ?? [])
    },
  }
}

function loadState(filePath: string): FilePersistenceState {
  if (!existsSync(filePath)) return emptyState()
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<FilePersistenceState>
  if (parsed.schemaVersion !== 1 || !parsed.conversations || !parsed.runs || !parsed.idempotency) {
    throw new Error('Unsupported ChatBI persistence file schema')
  }
  return clone(parsed as FilePersistenceState)
}

function writeState(filePath: string, state: FilePersistenceState): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tempPath, filePath)
}

function emptyState(): FilePersistenceState {
  return {
    schemaVersion: 1,
    conversations: {},
    runs: {},
    idempotency: {},
  }
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}
