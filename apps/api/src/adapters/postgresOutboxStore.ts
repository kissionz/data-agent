import { createHash, randomBytes } from 'node:crypto'
import type {
  AckOutboxMessageInput,
  ClaimOutboxMessageInput,
  DeadLetterOutboxMessageInput,
  DurableOutbox,
  EnqueueOutboxMessageResult,
  GetOutboxMessageInput,
  OutboxAttemptView,
  OutboxEnqueueInput,
  OutboxFailure,
  OutboxMessageLease,
  OutboxMessageView,
  OutboxMutationResult,
  RetryOutboxMessageInput,
} from '../../../../src/persistence/outboxPorts'
import {
  assertPublicOutboxPayload,
  canonicalizeOutboxPayload,
  validateOutboxFailure,
} from '../../../../src/persistence/outboxPorts'

interface PgResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface PostgresOutboxClientLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  release?(error?: Error | boolean): void
}

export interface PostgresOutboxPoolLike {
  connect(): Promise<PostgresOutboxClientLike>
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  end?(): Promise<void>
}

export interface PostgresOutboxStoreOptions {
  pool: PostgresOutboxPoolLike
  leaseToken?: () => string
  closePool?: boolean
}

export interface PostgresOutboxStore<TPayload = unknown> extends DurableOutbox<TPayload> {
  enqueue(input: OutboxEnqueueInput<TPayload>): Promise<EnqueueOutboxMessageResult>
  /**
   * Reuses an existing control-plane transaction. This method never begins,
   * commits, rolls back, or releases the supplied client.
   */
  enqueueWithClient(
    client: PostgresOutboxClientLike,
    input: OutboxEnqueueInput<TPayload>,
  ): Promise<EnqueueOutboxMessageResult>
  claimNext(input: ClaimOutboxMessageInput): Promise<OutboxMessageLease<TPayload> | undefined>
  ack(input: AckOutboxMessageInput): Promise<OutboxMutationResult>
  retry(input: RetryOutboxMessageInput): Promise<OutboxMutationResult>
  deadLetter(input: DeadLetterOutboxMessageInput): Promise<OutboxMutationResult>
  getMessage(input: GetOutboxMessageInput): Promise<OutboxMessageView | undefined>
  close(): Promise<void>
}

interface OutboxRow {
  event_id: string
  tenant_id: string
  workspace_id: string
  aggregate_type: OutboxMessageView['aggregateType']
  aggregate_id: string
  topic: string
  payload_fingerprint: string
  payload_json: unknown
  status: OutboxMessageView['status']
  attempt: number | string
  max_attempts: number | string
  fence: number | string
  occurred_at: string | Date
  available_at: string | Date
  lease_owner: string | null
  lease_token_hash: string | null
  lease_expires_at: string | Date | null
  published_at: string | Date | null
  dead_lettered_at: string | Date | null
  publication_fingerprint: string | null
  last_failure_json: unknown
  terminal_kind: 'published' | 'retry_scheduled' | 'dead_lettered' | null
  terminal_attempt: number | string | null
  terminal_fence: number | string | null
  terminal_publisher_id: string | null
  terminal_lease_token_hash: string | null
  terminal_fingerprint: string | null
  created_at: string | Date
  updated_at: string | Date
  previous_status?: OutboxMessageView['status']
  previous_attempt?: number | string
}

interface AttemptRow {
  attempt: number | string
  fence: number | string
  publisher_id: string
  started_at: string | Date
  lease_expires_at: string | Date
  ended_at: string | Date | null
  outcome: OutboxAttemptView['outcome'] | null
  failure_json: unknown
}

interface DatabaseClockRow {
  db_now: string | Date
}

const unsafeStringPatterns = [
  /\b(?:postgres(?:ql)?|mysql|mariadb|snowflake|clickhouse|redshift):\/\//i,
  /\bjdbc:[a-z][a-z0-9+.-]*:/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\b/i,
  /^\s*(?:select|with|insert|update|delete|merge|copy|alter|create|drop|truncate|grant|revoke)\b/i,
] as const

const leaseExpiredFailure: OutboxFailure = {
  code: 'LEASE_EXPIRED',
  retryable: true,
}

const businessEventClockSkewMs = 5 * 60_000

/** Node-only PostgreSQL durable outbox. */
export function createPostgresOutboxStore<TPayload = unknown>(
  options: PostgresOutboxStoreOptions,
): PostgresOutboxStore<TPayload> {
  const nextLeaseToken = options.leaseToken ?? (() => randomBytes(32).toString('base64url'))

  async function enqueue(input: OutboxEnqueueInput<TPayload>) {
    return await transaction(options.pool, async (client) => await enqueueWithClient(client, input))
  }

  async function enqueueBound(
    client: PostgresOutboxClientLike,
    input: OutboxEnqueueInput<TPayload>,
  ) {
    return await enqueueWithClient(client, input)
  }

  async function claimNext(
    input: ClaimOutboxMessageInput,
  ): Promise<OutboxMessageLease<TPayload> | undefined> {
    validateClaim(input)
    const leaseToken = nextLeaseToken()
    nonEmpty(leaseToken, 'leaseToken', 512)
    const tokenHash = hash(leaseToken)

    return await transaction(options.pool, async (client) => {
      await deadLetterExhaustedExpiredLeases(client, input.eventId)
      const claimed = await client.query<OutboxRow>(`with db_clock as (
  select clock_timestamp() as db_now
), candidate as (
  select message.event_id,
         message.status as previous_status,
         message.attempt as previous_attempt,
         db_clock.db_now
  from chatbi_query_outbox as message
  cross join db_clock
  where ($1::text is null or message.event_id = $1)
    and message.attempt < message.max_attempts
    and (
      (message.status in ('pending', 'retry_wait') and message.available_at <= db_clock.db_now)
      or (message.status = 'leased' and message.lease_expires_at <= db_clock.db_now)
    )
  order by message.available_at asc, message.occurred_at asc, message.event_id asc
  for update of message skip locked
  limit 1
), claimed as (
  update chatbi_query_outbox as event
  set status = 'leased',
      attempt = event.attempt + 1,
      fence = event.fence + 1,
      lease_owner = $2,
      lease_token_hash = $3,
      lease_expires_at = candidate.db_now + ($5::bigint * interval '1 millisecond'),
      last_failure_json = case
        when candidate.previous_status = 'leased' then $4::jsonb
        else event.last_failure_json
      end,
      terminal_kind = null,
      terminal_attempt = null,
      terminal_fence = null,
      terminal_publisher_id = null,
      terminal_lease_token_hash = null,
      terminal_fingerprint = null,
      updated_at = candidate.db_now
  from candidate
  where event.event_id = candidate.event_id
  returning event.*, candidate.previous_status, candidate.previous_attempt
)
select * from claimed`, [
        input.eventId ?? null,
        input.publisherId,
        tokenHash,
        stringifyJson(leaseExpiredFailure, 'lease failure'),
        input.leaseMs,
      ])
      const row = claimed.rows[0]
      if (!row) return undefined
      const claimedAt = iso(row.updated_at)
      if (!row.lease_expires_at) throw new Error('claimed outbox lease expiry is missing')
      const leaseExpiresAt = iso(row.lease_expires_at)

      if (row.previous_status === 'leased') {
        const closed = await closeAttempt(
          client,
          row.event_id,
          integer(row.previous_attempt, 'previous_attempt'),
          claimedAt,
          'lease_expired',
          leaseExpiredFailure,
        )
        if (closed !== 1) throw new Error('expired outbox attempt could not be closed')
      }
      const attempt = integer(row.attempt, 'attempt')
      const fence = integer(row.fence, 'fence')
      await client.query(`insert into chatbi_query_outbox_attempts (
  event_id, tenant_id, workspace_id, attempt, fence, publisher_id,
  lease_token_hash, started_at, lease_expires_at
) values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)`, [
        row.event_id,
        row.tenant_id,
        row.workspace_id,
        attempt,
        fence,
        input.publisherId,
        tokenHash,
        claimedAt,
        leaseExpiresAt,
      ])
      return {
        eventId: row.event_id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        topic: row.topic,
        payload: parsePayload<TPayload>(row.payload_json),
        occurredAt: iso(row.occurred_at),
        attempt,
        maxAttempts: integer(row.max_attempts, 'max_attempts'),
        fence,
        publisherId: input.publisherId,
        leaseToken,
        claimedAt,
        leaseExpiresAt,
      }
    })
  }

  async function ack(input: AckOutboxMessageInput): Promise<OutboxMutationResult> {
    const publishedAt = instant(input.publishedAt, 'publishedAt')
    opaqueIdentifier(input.publicationFingerprint, 'publicationFingerprint')
    const lease = validateLeaseMutation(input)
    return await transaction(options.pool, async (client) => {
      const current = await lockMessage(client, input.eventId)
      if (matchesTerminal(
        current,
        input,
        lease.tokenHash,
        'published',
        input.publicationFingerprint,
      )) {
        return {
          ok: true,
          applied: false,
          message: await requiredMessage(client, input.eventId),
        }
      }
      const dbNow = await databaseNow(client)
      validateBusinessEventTime(publishedAt, current, dbNow, 'publishedAt')
      const invalid = await mutationFailure(client, current, input, lease.tokenHash, dbNow)
      if (invalid) return invalid
      const updated = await client.query(`update chatbi_query_outbox
set status = 'published',
    lease_owner = null,
    lease_token_hash = null,
    lease_expires_at = null,
    published_at = $6::timestamptz,
    publication_fingerprint = $7,
    terminal_kind = 'published',
    terminal_attempt = $2,
    terminal_fence = $3,
    terminal_publisher_id = $4,
    terminal_lease_token_hash = $5,
    terminal_fingerprint = $7,
    updated_at = clock_timestamp()
where event_id = $1
  and status = 'leased'
  and attempt = $2
  and fence = $3
  and lease_owner = $4
  and lease_token_hash = $5
  and lease_expires_at > clock_timestamp()`, [
        input.eventId,
        input.attempt,
        input.fence,
        input.publisherId,
        lease.tokenHash,
        publishedAt,
        input.publicationFingerprint,
      ])
      if (updated.rowCount !== 1) {
        return await mutationFailureAfterCas(client, current, input, lease.tokenHash)
      }
      if (await closeAttempt(client, input.eventId, input.attempt, publishedAt, 'published') !== 1) {
        throw new Error('published outbox attempt could not be closed')
      }
      return { ok: true, applied: true, message: await requiredMessage(client, input.eventId) }
    })
  }

  async function retry(input: RetryOutboxMessageInput): Promise<OutboxMutationResult> {
    const failedAt = instant(input.failedAt, 'failedAt')
    const availableAt = instant(input.availableAt, 'availableAt')
    if (Date.parse(availableAt) < Date.parse(failedAt)) {
      throw new Error('availableAt cannot be before failedAt')
    }
    validateFailure(input.failure)
    const lease = validateLeaseMutation(input)
    const terminalFingerprint = fingerprint({
      failure: input.failure,
      availableAt,
    })
    return await transaction(options.pool, async (client) => {
      const current = await lockMessage(client, input.eventId)
      if (matchesTerminal(current, input, lease.tokenHash, 'retry_scheduled', terminalFingerprint)) {
        return {
          ok: true,
          applied: false,
          message: await requiredMessage(client, input.eventId),
        }
      }
      const dbNow = await databaseNow(client)
      validateBusinessEventTime(failedAt, current, dbNow, 'failedAt')
      const invalid = await mutationFailure(client, current, input, lease.tokenHash, dbNow)
      if (invalid) return invalid
      const message = await requiredMessage(client, input.eventId)
      if (!input.failure.retryable) {
        return { ok: false, reason: 'failure_not_retryable', message }
      }
      if (message.attempt >= message.maxAttempts) {
        return { ok: false, reason: 'attempts_exhausted', message }
      }
      const updated = await client.query(`update chatbi_query_outbox
set status = 'retry_wait',
    lease_owner = null,
    lease_token_hash = null,
    lease_expires_at = null,
    available_at = $6::timestamptz,
    last_failure_json = $7::jsonb,
    terminal_kind = 'retry_scheduled',
    terminal_attempt = $2,
    terminal_fence = $3,
    terminal_publisher_id = $4,
    terminal_lease_token_hash = $5,
    terminal_fingerprint = $8,
    updated_at = clock_timestamp()
where event_id = $1
  and status = 'leased'
  and attempt = $2
  and attempt < max_attempts
  and fence = $3
  and lease_owner = $4
  and lease_token_hash = $5
  and lease_expires_at > clock_timestamp()`, [
        input.eventId,
        input.attempt,
        input.fence,
        input.publisherId,
        lease.tokenHash,
        availableAt,
        stringifyJson(input.failure, 'failure'),
        terminalFingerprint,
      ])
      if (updated.rowCount !== 1) {
        return await mutationFailureAfterCas(client, current, input, lease.tokenHash)
      }
      if (
        await closeAttempt(
          client,
          input.eventId,
          input.attempt,
          failedAt,
          'retry_scheduled',
          input.failure,
        ) !== 1
      ) {
        throw new Error('retried outbox attempt could not be closed')
      }
      return { ok: true, applied: true, message: await requiredMessage(client, input.eventId) }
    })
  }

  async function deadLetter(input: DeadLetterOutboxMessageInput): Promise<OutboxMutationResult> {
    const failedAt = instant(input.failedAt, 'failedAt')
    validateFailure(input.failure)
    const lease = validateLeaseMutation(input)
    const terminalFingerprint = fingerprint(input.failure)
    return await transaction(options.pool, async (client) => {
      const current = await lockMessage(client, input.eventId)
      if (matchesTerminal(current, input, lease.tokenHash, 'dead_lettered', terminalFingerprint)) {
        return {
          ok: true,
          applied: false,
          message: await requiredMessage(client, input.eventId),
        }
      }
      const dbNow = await databaseNow(client)
      validateBusinessEventTime(failedAt, current, dbNow, 'failedAt')
      const invalid = await mutationFailure(client, current, input, lease.tokenHash, dbNow)
      if (invalid) return invalid
      const updated = await client.query(`update chatbi_query_outbox
set status = 'dead_lettered',
    lease_owner = null,
    lease_token_hash = null,
    lease_expires_at = null,
    dead_lettered_at = $6::timestamptz,
    last_failure_json = $7::jsonb,
    terminal_kind = 'dead_lettered',
    terminal_attempt = $2,
    terminal_fence = $3,
    terminal_publisher_id = $4,
    terminal_lease_token_hash = $5,
    terminal_fingerprint = $8,
    updated_at = clock_timestamp()
where event_id = $1
  and status = 'leased'
  and attempt = $2
  and fence = $3
  and lease_owner = $4
  and lease_token_hash = $5
  and lease_expires_at > clock_timestamp()`, [
        input.eventId,
        input.attempt,
        input.fence,
        input.publisherId,
        lease.tokenHash,
        failedAt,
        stringifyJson(input.failure, 'failure'),
        terminalFingerprint,
      ])
      if (updated.rowCount !== 1) {
        return await mutationFailureAfterCas(client, current, input, lease.tokenHash)
      }
      if (
        await closeAttempt(
          client,
          input.eventId,
          input.attempt,
          failedAt,
          'dead_lettered',
          input.failure,
        ) !== 1
      ) {
        throw new Error('dead-lettered outbox attempt could not be closed')
      }
      return { ok: true, applied: true, message: await requiredMessage(client, input.eventId) }
    })
  }

  async function getMessage(input: GetOutboxMessageInput) {
    validateScope(input)
    return await loadMessage(options.pool, input.eventId, input)
  }

  async function close() {
    if (options.closePool) await options.pool.end?.()
  }

  return {
    enqueue,
    enqueueWithClient: enqueueBound,
    claimNext,
    ack,
    retry,
    deadLetter,
    getMessage,
    close,
  }
}

/**
 * Transaction-bound enqueue primitive used by the query control plane.
 * It deliberately does not manage the supplied client's transaction.
 */
export async function enqueueWithClient<TPayload = unknown>(
  client: PostgresOutboxClientLike,
  input: OutboxEnqueueInput<TPayload>,
): Promise<EnqueueOutboxMessageResult> {
  const normalized = validateEnqueue(input)
  const payloadJson = canonicalizeOutboxPayload(input.payload)
  const payloadFingerprint = fingerprint({
    eventId: input.eventId,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    topic: input.topic,
    payload: JSON.parse(payloadJson) as unknown,
    occurredAt: normalized.occurredAt,
    availableAt: normalized.availableAt,
    maxAttempts: normalized.maxAttempts,
  })
  const inserted = await client.query(`insert into chatbi_query_outbox (
  event_id, tenant_id, workspace_id, aggregate_type, aggregate_id, topic,
  payload_fingerprint, payload_json, status, attempt, max_attempts, fence,
  occurred_at, available_at, created_at, updated_at
) values (
  $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', 0, $9, 0,
  $10::timestamptz, $11::timestamptz, $10::timestamptz, $10::timestamptz
) on conflict (event_id) do nothing
returning event_id`, [
    input.eventId,
    input.tenantId,
    input.workspaceId,
    input.aggregateType,
    input.aggregateId,
    input.topic,
    payloadFingerprint,
    payloadJson,
    normalized.maxAttempts,
    normalized.occurredAt,
    normalized.availableAt,
  ])
  const row = await loadRow(client, input.eventId)
  if (!row) throw new Error('outbox event could not be loaded')
  if (row.tenant_id !== input.tenantId || row.workspace_id !== input.workspaceId) {
    return { ok: false, reason: 'idempotency_conflict' }
  }
  const message = await mapMessage(client, row)
  if (row.payload_fingerprint !== payloadFingerprint) {
    return { ok: false, reason: 'idempotency_conflict', message }
  }
  return { ok: true, created: inserted.rowCount === 1, message }
}

async function deadLetterExhaustedExpiredLeases(
  client: PostgresOutboxClientLike,
  eventId: string | undefined,
) {
  const candidates = await client.query<
    Pick<OutboxRow, 'event_id' | 'attempt'> & DatabaseClockRow
  >(`with db_clock as (
  select clock_timestamp() as db_now
)
select event_id, attempt, db_clock.db_now
from chatbi_query_outbox as message
cross join db_clock
where ($1::text is null or message.event_id = $1)
  and message.status = 'leased'
  and message.lease_expires_at <= db_clock.db_now
  and message.attempt >= message.max_attempts
order by message.lease_expires_at asc, message.event_id asc
for update of message skip locked
limit 100`, [eventId ?? null])
  for (const candidate of candidates.rows) {
    const attempt = integer(candidate.attempt, 'attempt')
    const dbNow = iso(candidate.db_now)
    const updated = await client.query(`update chatbi_query_outbox
set status = 'dead_lettered',
    lease_owner = null,
    lease_token_hash = null,
    lease_expires_at = null,
    dead_lettered_at = $2::timestamptz,
    last_failure_json = $3::jsonb,
    terminal_kind = null,
    terminal_attempt = null,
    terminal_fence = null,
    terminal_publisher_id = null,
    terminal_lease_token_hash = null,
    terminal_fingerprint = null,
    updated_at = $2::timestamptz
where event_id = $1
  and status = 'leased'
  and attempt = $4
  and attempt >= max_attempts
  and lease_expires_at <= $2::timestamptz`, [
      candidate.event_id,
      dbNow,
      stringifyJson(leaseExpiredFailure, 'lease failure'),
      attempt,
    ])
    if (updated.rowCount !== 1) continue
    if (
      await closeAttempt(
        client,
        candidate.event_id,
        attempt,
        dbNow,
        'lease_expired',
        leaseExpiredFailure,
      ) !== 1
    ) {
      throw new Error('exhausted outbox attempt could not be closed')
    }
  }
}

async function closeAttempt(
  client: PostgresOutboxClientLike,
  eventId: string,
  attempt: number,
  endedAt: string,
  outcome: NonNullable<OutboxAttemptView['outcome']>,
  failure?: OutboxFailure,
) {
  const result = await client.query(`update chatbi_query_outbox_attempts
set ended_at = $3::timestamptz,
    outcome = $4,
    failure_json = $5::jsonb
where event_id = $1
  and attempt = $2
  and ended_at is null`, [
    eventId,
    attempt,
    endedAt,
    outcome,
    failure ? stringifyJson(failure, 'failure') : null,
  ])
  return result.rowCount
}

async function mutationFailure(
  client: PostgresOutboxClientLike,
  row: OutboxRow | undefined,
  input: Pick<AckOutboxMessageInput, 'eventId' | 'attempt' | 'fence' | 'publisherId'>,
  tokenHash: string,
  at: string,
): Promise<OutboxMutationResult | undefined> {
  if (!row) return { ok: false, reason: 'not_found' }
  const message = await mapMessage(client, row)
  if (row.status === 'published' || row.status === 'dead_lettered') {
    return { ok: false, reason: 'terminal_conflict', message }
  }
  if (row.status !== 'leased'
    || integer(row.attempt, 'attempt') !== input.attempt
    || integer(row.fence, 'fence') !== input.fence
    || row.lease_owner !== input.publisherId
    || row.lease_token_hash !== tokenHash) {
    return { ok: false, reason: 'stale_lease', message }
  }
  if (!row.lease_expires_at || Date.parse(iso(row.lease_expires_at)) <= Date.parse(at)) {
    return { ok: false, reason: 'lease_expired', message }
  }
  return undefined
}

async function mutationFailureAfterCas(
  client: PostgresOutboxClientLike,
  row: OutboxRow | undefined,
  input: Pick<AckOutboxMessageInput, 'eventId' | 'attempt' | 'fence' | 'publisherId'>,
  tokenHash: string,
): Promise<OutboxMutationResult> {
  const dbNow = await databaseNow(client)
  const classified = await mutationFailure(client, row, input, tokenHash, dbNow)
  if (classified) return classified
  const message = await loadMessage(client, input.eventId)
  return { ok: false, reason: 'invalid_state', ...(message ? { message } : {}) }
}

async function databaseNow(client: PostgresOutboxClientLike) {
  const result = await client.query<DatabaseClockRow>(
    'select clock_timestamp() as db_now',
  )
  const row = result.rows[0]
  if (!row) throw new Error('database clock could not be read')
  return iso(row.db_now)
}

function validateBusinessEventTime(
  at: string,
  row: OutboxRow | undefined,
  dbNow: string,
  label: string,
) {
  if (!row) return
  const timestamp = Date.parse(at)
  const occurredAt = Date.parse(iso(row.occurred_at))
  const databaseTimestamp = Date.parse(dbNow)
  if (
    timestamp < occurredAt
    || Math.abs(timestamp - databaseTimestamp) > businessEventClockSkewMs
  ) {
    throw new Error(`${label} is outside the allowed database clock window`)
  }
}

function matchesTerminal(
  row: OutboxRow | undefined,
  input: Pick<AckOutboxMessageInput, 'attempt' | 'fence' | 'publisherId'>,
  tokenHash: string,
  kind: NonNullable<OutboxRow['terminal_kind']>,
  terminalFingerprint: string,
) {
  return Boolean(
    row
    && row.terminal_kind === kind
    && integer(row.terminal_attempt, 'terminal_attempt') === input.attempt
    && integer(row.terminal_fence, 'terminal_fence') === input.fence
    && row.terminal_publisher_id === input.publisherId
    && row.terminal_lease_token_hash === tokenHash
    && row.terminal_fingerprint === terminalFingerprint,
  )
}

async function lockMessage(client: PostgresOutboxClientLike, eventId: string) {
  const result = await client.query<OutboxRow>(
    'select * from chatbi_query_outbox where event_id = $1 for update',
    [eventId],
  )
  return result.rows[0]
}

async function loadRow(
  client: Pick<PostgresOutboxClientLike, 'query'>,
  eventId: string,
  scope?: Pick<GetOutboxMessageInput, 'tenantId' | 'workspaceId'>,
) {
  const result = scope
    ? await client.query<OutboxRow>(`select * from chatbi_query_outbox
where tenant_id = $1 and workspace_id = $2 and event_id = $3`, [
        scope.tenantId,
        scope.workspaceId,
        eventId,
      ])
    : await client.query<OutboxRow>(
        'select * from chatbi_query_outbox where event_id = $1',
        [eventId],
      )
  return result.rows[0]
}

async function requiredMessage(client: PostgresOutboxClientLike, eventId: string) {
  const message = await loadMessage(client, eventId)
  if (!message) throw new Error('outbox event could not be loaded')
  return message
}

async function loadMessage(
  client: Pick<PostgresOutboxClientLike, 'query'>,
  eventId: string,
  scope?: Pick<GetOutboxMessageInput, 'tenantId' | 'workspaceId'>,
) {
  const row = await loadRow(client, eventId, scope)
  return row ? await mapMessage(client, row) : undefined
}

async function mapMessage(
  client: Pick<PostgresOutboxClientLike, 'query'>,
  row: OutboxRow,
): Promise<OutboxMessageView> {
  const attempts = await client.query<AttemptRow>(`select
  attempt, fence, publisher_id, started_at, lease_expires_at,
  ended_at, outcome, failure_json
from chatbi_query_outbox_attempts
where event_id = $1
order by attempt asc`, [row.event_id])
  return {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    topic: row.topic,
    status: row.status,
    attempt: integer(row.attempt, 'attempt'),
    maxAttempts: integer(row.max_attempts, 'max_attempts'),
    fence: integer(row.fence, 'fence'),
    occurredAt: iso(row.occurred_at),
    availableAt: iso(row.available_at),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.published_at ? { publishedAt: iso(row.published_at) } : {}),
    ...(row.dead_lettered_at ? { deadLetteredAt: iso(row.dead_lettered_at) } : {}),
    ...(row.publication_fingerprint ? { publicationFingerprint: row.publication_fingerprint } : {}),
    ...(row.last_failure_json ? { lastFailure: parseFailure(row.last_failure_json) } : {}),
    attempts: attempts.rows.map(mapAttempt),
  }
}

function mapAttempt(row: AttemptRow): OutboxAttemptView {
  return {
    attempt: integer(row.attempt, 'attempt'),
    fence: integer(row.fence, 'fence'),
    publisherId: row.publisher_id,
    startedAt: iso(row.started_at),
    leaseExpiresAt: iso(row.lease_expires_at),
    ...(row.ended_at ? { endedAt: iso(row.ended_at) } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.failure_json ? { failure: parseFailure(row.failure_json) } : {}),
  }
}

function validateEnqueue<TPayload>(input: OutboxEnqueueInput<TPayload>) {
  opaqueIdentifier(input.eventId, 'eventId')
  opaqueIdentifier(input.tenantId, 'tenantId')
  opaqueIdentifier(input.workspaceId, 'workspaceId')
  opaqueIdentifier(input.aggregateId, 'aggregateId')
  if (!['query_run', 'conversation', 'workspace'].includes(input.aggregateType)) {
    throw new Error('aggregateType is invalid')
  }
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(input.topic) || input.topic.length > 160) {
    throw new Error('topic is invalid')
  }
  validatePublicSafePayload(input.payload)
  const occurredAt = instant(input.occurredAt, 'occurredAt')
  const availableAt = instant(input.availableAt ?? input.occurredAt, 'availableAt')
  if (Date.parse(availableAt) < Date.parse(occurredAt)) {
    throw new Error('availableAt cannot be before occurredAt')
  }
  const maxAttempts = input.maxAttempts ?? 5
  boundedInteger(maxAttempts, 'maxAttempts', 1, 100)
  return { occurredAt, availableAt, maxAttempts }
}

function validateClaim(input: ClaimOutboxMessageInput) {
  opaqueIdentifier(input.publisherId, 'publisherId')
  instant(input.now, 'now')
  boundedInteger(input.leaseMs, 'leaseMs', 100, 3_600_000)
  if (input.eventId !== undefined) opaqueIdentifier(input.eventId, 'eventId')
}

function validateLeaseMutation(
  input: Pick<AckOutboxMessageInput, 'eventId' | 'attempt' | 'fence' | 'publisherId' | 'leaseToken'>,
) {
  opaqueIdentifier(input.eventId, 'eventId')
  opaqueIdentifier(input.publisherId, 'publisherId')
  boundedInteger(input.attempt, 'attempt', 1, Number.MAX_SAFE_INTEGER)
  boundedInteger(input.fence, 'fence', 1, Number.MAX_SAFE_INTEGER)
  nonEmpty(input.leaseToken, 'leaseToken', 512)
  return { tokenHash: hash(input.leaseToken) }
}

function validateScope(input: GetOutboxMessageInput) {
  opaqueIdentifier(input.tenantId, 'tenantId')
  opaqueIdentifier(input.workspaceId, 'workspaceId')
  opaqueIdentifier(input.eventId, 'eventId')
}

function validateFailure(failure: OutboxFailure) {
  if (!failure || typeof failure !== 'object') throw new Error('failure is invalid')
  validateOutboxFailure(failure)
  const keys = Object.keys(failure)
  if (keys.some((key) => !['code', 'retryable'].includes(key))) {
    throw new Error('failure contains an unsafe field')
  }
}

function validatePublicSafePayload(payload: unknown) {
  assertPublicOutboxPayload(payload)
  if (!isPlainObject(payload)) throw new Error('outbox payload must be a plain JSON object')
  const visit = (value: unknown, path: string) => {
    if (value === null || typeof value === 'boolean') return
    if (typeof value === 'number') {
      return
    }
    if (typeof value === 'string') {
      if (unsafeStringPatterns.some((pattern) => pattern.test(value))) {
        throw new Error(`outbox payload contains sensitive content at ${path}`)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`))
      return
    }
    if (isPlainObject(value)) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, `${path}.${key}`)
      }
      return
    }
    throw new Error(`outbox payload contains a non-JSON value at ${path}`)
  }
  visit(payload, '$')
}

async function transaction<T>(
  pool: PostgresOutboxPoolLike,
  work: (client: PostgresOutboxClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let began = false
  let destroy = false
  try {
    await client.query('BEGIN')
    began = true
    const result = await work(client)
    await client.query('COMMIT')
    began = false
    return result
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK')
      } catch {
        destroy = true
      }
    }
    throw error
  } finally {
    client.release?.(destroy || undefined)
  }
}

function parseStoredPublicPayload(value: unknown) {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  validatePublicSafePayload(parsed)
  return parsed
}

function parsePayload<TPayload>(value: unknown): TPayload {
  return parseStoredPublicPayload(value) as TPayload
}

function parseFailure(value: unknown): OutboxFailure {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
  validateFailure(parsed as OutboxFailure)
  return parsed as OutboxFailure
}

function stringifyJson(value: unknown, label: string) {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new Error()
    return serialized
  } catch {
    throw new Error(`${label} is not valid JSON`)
  }
}

function fingerprint(value: unknown) {
  return hash(canonicalizeOutboxPayload(value))
}

function hash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function opaqueIdentifier(value: string, label: string) {
  nonEmpty(value, label, 256)
  if (/[\u0000-\u001f\u007f\s]/.test(value) || unsafeStringPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} is invalid`)
  }
}

function nonEmpty(value: string, label: string, maxLength: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} is invalid`)
  }
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`)
  }
}

function integer(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`)
  return parsed
}

function instant(value: string, label: string) {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid`)
  return new Date(timestamp).toISOString()
}

function iso(value: string | Date) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('stored timestamp is invalid')
  return new Date(timestamp).toISOString()
}
