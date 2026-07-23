import type { MaybePromise } from './jobPorts'

export type OutboxMessageStatus =
  | 'pending'
  | 'leased'
  | 'retry_wait'
  | 'published'
  | 'dead_lettered'

export interface OutboxFailure {
  /** Stable, low-cardinality code. Error messages and stacks are never persisted. */
  code: string
  retryable: boolean
}

export interface OutboxRetryPolicy {
  initialDelayMs: number
  maxDelayMs: number
}

export type OutboxAttemptOutcome =
  | 'published'
  | 'retry_scheduled'
  | 'dead_lettered'
  | 'lease_expired'

export interface OutboxAttemptView {
  attempt: number
  fence: number
  publisherId: string
  startedAt: string
  leaseExpiresAt: string
  endedAt?: string
  outcome?: OutboxAttemptOutcome
  failure?: OutboxFailure
}

/**
 * Durable operational view. The event payload and lease token are deliberately
 * absent so status/readiness surfaces cannot accidentally disclose data.
 */
export interface OutboxMessageView {
  eventId: string
  tenantId: string
  workspaceId: string
  aggregateType: 'query_run' | 'conversation' | 'workspace'
  aggregateId: string
  topic: string
  status: OutboxMessageStatus
  attempt: number
  maxAttempts: number
  fence: number
  occurredAt: string
  availableAt: string
  leaseOwner?: string
  leaseExpiresAt?: string
  publishedAt?: string
  deadLetteredAt?: string
  publicationFingerprint?: string
  lastFailure?: OutboxFailure
  attempts: OutboxAttemptView[]
}

export interface OutboxEnqueueInput<TPayload> {
  eventId: string
  tenantId: string
  workspaceId: string
  aggregateType: 'query_run' | 'conversation' | 'workspace'
  aggregateId: string
  topic: string
  payload: TPayload
  occurredAt: string
  availableAt?: string
  maxAttempts?: number
}

export type EnqueueOutboxMessageResult =
  | { ok: true; created: boolean; message: OutboxMessageView }
  | { ok: false; reason: 'idempotency_conflict'; message?: OutboxMessageView }

export interface ClaimOutboxMessageInput {
  publisherId: string
  now: string
  leaseMs: number
  /** Optional deterministic target for tests or synchronous draining. */
  eventId?: string
}

export interface OutboxMessageLease<TPayload = unknown> {
  eventId: string
  tenantId: string
  workspaceId: string
  aggregateType: 'query_run' | 'conversation' | 'workspace'
  aggregateId: string
  topic: string
  payload: TPayload
  attempt: number
  maxAttempts: number
  fence: number
  publisherId: string
  leaseToken: string
  occurredAt: string
  claimedAt: string
  leaseExpiresAt: string
}

export interface OutboxLeaseMutationInput {
  eventId: string
  attempt: number
  fence: number
  publisherId: string
  leaseToken: string
}

export interface GetOutboxMessageInput {
  tenantId: string
  workspaceId: string
  eventId: string
}

export interface AckOutboxMessageInput extends OutboxLeaseMutationInput {
  publishedAt: string
  publicationFingerprint: string
}

export interface RetryOutboxMessageInput extends OutboxLeaseMutationInput {
  failedAt: string
  /** Chosen by the publisher from calculateOutboxRetryDelayMs. */
  availableAt: string
  failure: OutboxFailure
}

export interface DeadLetterOutboxMessageInput extends OutboxLeaseMutationInput {
  failedAt: string
  failure: OutboxFailure
}

export type OutboxMutationFailureReason =
  | 'not_found'
  | 'stale_lease'
  | 'lease_expired'
  | 'terminal_conflict'
  | 'invalid_state'
  | 'attempts_exhausted'
  | 'failure_not_retryable'

export type OutboxMutationResult =
  | { ok: true; applied: boolean; message: OutboxMessageView }
  | { ok: false; reason: OutboxMutationFailureReason; message?: OutboxMessageView }

/**
 * Storage boundary for an at-least-once outbox. A successful external publish
 * is acknowledged only with the exact attempt/fence/token returned by claim.
 * Therefore a late publisher cannot acknowledge a reclaimed message.
 */
export interface DurableOutbox<TPayload = unknown> {
  enqueue(input: OutboxEnqueueInput<TPayload>): MaybePromise<EnqueueOutboxMessageResult>
  claimNext(input: ClaimOutboxMessageInput): MaybePromise<OutboxMessageLease<TPayload> | undefined>
  ack(input: AckOutboxMessageInput): MaybePromise<OutboxMutationResult>
  retry(input: RetryOutboxMessageInput): MaybePromise<OutboxMutationResult>
  deadLetter(input: DeadLetterOutboxMessageInput): MaybePromise<OutboxMutationResult>
  getMessage(input: GetOutboxMessageInput): MaybePromise<OutboxMessageView | undefined>
}

export interface SynchronousDurableOutbox<TPayload = unknown> extends DurableOutbox<TPayload> {
  enqueue(input: OutboxEnqueueInput<TPayload>): EnqueueOutboxMessageResult
  claimNext(input: ClaimOutboxMessageInput): OutboxMessageLease<TPayload> | undefined
  ack(input: AckOutboxMessageInput): OutboxMutationResult
  retry(input: RetryOutboxMessageInput): OutboxMutationResult
  deadLetter(input: DeadLetterOutboxMessageInput): OutboxMutationResult
  getMessage(input: GetOutboxMessageInput): OutboxMessageView | undefined
}

/**
 * Deterministic, jitter-free exponential backoff. Attempts are one-based:
 * attempt 1 waits initialDelayMs, attempt 2 waits twice that, and so on.
 */
export function calculateOutboxRetryDelayMs(attempt: number, policy: OutboxRetryPolicy): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error('attempt must be a positive integer')
  }
  validateOutboxRetryPolicy(policy)
  const exponent = Math.min(attempt - 1, 52)
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent)
}

export function validateOutboxRetryPolicy(policy: OutboxRetryPolicy): void {
  positiveInteger(policy.initialDelayMs, 'initialDelayMs')
  positiveInteger(policy.maxDelayMs, 'maxDelayMs')
  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new Error('maxDelayMs cannot be less than initialDelayMs')
  }
}

export function validateOutboxFailure(failure: OutboxFailure): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(failure.code)) {
    throw new Error('failure.code must be a public low-cardinality code')
  }
  if (typeof failure.retryable !== 'boolean') {
    throw new Error('failure.retryable must be a boolean')
  }
}

export const OUTBOX_PAYLOAD_MAX_DEPTH = 32
export const OUTBOX_PAYLOAD_MAX_NODES = 10_000
export const OUTBOX_PAYLOAD_MAX_BYTES = 64 * 1024

/**
 * Validates and canonicalizes the JSON payload used for adapter-independent
 * idempotency checks and fingerprints. Accessors, special prototypes, cycles,
 * sparse arrays and JSON-lossy values are rejected instead of normalized.
 */
export function canonicalizeOutboxPayload(value: unknown): string {
  let nodes = 0
  const ancestors = new WeakSet<object>()

  function visit(current: unknown, depth: number): string {
    nodes += 1
    if (nodes > OUTBOX_PAYLOAD_MAX_NODES) throw new Error('payload exceeds node limit')
    if (depth > OUTBOX_PAYLOAD_MAX_DEPTH) throw new Error('payload exceeds depth limit')
    if (current === null) return 'null'
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('payload numbers must be finite')
      return JSON.stringify(current)
    }
    if (
      current === undefined
      || typeof current === 'function'
      || typeof current === 'symbol'
      || typeof current === 'bigint'
    ) {
      throw new Error(`payload contains unsupported ${typeof current}`)
    }
    if (typeof current !== 'object') throw new Error('payload contains unsupported value')
    if (ancestors.has(current)) throw new Error('payload must not contain cycles')

    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (!descriptor) {
            throw new Error('payload arrays must not be sparse')
          }
          if (!('value' in descriptor)) {
            throw new Error('payload must not contain accessor properties')
          }
        }
        if (Object.getOwnPropertySymbols(current).length > 0) {
          throw new Error('payload must not contain symbol keys')
        }
        const entries = Array.from(
          { length: current.length },
          (_, index) => {
            const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
            if (!descriptor || !('value' in descriptor)) {
              throw new Error('payload arrays must contain data properties')
            }
            return visit(descriptor.value, depth + 1)
          },
        )
        return `[${entries.join(',')}]`
      }

      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('payload objects must be plain records')
      }
      if (Object.getOwnPropertySymbols(current).length > 0) {
        throw new Error('payload must not contain symbol keys')
      }
      const record = current as Record<string, unknown>
      const keys = Object.keys(record).sort()
      const properties = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key)
        if (!descriptor || !('value' in descriptor)) {
          throw new Error('payload must not contain accessor properties')
        }
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`
      })
      return `{${properties.join(',')}}`
    } finally {
      ancestors.delete(current)
    }
  }

  const canonical = visit(value, 0)
  if (new TextEncoder().encode(canonical).byteLength > OUTBOX_PAYLOAD_MAX_BYTES) {
    throw new Error('payload exceeds 64 KiB limit')
  }
  return canonical
}

const OUTBOX_SENSITIVE_PAYLOAD_KEYS = new Set([
  'sql',
  'rawsql',
  'querytext',
  'statement',
  'parameters',
  'parameter',
  'params',
  'connectionstring',
  'connectionurl',
  'dsn',
  'password',
  'passwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'accesstoken',
  'refreshtoken',
  'leasetoken',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'privatekey',
  'clientsecret',
  'accesskey',
  'credential',
  'credentials',
  'credentialref',
  'credentialreference',
  'rows',
  'resultrows',
  'resultdata',
  'rawresult',
  'data',
  'records',
  'record',
  'message',
  'errormessage',
  'stack',
  'stacktrace',
  'debugreference',
  'question',
  'prompt',
  'userinput',
  'rawtext',
])

/**
 * Enforces the public-event payload boundary independently of JSON validity.
 * Key matching is exact after case/separator normalization, so safe references
 * such as resultId, queryStatus and policyVersion remain available.
 */
export function assertPublicOutboxPayload(value: unknown): void {
  const safeJson = JSON.parse(canonicalizeOutboxPayload(value)) as unknown
  const visit = (current: unknown): void => {
    if (!current || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const entry of current) visit(entry)
      return
    }
    for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (OUTBOX_SENSITIVE_PAYLOAD_KEYS.has(normalized)) {
        throw new Error('outbox payload contains a forbidden sensitive field')
      }
      visit(entry)
    }
  }
  visit(safeJson)
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
