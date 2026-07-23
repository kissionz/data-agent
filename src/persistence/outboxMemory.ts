import {
  assertPublicOutboxPayload,
  canonicalizeOutboxPayload,
  validateOutboxFailure,
  type AckOutboxMessageInput,
  type ClaimOutboxMessageInput,
  type DeadLetterOutboxMessageInput,
  type EnqueueOutboxMessageResult,
  type GetOutboxMessageInput,
  type OutboxAttemptOutcome,
  type OutboxFailure,
  type OutboxLeaseMutationInput,
  type OutboxMessageLease,
  type OutboxMessageView,
  type OutboxMutationResult,
  type OutboxEnqueueInput,
  type RetryOutboxMessageInput,
  type SynchronousDurableOutbox,
} from './outboxPorts'

interface ActiveOutboxLease {
  attempt: number
  fence: number
  publisherId: string
  token: string
  expiresAt: string
}

interface TerminalMutation {
  kind: 'published' | 'retry_scheduled' | 'dead_lettered'
  attempt: number
  fence: number
  publisherId: string
  leaseToken: string
  fingerprint: string
}

interface StoredOutboxMessage<TPayload> extends OutboxMessageView {
  payload: TPayload
  payloadIdentity: string
  lease?: ActiveOutboxLease
  terminalMutation?: TerminalMutation
}

export interface InMemoryDurableOutboxOptions {
  leaseToken?: () => string
  defaultMaxAttempts?: number
}

/**
 * Deterministic reference state machine used by browser demos and adapter
 * contract tests. Production stores must preserve the same fenced transitions.
 */
export function createInMemoryDurableOutbox<TPayload = unknown>(
  options: InMemoryDurableOutboxOptions = {},
): SynchronousDurableOutbox<TPayload> {
  const messages = new Map<string, StoredOutboxMessage<TPayload>>()
  const defaultMaxAttempts = options.defaultMaxAttempts ?? 5
  positiveInteger(defaultMaxAttempts, 'defaultMaxAttempts')
  let leaseSequence = 0
  const nextLeaseToken = options.leaseToken ?? (() => {
    leaseSequence += 1
    return `outbox_lease_${String(leaseSequence).padStart(8, '0')}`
  })

  function enqueue(input: OutboxEnqueueInput<TPayload>): EnqueueOutboxMessageResult {
    nonEmpty(input.eventId, 'eventId')
    nonEmpty(input.tenantId, 'tenantId')
    nonEmpty(input.workspaceId, 'workspaceId')
    validateAggregateType(input.aggregateType)
    nonEmpty(input.aggregateId, 'aggregateId')
    nonEmpty(input.topic, 'topic')
    const occurredAtMs = instant(input.occurredAt, 'occurredAt')
    const occurredAt = new Date(occurredAtMs).toISOString()
    const availableAtMs = instant(input.availableAt ?? input.occurredAt, 'availableAt')
    const availableAt = new Date(availableAtMs).toISOString()
    if (availableAtMs < occurredAtMs) throw new Error('availableAt cannot be before occurredAt')
    const maxAttempts = input.maxAttempts ?? defaultMaxAttempts
    positiveInteger(maxAttempts, 'maxAttempts')
    assertPublicOutboxPayload(input.payload)
    const payloadIdentity = canonicalizeOutboxPayload(input.payload)

    const existing = messages.get(input.eventId)
    if (existing) {
      if (existing.tenantId !== input.tenantId || existing.workspaceId !== input.workspaceId) {
        return { ok: false, reason: 'idempotency_conflict' }
      }
      const sameIdentity = existing.tenantId === input.tenantId
        && existing.workspaceId === input.workspaceId
        && existing.aggregateType === input.aggregateType
        && existing.aggregateId === input.aggregateId
        && existing.topic === input.topic
        && existing.payloadIdentity === payloadIdentity
        && existing.occurredAt === occurredAt
        && existing.availableAt === availableAt
        && existing.maxAttempts === maxAttempts
      return sameIdentity
        ? { ok: true, created: false, message: view(existing) }
        : { ok: false, reason: 'idempotency_conflict', message: view(existing) }
    }

    const message: StoredOutboxMessage<TPayload> = {
      eventId: input.eventId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      topic: input.topic,
      payload: JSON.parse(payloadIdentity) as TPayload,
      payloadIdentity,
      status: 'pending',
      attempt: 0,
      maxAttempts,
      fence: 0,
      occurredAt,
      availableAt,
      attempts: [],
    }
    messages.set(input.eventId, message)
    return { ok: true, created: true, message: view(message) }
  }

  function claimNext(input: ClaimOutboxMessageInput): OutboxMessageLease<TPayload> | undefined {
    nonEmpty(input.publisherId, 'publisherId')
    const nowMs = instant(input.now, 'now')
    positiveInteger(input.leaseMs, 'leaseMs')

    const ordered = [...messages.values()]
      .filter((message) => !input.eventId || message.eventId === input.eventId)
      .sort((left, right) => {
        const byAvailableAt = instant(left.availableAt, 'availableAt') - instant(right.availableAt, 'availableAt')
        if (byAvailableAt !== 0) return byAvailableAt
        const byOccurredAt = instant(left.occurredAt, 'occurredAt') - instant(right.occurredAt, 'occurredAt')
        return byOccurredAt !== 0 ? byOccurredAt : left.eventId.localeCompare(right.eventId)
      })

    for (const message of ordered) {
      const expired = message.status === 'leased'
        && message.lease
        && instant(message.lease.expiresAt, 'leaseExpiresAt') <= nowMs
      const ready = (message.status === 'pending' || message.status === 'retry_wait')
        && instant(message.availableAt, 'availableAt') <= nowMs
      if (!expired && !ready) continue

      if (expired) {
        const failure = leaseExpiredFailure()
        closeAttempt(message, input.now, 'lease_expired', failure)
        message.lastFailure = failure
        clearLease(message)
      }
      if (message.attempt >= message.maxAttempts) {
        message.status = 'dead_lettered'
        message.deadLetteredAt = input.now
        message.lastFailure = message.lastFailure ?? leaseExpiredFailure()
        continue
      }

      message.attempt += 1
      message.fence += 1
      const leaseExpiresAt = new Date(nowMs + input.leaseMs).toISOString()
      const leaseToken = nextLeaseToken()
      nonEmpty(leaseToken, 'leaseToken')
      message.status = 'leased'
      message.leaseOwner = input.publisherId
      message.leaseExpiresAt = leaseExpiresAt
      message.lease = {
        attempt: message.attempt,
        fence: message.fence,
        publisherId: input.publisherId,
        token: leaseToken,
        expiresAt: leaseExpiresAt,
      }
      message.terminalMutation = undefined
      message.attempts.push({
        attempt: message.attempt,
        fence: message.fence,
        publisherId: input.publisherId,
        startedAt: input.now,
        leaseExpiresAt,
      })
      return {
        eventId: message.eventId,
        tenantId: message.tenantId,
        workspaceId: message.workspaceId,
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        topic: message.topic,
        payload: clone(message.payload),
        attempt: message.attempt,
        maxAttempts: message.maxAttempts,
        fence: message.fence,
        publisherId: input.publisherId,
        leaseToken,
        occurredAt: message.occurredAt,
        claimedAt: input.now,
        leaseExpiresAt,
      }
    }
    return undefined
  }

  function ack(input: AckOutboxMessageInput): OutboxMutationResult {
    instant(input.publishedAt, 'publishedAt')
    nonEmpty(input.publicationFingerprint, 'publicationFingerprint')
    const message = messages.get(input.eventId)
    if (
      message?.status === 'published'
      && sameTerminalMutation(message.terminalMutation, input, 'published', input.publicationFingerprint)
    ) {
      return { ok: true, applied: false, message: view(message) }
    }
    const checked = checkLease(input, instant(input.publishedAt, 'publishedAt'))
    if (!checked.ok) return checked.result

    checked.message.status = 'published'
    checked.message.publishedAt = input.publishedAt
    checked.message.publicationFingerprint = input.publicationFingerprint
    closeAttempt(checked.message, input.publishedAt, 'published')
    checked.message.terminalMutation = {
      kind: 'published',
      attempt: input.attempt,
      fence: input.fence,
      publisherId: input.publisherId,
      leaseToken: input.leaseToken,
      fingerprint: input.publicationFingerprint,
    }
    clearLease(checked.message)
    return { ok: true, applied: true, message: view(checked.message) }
  }

  function retry(input: RetryOutboxMessageInput): OutboxMutationResult {
    const failedAtMs = instant(input.failedAt, 'failedAt')
    const availableAtMs = instant(input.availableAt, 'availableAt')
    if (availableAtMs < failedAtMs) throw new Error('availableAt cannot be before failedAt')
    validateOutboxFailure(input.failure)
    const message = messages.get(input.eventId)
    const fingerprint = `${failureIdentity(input.failure)}:${input.availableAt}`
    if (
      message?.status === 'retry_wait'
      && sameTerminalMutation(message.terminalMutation, input, 'retry_scheduled', fingerprint)
    ) {
      return { ok: true, applied: false, message: view(message) }
    }
    const checked = checkLease(input, failedAtMs)
    if (!checked.ok) return checked.result
    if (!input.failure.retryable) {
      return { ok: false, reason: 'failure_not_retryable', message: view(checked.message) }
    }
    if (checked.message.attempt >= checked.message.maxAttempts) {
      return { ok: false, reason: 'attempts_exhausted', message: view(checked.message) }
    }

    checked.message.status = 'retry_wait'
    checked.message.availableAt = input.availableAt
    checked.message.lastFailure = cloneFailure(input.failure)
    closeAttempt(checked.message, input.failedAt, 'retry_scheduled', input.failure)
    checked.message.terminalMutation = terminalMutation(input, 'retry_scheduled', fingerprint)
    clearLease(checked.message)
    return { ok: true, applied: true, message: view(checked.message) }
  }

  function deadLetter(input: DeadLetterOutboxMessageInput): OutboxMutationResult {
    const failedAtMs = instant(input.failedAt, 'failedAt')
    validateOutboxFailure(input.failure)
    const message = messages.get(input.eventId)
    const fingerprint = failureIdentity(input.failure)
    if (
      message?.status === 'dead_lettered'
      && sameTerminalMutation(message.terminalMutation, input, 'dead_lettered', fingerprint)
    ) {
      return { ok: true, applied: false, message: view(message) }
    }
    const checked = checkLease(input, failedAtMs)
    if (!checked.ok) return checked.result
    checked.message.status = 'dead_lettered'
    checked.message.deadLetteredAt = input.failedAt
    checked.message.lastFailure = cloneFailure(input.failure)
    closeAttempt(checked.message, input.failedAt, 'dead_lettered', input.failure)
    checked.message.terminalMutation = terminalMutation(input, 'dead_lettered', fingerprint)
    clearLease(checked.message)
    return { ok: true, applied: true, message: view(checked.message) }
  }

  function getMessage(input: GetOutboxMessageInput) {
    const message = messages.get(input.eventId)
    return message
      && message.tenantId === input.tenantId
      && message.workspaceId === input.workspaceId
      ? view(message)
      : undefined
  }

  function checkLease(
    input: OutboxLeaseMutationInput,
    atMs: number,
  ): { ok: true; message: StoredOutboxMessage<TPayload> } | { ok: false; result: OutboxMutationResult } {
    const message = messages.get(input.eventId)
    if (!message) return { ok: false, result: { ok: false, reason: 'not_found' } }
    if (message.status === 'published' || message.status === 'dead_lettered') {
      return { ok: false, result: { ok: false, reason: 'terminal_conflict', message: view(message) } }
    }
    if (message.status !== 'leased' || !message.lease || !sameLease(message.lease, input)) {
      return { ok: false, result: { ok: false, reason: 'stale_lease', message: view(message) } }
    }
    if (instant(message.lease.expiresAt, 'leaseExpiresAt') <= atMs) {
      return { ok: false, result: { ok: false, reason: 'lease_expired', message: view(message) } }
    }
    return { ok: true, message }
  }

  return { enqueue, claimNext, ack, retry, deadLetter, getMessage }
}

function sameLease(active: ActiveOutboxLease, input: OutboxLeaseMutationInput) {
  return active.attempt === input.attempt
    && active.fence === input.fence
    && active.publisherId === input.publisherId
    && active.token === input.leaseToken
}

function sameTerminalMutation(
  mutation: TerminalMutation | undefined,
  input: OutboxLeaseMutationInput,
  kind: TerminalMutation['kind'],
  fingerprint: string,
) {
  return Boolean(mutation
    && mutation.kind === kind
    && mutation.attempt === input.attempt
    && mutation.fence === input.fence
    && mutation.publisherId === input.publisherId
    && mutation.leaseToken === input.leaseToken
    && mutation.fingerprint === fingerprint)
}

function terminalMutation(
  input: OutboxLeaseMutationInput,
  kind: TerminalMutation['kind'],
  fingerprint: string,
): TerminalMutation {
  return {
    kind,
    attempt: input.attempt,
    fence: input.fence,
    publisherId: input.publisherId,
    leaseToken: input.leaseToken,
    fingerprint,
  }
}

function clearLease<TPayload>(message: StoredOutboxMessage<TPayload>) {
  message.lease = undefined
  message.leaseOwner = undefined
  message.leaseExpiresAt = undefined
}

function closeAttempt<TPayload>(
  message: StoredOutboxMessage<TPayload>,
  endedAt: string,
  outcome: OutboxAttemptOutcome,
  failure?: OutboxFailure,
) {
  const attempt = message.attempts.at(-1)
  if (!attempt || attempt.attempt !== message.attempt || attempt.outcome) return
  attempt.endedAt = endedAt
  attempt.outcome = outcome
  if (failure) attempt.failure = cloneFailure(failure)
}

function view<TPayload>(message: StoredOutboxMessage<TPayload>): OutboxMessageView {
  return {
    eventId: message.eventId,
    tenantId: message.tenantId,
    workspaceId: message.workspaceId,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    topic: message.topic,
    status: message.status,
    attempt: message.attempt,
    maxAttempts: message.maxAttempts,
    fence: message.fence,
    occurredAt: message.occurredAt,
    availableAt: message.availableAt,
    ...(message.leaseOwner ? { leaseOwner: message.leaseOwner } : {}),
    ...(message.leaseExpiresAt ? { leaseExpiresAt: message.leaseExpiresAt } : {}),
    ...(message.publishedAt ? { publishedAt: message.publishedAt } : {}),
    ...(message.deadLetteredAt ? { deadLetteredAt: message.deadLetteredAt } : {}),
    ...(message.publicationFingerprint ? { publicationFingerprint: message.publicationFingerprint } : {}),
    ...(message.lastFailure ? { lastFailure: cloneFailure(message.lastFailure) } : {}),
    attempts: message.attempts.map((attempt) => ({
      ...attempt,
      ...(attempt.failure ? { failure: cloneFailure(attempt.failure) } : {}),
    })),
  }
}

function leaseExpiredFailure(): OutboxFailure {
  return { code: 'OUTBOX_LEASE_EXPIRED', retryable: true }
}

function failureIdentity(failure: OutboxFailure) {
  return `${failure.code}:${failure.retryable ? 'retryable' : 'terminal'}`
}

function cloneFailure(failure: OutboxFailure): OutboxFailure {
  return { code: failure.code, retryable: failure.retryable }
}

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
}

function validateAggregateType(value: string) {
  if (value !== 'query_run' && value !== 'conversation' && value !== 'workspace') {
    throw new Error('aggregateType must be query_run, conversation, or workspace')
  }
}

function nonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} must not be empty`)
}

function instant(value: string, name: string) {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid ISO instant`)
  return parsed
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
