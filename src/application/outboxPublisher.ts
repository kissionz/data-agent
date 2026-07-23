import type { MaybePromise } from '../persistence/jobPorts'
import {
  calculateOutboxRetryDelayMs,
  validateOutboxFailure,
  type DurableOutbox,
  type OutboxFailure,
  type OutboxMessageLease,
  type OutboxMutationFailureReason,
  type OutboxRetryPolicy,
} from '../persistence/outboxPorts'

export interface OutboxPublishRequest<TPayload> {
  /** Stable idempotency key for transports that support de-duplication. */
  eventId: string
  tenantId: string
  workspaceId: string
  aggregateType: OutboxMessageLease<TPayload>['aggregateType']
  aggregateId: string
  topic: string
  payload: TPayload
  occurredAt: string
  attempt: number
  fence: number
  signal: AbortSignal
}

export type OutboxPublishResult =
  | { ok: true; publicationFingerprint: string }
  | { ok: false; failure: OutboxFailure }

export interface OutboxTransport<TPayload> {
  publish(request: OutboxPublishRequest<TPayload>): MaybePromise<OutboxPublishResult>
}

export type OutboxPublisherCycleResult =
  | { status: 'idle' }
  | { status: 'published' | 'retry_scheduled' | 'dead_lettered' | 'lost_lease'; attempt: number }

export interface DurableOutboxPublisher<TPayload = unknown> {
  runOnce(): Promise<OutboxPublisherCycleResult>
  abortActive(): void
}

export interface DurableOutboxPublisherOptions<TPayload> {
  outbox: DurableOutbox<TPayload>
  transport: OutboxTransport<TPayload>
  publisherId: string
  leaseMs: number
  retryPolicy?: Partial<OutboxRetryPolicy>
  now?: () => string
  classifyThrownError?: (error: unknown) => OutboxFailure
}

export class OutboxPublisherMutationError extends Error {
  readonly code = 'OUTBOX_PUBLISHER_MUTATION_FAILED'
  readonly reason: OutboxMutationFailureReason

  constructor(reason: OutboxMutationFailureReason) {
    super('Durable outbox mutation failed.')
    this.name = 'OutboxPublisherMutationError'
    this.reason = reason
  }
}

const DEFAULT_RETRY_POLICY: OutboxRetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 300_000,
}

/**
 * Executes one at-least-once publish attempt. External success and durable ack
 * are necessarily separate operations: if ack is ambiguous the lease expires
 * and the same eventId may be published again. Consumers must de-duplicate on
 * eventId; fencing guarantees an older attempt cannot ack a reclaimed event.
 */
export function createDurableOutboxPublisher<TPayload>(
  options: DurableOutboxPublisherOptions<TPayload>,
): DurableOutboxPublisher<TPayload> {
  nonEmpty(options.publisherId, 'publisherId')
  positiveInteger(options.leaseMs, 'leaseMs')
  const retryPolicy: OutboxRetryPolicy = {
    initialDelayMs: options.retryPolicy?.initialDelayMs ?? DEFAULT_RETRY_POLICY.initialDelayMs,
    maxDelayMs: options.retryPolicy?.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
  }
  // The exported calculator performs full policy validation.
  calculateOutboxRetryDelayMs(1, retryPolicy)
  const now = options.now ?? (() => new Date().toISOString())
  let activeAbort: AbortController | undefined

  async function runOnce(): Promise<OutboxPublisherCycleResult> {
    const lease = await options.outbox.claimNext({
      publisherId: options.publisherId,
      now: now(),
      leaseMs: options.leaseMs,
    })
    if (!lease) return { status: 'idle' }

    const abort = new AbortController()
    activeAbort = abort
    let publication: OutboxPublishResult
    try {
      publication = await options.transport.publish({
        eventId: lease.eventId,
        tenantId: lease.tenantId,
        workspaceId: lease.workspaceId,
        aggregateType: lease.aggregateType,
        aggregateId: lease.aggregateId,
        topic: lease.topic,
        payload: lease.payload,
        occurredAt: lease.occurredAt,
        attempt: lease.attempt,
        fence: lease.fence,
        signal: abort.signal,
      })
      validatePublishResult(publication)
    } catch (error) {
      const failure = options.classifyThrownError?.(error) ?? {
        code: 'OUTBOX_PUBLISH_ERROR',
        retryable: true,
      }
      validateOutboxFailure(failure)
      publication = { ok: false, failure }
    } finally {
      if (activeAbort === abort) activeAbort = undefined
    }

    const identity = {
      eventId: lease.eventId,
      attempt: lease.attempt,
      fence: lease.fence,
      publisherId: lease.publisherId,
      leaseToken: lease.leaseToken,
    }

    if (publication.ok) {
      const mutation = await options.outbox.ack({
        ...identity,
        publishedAt: now(),
        publicationFingerprint: publication.publicationFingerprint,
      })
      return mutationResult(mutation, 'published', lease.attempt)
    }

    const failedAt = now()
    if (!publication.failure.retryable || lease.attempt >= lease.maxAttempts) {
      const mutation = await options.outbox.deadLetter({
        ...identity,
        failedAt,
        failure: publication.failure,
      })
      return mutationResult(mutation, 'dead_lettered', lease.attempt)
    }

    const delayMs = calculateOutboxRetryDelayMs(lease.attempt, retryPolicy)
    const mutation = await options.outbox.retry({
      ...identity,
      failedAt,
      availableAt: new Date(Date.parse(failedAt) + delayMs).toISOString(),
      failure: publication.failure,
    })
    return mutationResult(mutation, 'retry_scheduled', lease.attempt)
  }

  function abortActive() {
    activeAbort?.abort()
  }

  return { runOnce, abortActive }
}

function mutationResult(
  mutation: Awaited<ReturnType<DurableOutbox['ack']>>,
  success: 'published' | 'retry_scheduled' | 'dead_lettered',
  attempt: number,
): OutboxPublisherCycleResult {
  if (mutation.ok) return { status: success, attempt }
  if (
    mutation.reason === 'stale_lease'
    || mutation.reason === 'lease_expired'
    || mutation.reason === 'terminal_conflict'
  ) {
    return { status: 'lost_lease', attempt }
  }
  throw new OutboxPublisherMutationError(mutation.reason)
}

function validatePublishResult(result: OutboxPublishResult) {
  if (result.ok) nonEmpty(result.publicationFingerprint, 'publicationFingerprint')
  else validateOutboxFailure(result.failure)
}

function nonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} must not be empty`)
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
