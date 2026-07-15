import { createHash } from 'node:crypto'
import type { AuditEvent } from '../../../../src/contracts'
import { isRunActive, transitionRun, type Conversation } from '../../../../src/domain'
import type {
  CancelControlPlaneRunInput,
  CancelControlPlaneRunResult,
  CommitControlPlaneAttemptInput,
  ControlPlaneAttemptMutation,
  ControlPlaneEventInput,
  ControlPlaneResultPublication,
  ControlPlaneConversationKey,
  ControlPlaneIdempotencyLookup,
  ControlPlaneIdempotencyLookupResult,
  ControlPlaneRunKey,
  QueryExecutionControlPlane,
  SubmitAndEnqueueConflictReason,
  SubmitAndEnqueueInput,
  SubmitAndEnqueueResult,
} from '../../../../src/persistence/controlPlanePorts'
import type {
  LeaseMutationInput,
  RunJobAttemptView,
  RunJobFailure,
  RunJobMutationResult,
  RunJobView,
} from '../../../../src/persistence/jobPorts'
import type { StoredRunRecord } from '../../../../src/persistence/ports'

interface PgResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface PostgresQueryControlPlaneClientLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresQueryControlPlanePoolLike {
  connect(): Promise<PostgresQueryControlPlaneClientLike>
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  end?(): Promise<void>
}

export interface PostgresQueryControlPlaneOptions {
  pool: PostgresQueryControlPlanePoolLike
  closePool?: boolean
}

export interface PostgresQueryControlPlane<
  TPayload = unknown,
  TResult = unknown,
  TEvent = unknown,
  TPage = unknown,
  TMetadata = unknown,
> extends QueryExecutionControlPlane<TPayload, TResult, TEvent, TPage, TMetadata> {
  readiness(): Promise<{ ok: true }>
  close(): Promise<void>
}

interface ConversationRow {
  conversation_id: string
  tenant_id: string
  workspace_id: string
  business_domain_id: string
  active_run_id: string | null
  payload_json: unknown
}

interface RunRow {
  run_id: string
  tenant_id: string
  workspace_id: string
  conversation_id: string
  request_fingerprint: string
  stored_record_json: unknown
}

interface IdempotencyRow {
  request_fingerprint: string
  run_id: string
}

interface JobRow {
  run_id: string
  tenant_id: string
  workspace_id: string
  payload_fingerprint: string
  payload_json: unknown
  status: RunJobView['status']
  attempt: number | string
  max_attempts: number | string
  fence: number | string
  enqueued_at: string | Date
  available_at: string | Date
  lease_owner: string | null
  lease_token_hash: string | null
  lease_expires_at: string | Date | null
  cancel_requested_at: string | Date | null
  completed_at: string | Date | null
  failed_at: string | Date | null
  cancelled_at: string | Date | null
  last_failure_json: unknown
  result_fingerprint: string | null
  result_json: unknown
  terminal_kind: 'completed' | 'failed' | 'retry_scheduled' | null
  terminal_attempt: number | string | null
  terminal_fence: number | string | null
  terminal_worker_id: string | null
  terminal_lease_token_hash: string | null
  terminal_fingerprint: string | null
}

interface AttemptRow {
  attempt: number | string
  fence: number | string
  worker_id: string
  started_at: string | Date
  lease_expires_at: string | Date
  ended_at: string | Date | null
  outcome: RunJobAttemptView['outcome'] | null
  failure_json: unknown
}

interface PageRow {
  page_index: number | string
  checksum: string
  content_fingerprint: string
  row_count: number | string
}

interface ManifestRow {
  manifest_checksum: string
  content_fingerprint: string
}

interface EventStreamRow { current_sequence: number | string }
interface EventRow { content_fingerprint: string }

class SubmissionConflict extends Error {
  constructor(readonly result: Extract<SubmitAndEnqueueResult, { ok: false }>) {
    super(result.reason)
  }
}

function validateCancel<TEvent>(input: CancelControlPlaneRunInput<TEvent>) {
  validateRunKey(input)
  nonEmpty(input.conversationId, 'conversationId')
  nonEmpty(input.actor.userId, 'actor.userId')
  if (input.actor.tenantId !== input.tenantId || input.actor.workspaceId !== input.workspaceId) {
    throw new Error('actor is outside the cancellation scope')
  }
  const cancelledAt = instant(input.cancelledAt, 'cancelledAt')
  validateEvent(input.event)
  if (instant(input.event.occurredAt, 'event.occurredAt') !== cancelledAt) {
    throw new Error('cancellation event time must equal cancelledAt')
  }
}

function validateCommit<TResult, TEvent, TPage, TMetadata>(
  input: CommitControlPlaneAttemptInput<TResult, TEvent, TPage, TMetadata>,
) {
  const mutation = input.job.input
  const run = input.runRecord.run
  nonEmpty(mutation.runId, 'job.runId')
  nonEmpty(mutation.workerId, 'job.workerId')
  nonEmpty(mutation.leaseToken, 'job.leaseToken')
  positiveInteger(mutation.attempt, 'job.attempt')
  positiveInteger(mutation.fence, 'job.fence')
  if (run.id !== mutation.runId
    || input.conversation.id !== run.conversationId
    || input.conversation.tenantId !== run.tenantId
    || input.conversation.workspaceId !== run.workspaceId) {
    throw new Error('commit Run and Conversation must share the job boundary')
  }
  const expectedActiveRunId = isRunActive(run) ? run.id : undefined
  if (input.conversation.activeRunId !== expectedActiveRunId) {
    throw new Error('committed Conversation active run does not match final Run state')
  }
  const at = mutationAt(input.job)
  validateEvent(input.event)
  if (instant(input.event.occurredAt, 'event.occurredAt') !== at) {
    throw new Error('commit event time must equal the job mutation time')
  }
  if (input.job.type === 'complete') {
    nonEmpty(input.job.input.resultFingerprint, 'resultFingerprint')
    stringifyJson(input.job.input.result, 'job.result')
    if (run.displayStatus !== 'completed' && run.displayStatus !== 'failed') {
      throw new Error('completed job must publish a completed or safely failed Run')
    }
  } else {
    stringifyJson(input.job.input.failure, 'job.failure')
    if (input.job.type === 'fail' && run.displayStatus !== 'failed') {
      throw new Error('failed job must publish a failed Run')
    }
    if (input.job.type === 'retry') {
      if (run.displayStatus !== 'querying') throw new Error('retry must keep the Run querying')
      const availableAt = instant(input.job.input.availableAt, 'availableAt')
      if (Date.parse(availableAt) < Date.parse(at)) throw new Error('availableAt cannot be before failedAt')
    }
  }
  if (run.displayStatus === 'completed' && !input.resultPublication) {
    throw new Error('a completed Run requires atomic result publication')
  }
  if (run.displayStatus !== 'completed' && input.resultPublication) {
    throw new Error('only a completed Run may publish result pages')
  }
  if (input.resultPublication && run.result?.id !== input.resultPublication.manifest.resultId) {
    throw new Error('published result manifest must reference the final Run result')
  }
  for (const audit of input.newAuditEvents) validateAudit(audit, run)
  if (input.resultPublication) validatePublication(input.resultPublication, run, mutation.attempt, at)
}

function validateEvent<TEvent>(event: ControlPlaneEventInput<TEvent>) {
  nonEmpty(event.eventId, 'event.eventId')
  instant(event.occurredAt, 'event.occurredAt')
  stringifyJson(event.event, 'event.event')
}

function validateAudit(audit: AuditEvent, run: StoredRunRecord['run']) {
  nonEmpty(audit.id, 'audit.id')
  if (audit.runId !== run.id || audit.tenantId !== run.tenantId || audit.workspaceId !== run.workspaceId) {
    throw new Error('new audit event is outside the committed Run boundary')
  }
  instant(audit.at, 'audit.at')
}

function validatePublication<TPage, TMetadata>(
  publication: ControlPlaneResultPublication<TPage, TMetadata>,
  run: StoredRunRecord['run'],
  attempt: number,
  at: string,
) {
  const manifest = publication.manifest
  if (manifest.runId !== run.id || manifest.tenantId !== run.tenantId || manifest.workspaceId !== run.workspaceId
    || manifest.attempt !== attempt) {
    throw new Error('result manifest is outside the committed attempt boundary')
  }
  nonEmpty(manifest.resultId, 'manifest.resultId')
  nonEmpty(manifest.manifestChecksum, 'manifest.manifestChecksum')
  nonNegativeInteger(manifest.totalRows, 'manifest.totalRows')
  if (instant(manifest.publishedAt, 'manifest.publishedAt') !== at) {
    throw new Error('manifest publication time must equal completion time')
  }
  if (publication.pages.length !== manifest.pageChecksums.length) {
    throw new Error('result pages must match manifest page count')
  }
  publication.pages.forEach((page, index) => {
    if (page.runId !== run.id || page.tenantId !== run.tenantId || page.workspaceId !== run.workspaceId
      || page.attempt !== attempt || page.pageIndex !== index || page.checksum !== manifest.pageChecksums[index]) {
      throw new Error('result page is outside or inconsistent with its manifest')
    }
    nonNegativeInteger(page.rowCount, `pages[${index}].rowCount`)
    nonEmpty(page.checksum, `pages[${index}].checksum`)
    instant(page.stagedAt, `pages[${index}].stagedAt`)
  })
}

function mutationAt<TResult>(mutation: ControlPlaneAttemptMutation<TResult>) {
  return instant(mutation.type === 'complete' ? mutation.input.completedAt : mutation.input.failedAt, `${mutation.type}At`)
}

function terminalIdentity<TResult>(mutation: ControlPlaneAttemptMutation<TResult>) {
  if (mutation.type === 'complete') return { kind: 'completed' as const, fingerprint: mutation.input.resultFingerprint }
  const failure = failureFingerprint(mutation.input.failure)
  return mutation.type === 'fail'
    ? { kind: 'failed' as const, fingerprint: failure }
    : { kind: 'retry_scheduled' as const, fingerprint: `${failure}:${instant(mutation.input.availableAt, 'availableAt')}` }
}

async function lockJob(client: PostgresQueryControlPlaneClientLike, runId: string) {
  const result = await client.query<JobRow>('select * from chatbi_run_jobs where run_id = $1 for update', [runId])
  return result.rows[0]
}

async function lockStoredRun(client: PostgresQueryControlPlaneClientLike, runId: string) {
  const result = await client.query<RunRow>(`select run_id, tenant_id, workspace_id, conversation_id,
  request_fingerprint, stored_record_json
from chatbi_query_runs where run_id = $1 for update`, [runId])
  return result.rows[0]
}

async function lockConversation(client: PostgresQueryControlPlaneClientLike, conversationId: string) {
  const result = await client.query<ConversationRow>(`select conversation_id, tenant_id, workspace_id,
  business_domain_id, active_run_id, payload_json
from chatbi_query_conversations where conversation_id = $1 for update`, [conversationId])
  return result.rows[0]
}

async function mutationFailure<TPayload, TResult>(
  client: PostgresQueryControlPlaneClientLike,
  row: JobRow | undefined,
  input: LeaseMutationInput,
  at: string,
): Promise<RunJobMutationResult<TPayload, TResult> | undefined> {
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
    return { ok: false, reason: 'terminal_conflict', job: await requiredJob<TPayload, TResult>(client, input.runId) }
  }
  if (row.status !== 'leased'
    || integer(row.attempt, 'attempt') !== input.attempt
    || integer(row.fence, 'fence') !== input.fence
    || row.lease_owner !== input.workerId
    || row.lease_token_hash !== hashToken(input.leaseToken)) {
    return { ok: false, reason: 'stale_lease', job: await requiredJob<TPayload, TResult>(client, input.runId) }
  }
  if (!row.lease_expires_at || Date.parse(iso(row.lease_expires_at)) <= Date.parse(at)) {
    return { ok: false, reason: 'lease_expired', job: await requiredJob<TPayload, TResult>(client, input.runId) }
  }
  return undefined
}

function matchesTerminal(
  row: JobRow | undefined,
  input: LeaseMutationInput,
  tokenHash: string,
  kind: NonNullable<JobRow['terminal_kind']>,
  terminalFingerprint: string,
) {
  const status = kind === 'completed' ? 'completed' : kind === 'failed' ? 'failed' : 'retry_wait'
  return Boolean(row
    && row.status === status
    && row.terminal_kind === kind
    && integer(row.terminal_attempt, 'terminal_attempt') === input.attempt
    && integer(row.terminal_fence, 'terminal_fence') === input.fence
    && row.terminal_worker_id === input.workerId
    && row.terminal_lease_token_hash === tokenHash
    && row.terminal_fingerprint === terminalFingerprint)
}

async function applyJobMutation<TResult>(
  client: PostgresQueryControlPlaneClientLike,
  mutation: ControlPlaneAttemptMutation<TResult>,
  tokenHash: string,
) {
  const input = mutation.input
  if (mutation.type === 'complete') {
    const at = instant(mutation.input.completedAt, 'completedAt')
    await client.query(`update chatbi_run_jobs
set status = 'completed', completed_at = $2::timestamptz,
    result_fingerprint = $3, result_json = $4::jsonb,
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    terminal_kind = 'completed', terminal_attempt = $5, terminal_fence = $6,
    terminal_worker_id = $7, terminal_lease_token_hash = $8,
    terminal_fingerprint = $3, updated_at = $2::timestamptz
where run_id = $1`, [
      input.runId, at, mutation.input.resultFingerprint, stringifyJson(mutation.input.result, 'result'),
      input.attempt, input.fence, input.workerId, tokenHash,
    ])
    await closeAttempt(client, input.runId, input.attempt, at, 'completed')
    return
  }
  const at = instant(mutation.input.failedAt, 'failedAt')
  const failureJson = stringifyJson(mutation.input.failure, 'failure')
  const failure = failureFingerprint(mutation.input.failure)
  if (mutation.type === 'fail') {
    await client.query(`update chatbi_run_jobs
set status = 'failed', failed_at = $2::timestamptz, last_failure_json = $3::jsonb,
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    terminal_kind = 'failed', terminal_attempt = $4, terminal_fence = $5,
    terminal_worker_id = $6, terminal_lease_token_hash = $7,
    terminal_fingerprint = $8, updated_at = $2::timestamptz
where run_id = $1`, [
      input.runId, at, failureJson, input.attempt, input.fence, input.workerId, tokenHash, failure,
    ])
    await closeAttempt(client, input.runId, input.attempt, at, 'failed', mutation.input.failure)
    return
  }
  const availableAt = instant(mutation.input.availableAt, 'availableAt')
  const terminalFingerprint = `${failure}:${availableAt}`
  await client.query(`update chatbi_run_jobs
set status = 'retry_wait', available_at = $2::timestamptz, last_failure_json = $3::jsonb,
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    terminal_kind = 'retry_scheduled', terminal_attempt = $4, terminal_fence = $5,
    terminal_worker_id = $6, terminal_lease_token_hash = $7,
    terminal_fingerprint = $8, updated_at = $9::timestamptz
where run_id = $1`, [
    input.runId, availableAt, failureJson, input.attempt, input.fence, input.workerId, tokenHash, terminalFingerprint, at,
  ])
  await closeAttempt(client, input.runId, input.attempt, at, 'retry_scheduled', mutation.input.failure)
}

async function closeAttempt(
  client: PostgresQueryControlPlaneClientLike,
  runId: string,
  attempt: number,
  endedAt: string,
  outcome: NonNullable<RunJobAttemptView['outcome']>,
  failure?: RunJobFailure,
) {
  await client.query(`update chatbi_run_job_attempts
set ended_at = $3::timestamptz, outcome = $4, failure_json = $5::jsonb
where run_id = $1 and attempt = $2 and ended_at is null`, [
    runId, attempt, endedAt, outcome, failure ? stringifyJson(failure, 'failure') : null,
  ])
}

async function updateStoredRun(client: PostgresQueryControlPlaneClientLike, record: StoredRunRecord) {
  const result = await client.query(`update chatbi_query_runs
set display_status = $4, internal_status = $5, request_id = $6, trace_id = $7,
    stored_record_json = $8::jsonb, updated_at = $9::timestamptz
where run_id = $1 and tenant_id = $2 and workspace_id = $3`, [
    record.run.id, record.run.tenantId, record.run.workspaceId, record.run.displayStatus,
    record.run.internalStatus, record.requestId, record.traceId, stringifyJson(record, 'runRecord'),
    instant(record.run.updatedAt, 'run.updatedAt'),
  ])
  if (result.rowCount !== 1) throw new Error('scoped Run update failed during atomic commit')
}

async function updateConversation(
  client: PostgresQueryControlPlaneClientLike,
  conversation: Conversation,
  businessDomainId: string,
) {
  const result = await client.query(`update chatbi_query_conversations
set active_run_id = $5, payload_json = $6::jsonb, updated_at = $7::timestamptz
where conversation_id = $1 and tenant_id = $2 and workspace_id = $3 and business_domain_id = $4`, [
    conversation.id, conversation.tenantId, conversation.workspaceId, businessDomainId,
    conversation.activeRunId ?? null, stringifyJson(conversation, 'conversation'),
    instant(conversation.updatedAt, 'conversation.updatedAt'),
  ])
  if (result.rowCount !== 1) throw new Error('scoped Conversation update failed during atomic commit')
}

async function insertAudit(client: PostgresQueryControlPlaneClientLike, audit: AuditEvent) {
  await client.query(`insert into chatbi_query_audit_events (
  tenant_id, workspace_id, run_id, event_id, event_type, actor_user_id, occurred_at, payload_json
) values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)`, [
    audit.tenantId, audit.workspaceId, audit.runId, audit.id, audit.type, audit.actorUserId,
    instant(audit.at, 'audit.at'), stringifyJson(audit, 'audit'),
  ])
}

async function appendEvent<TEvent>(
  client: PostgresQueryControlPlaneClientLike,
  tenantId: string,
  workspaceId: string,
  runId: string,
  input: ControlPlaneEventInput<TEvent>,
) {
  const occurredAt = instant(input.occurredAt, 'event.occurredAt')
  const eventJson = stringifyJson(input.event, 'event')
  const contentFingerprint = fingerprint({ event: parseJson(eventJson), occurredAt })
  await client.query(`insert into chatbi_run_event_streams (
  tenant_id, workspace_id, run_id, current_sequence, updated_at
) values ($1, $2, $3, 0, $4::timestamptz)
on conflict (tenant_id, workspace_id, run_id) do nothing`, [tenantId, workspaceId, runId, occurredAt])
  const stream = await client.query<EventStreamRow>(`select current_sequence from chatbi_run_event_streams
where tenant_id = $1 and workspace_id = $2 and run_id = $3 for update`, [tenantId, workspaceId, runId])
  const existing = await client.query<EventRow>(`select content_fingerprint from chatbi_run_events
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and idempotency_key = $4`, [
    tenantId, workspaceId, runId, input.eventId,
  ])
  if (existing.rows[0]) {
    if (existing.rows[0].content_fingerprint !== contentFingerprint) throw new Error('run event idempotency conflict')
    return
  }
  const currentSequence = integer(stream.rows[0]?.current_sequence, 'current_sequence')
  const nextSequence = currentSequence + 1
  const advanced = await client.query(`update chatbi_run_event_streams
set current_sequence = $4, updated_at = $5::timestamptz
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and current_sequence = $6`, [
    tenantId, workspaceId, runId, nextSequence, occurredAt, currentSequence,
  ])
  if (advanced.rowCount !== 1) throw new Error('run event sequence CAS failed during locked commit')
  await client.query(`insert into chatbi_run_events (
  tenant_id, workspace_id, run_id, sequence, idempotency_key, content_fingerprint, event_json, occurred_at
) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)`, [
    tenantId, workspaceId, runId, nextSequence, input.eventId, contentFingerprint, eventJson, occurredAt,
  ])
}

async function publishResult<TPage, TMetadata>(
  client: PostgresQueryControlPlaneClientLike,
  publication: ControlPlaneResultPublication<TPage, TMetadata>,
) {
  const manifest = publication.manifest
  for (const page of publication.pages) {
    const payloadJson = stringifyJson(page.payload, 'result page')
    const contentFingerprint = fingerprint({ rowCount: page.rowCount, payload: parseJson(payloadJson) })
    const inserted = await client.query<PageRow>(`insert into chatbi_result_pages (
  tenant_id, workspace_id, run_id, attempt, page_index, checksum,
  content_fingerprint, row_count, payload_json, staged_at
) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::timestamptz)
on conflict (tenant_id, workspace_id, run_id, attempt, page_index) do nothing
returning page_index, checksum, content_fingerprint, row_count`, [
      page.tenantId, page.workspaceId, page.runId, page.attempt, page.pageIndex, page.checksum,
      contentFingerprint, page.rowCount, payloadJson, instant(page.stagedAt, 'page.stagedAt'),
    ])
    const existing = inserted.rows[0] ?? (await client.query<PageRow>(`select page_index, checksum,
  content_fingerprint, row_count from chatbi_result_pages
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and attempt = $4 and page_index = $5`, [
      page.tenantId, page.workspaceId, page.runId, page.attempt, page.pageIndex,
    ])).rows[0]
    if (!existing || existing.checksum !== page.checksum || existing.content_fingerprint !== contentFingerprint) {
      throw new Error('result page checksum conflict during atomic publication')
    }
  }
  const pages = await client.query<PageRow>(`select page_index, checksum, content_fingerprint, row_count
from chatbi_result_pages
where tenant_id = $1 and workspace_id = $2 and run_id = $3 and attempt = $4
order by page_index asc for share`, [manifest.tenantId, manifest.workspaceId, manifest.runId, manifest.attempt])
  if (pages.rows.length !== manifest.pageChecksums.length) throw new Error('missing result page during atomic publication')
  let totalRows = 0
  pages.rows.forEach((page, index) => {
    if (integer(page.page_index, 'page_index') !== index || page.checksum !== manifest.pageChecksums[index]) {
      throw new Error('result page checksum mismatch during atomic publication')
    }
    totalRows += integer(page.row_count, 'row_count')
  })
  if (totalRows !== manifest.totalRows) throw new Error('result row count mismatch during atomic publication')

  const metadataJson = stringifyJson(manifest.metadata, 'manifest.metadata')
  const contentFingerprint = fingerprint({
    attempt: manifest.attempt,
    resultId: manifest.resultId,
    pageChecksums: manifest.pageChecksums,
    totalRows: manifest.totalRows,
    metadata: parseJson(metadataJson),
  })
  const inserted = await client.query<ManifestRow>(`insert into chatbi_result_manifests (
  tenant_id, workspace_id, run_id, attempt, result_id, manifest_checksum,
  content_fingerprint, page_checksums, page_count, total_rows, metadata_json, published_at
) values ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11::jsonb, $12::timestamptz)
on conflict (tenant_id, workspace_id, run_id) do nothing
returning manifest_checksum, content_fingerprint`, [
    manifest.tenantId, manifest.workspaceId, manifest.runId, manifest.attempt, manifest.resultId,
    manifest.manifestChecksum, contentFingerprint, manifest.pageChecksums, manifest.pageChecksums.length,
    manifest.totalRows, metadataJson, instant(manifest.publishedAt, 'manifest.publishedAt'),
  ])
  if (!inserted.rowCount) {
    const existing = await client.query<ManifestRow>(`select manifest_checksum, content_fingerprint
from chatbi_result_manifests where tenant_id = $1 and workspace_id = $2 and run_id = $3`, [
      manifest.tenantId, manifest.workspaceId, manifest.runId,
    ])
    if (!existing.rows[0]
      || existing.rows[0].manifest_checksum !== manifest.manifestChecksum
      || existing.rows[0].content_fingerprint !== contentFingerprint) {
      throw new Error('result manifest conflict during atomic publication')
    }
  }
}

function auditSuffixMatches(existing: AuditEvent[], next: AuditEvent[], suffix: AuditEvent[]) {
  if (next.length !== existing.length + suffix.length) return false
  return existing.every((audit, index) => stableStringify(audit) === stableStringify(next[index]))
    && suffix.every((audit, index) => stableStringify(audit) === stableStringify(next[existing.length + index]))
}

function immutableRunIdentityMatches(current: StoredRunRecord, next: StoredRunRecord) {
  return current.requestId === next.requestId
    && current.traceId === next.traceId
    && stableStringify({
      id: current.run.id,
      tenantId: current.run.tenantId,
      workspaceId: current.run.workspaceId,
      conversationId: current.run.conversationId,
      question: current.run.question,
      mode: current.run.mode,
      semanticVersion: current.run.semanticVersion,
      createdAt: current.run.createdAt,
    }) === stableStringify({
      id: next.run.id,
      tenantId: next.run.tenantId,
      workspaceId: next.run.workspaceId,
      conversationId: next.run.conversationId,
      question: next.run.question,
      mode: next.run.mode,
      semanticVersion: next.run.semanticVersion,
      createdAt: next.run.createdAt,
    })
}

function immutableConversationIdentityMatches(current: Conversation, next: Conversation) {
  const identity = (conversation: Conversation) => ({
    id: conversation.id,
    tenantId: conversation.tenantId,
    workspaceId: conversation.workspaceId,
    title: conversation.title,
    businessDomainId: conversation.businessDomainId,
    mode: conversation.mode,
    semanticVersion: conversation.semanticVersion,
    state: conversation.state,
    createdBy: conversation.createdBy,
    createdAt: conversation.createdAt,
  })
  return stableStringify(identity(current)) === stableStringify(identity(next))
}

async function requiredJob<TPayload, TResult>(client: PostgresQueryControlPlaneClientLike, runId: string) {
  const job = await loadJob<TPayload, TResult>(client, runId)
  if (!job) throw new Error('run job disappeared during atomic commit')
  return job
}

async function loadJob<TPayload, TResult>(client: PostgresQueryControlPlaneClientLike, runId: string) {
  const jobs = await client.query<JobRow>('select * from chatbi_run_jobs where run_id = $1', [runId])
  const row = jobs.rows[0]
  if (!row) return undefined
  const attempts = await client.query<AttemptRow>(`select attempt, fence, worker_id, started_at, lease_expires_at,
  ended_at, outcome, failure_json
from chatbi_run_job_attempts where run_id = $1 order by attempt asc`, [runId])
  const view: RunJobView<TPayload, TResult> = {
    runId: row.run_id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    payloadFingerprint: row.payload_fingerprint,
    payload: parseJson<TPayload>(row.payload_json),
    status: row.status,
    attempt: integer(row.attempt, 'attempt'),
    maxAttempts: integer(row.max_attempts, 'max_attempts'),
    fence: integer(row.fence, 'fence'),
    enqueuedAt: iso(row.enqueued_at),
    availableAt: iso(row.available_at),
    attempts: attempts.rows.map(mapAttempt),
  }
  if (row.lease_owner) view.leaseOwner = row.lease_owner
  assignIso(view, 'leaseExpiresAt', row.lease_expires_at)
  assignIso(view, 'cancelRequestedAt', row.cancel_requested_at)
  assignIso(view, 'completedAt', row.completed_at)
  assignIso(view, 'failedAt', row.failed_at)
  assignIso(view, 'cancelledAt', row.cancelled_at)
  if (row.last_failure_json !== null) view.lastFailure = parseJson<RunJobFailure>(row.last_failure_json)
  if (row.result_fingerprint) {
    view.resultFingerprint = row.result_fingerprint
    view.result = parseJson<TResult>(row.result_json)
  }
  return view
}

function mapAttempt(row: AttemptRow): RunJobAttemptView {
  const attempt: RunJobAttemptView = {
    attempt: integer(row.attempt, 'attempt'),
    fence: integer(row.fence, 'fence'),
    workerId: row.worker_id,
    startedAt: iso(row.started_at),
    leaseExpiresAt: iso(row.lease_expires_at),
  }
  if (row.ended_at) attempt.endedAt = iso(row.ended_at)
  if (row.outcome) attempt.outcome = row.outcome
  if (row.failure_json !== null) attempt.failure = parseJson<RunJobFailure>(row.failure_json)
  return attempt
}

export function createPostgresQueryControlPlane<
  TPayload = unknown,
  TResult = unknown,
  TEvent = unknown,
  TPage = unknown,
  TMetadata = unknown,
>(
  options: PostgresQueryControlPlaneOptions,
): PostgresQueryControlPlane<TPayload, TResult, TEvent, TPage, TMetadata> {
  async function getConversation(input: ControlPlaneConversationKey) {
    validateConversationKey(input)
    const result = await options.pool.query<ConversationRow>(`select conversation_id, tenant_id, workspace_id,
  business_domain_id, active_run_id, payload_json
from chatbi_query_conversations
where tenant_id = $1 and workspace_id = $2 and conversation_id = $3`, [
      input.tenantId,
      input.workspaceId,
      input.conversationId,
    ])
    return result.rows[0] ? parseJson<Conversation>(result.rows[0].payload_json) : undefined
  }

  async function getRun(input: ControlPlaneRunKey) {
    validateRunKey(input)
    const result = await options.pool.query<RunRow>(`select run_id, tenant_id, workspace_id, conversation_id,
  request_fingerprint, stored_record_json
from chatbi_query_runs
where tenant_id = $1 and workspace_id = $2 and run_id = $3`, [
      input.tenantId,
      input.workspaceId,
      input.runId,
    ])
    return result.rows[0] ? parseJson<StoredRunRecord>(result.rows[0].stored_record_json) : undefined
  }

  async function getRunByIdempotency(
    input: ControlPlaneIdempotencyLookup,
  ): Promise<ControlPlaneIdempotencyLookupResult> {
    validateIdempotencyLookup(input)
    const idempotency = await options.pool.query<IdempotencyRow>(`select request_fingerprint, run_id
from chatbi_query_idempotency
where tenant_id = $1 and workspace_id = $2 and conversation_id = $3 and idempotency_key = $4`, [
      input.tenantId,
      input.workspaceId,
      input.conversationId,
      input.idempotencyKey,
    ])
    const row = idempotency.rows[0]
    if (!row) return { status: 'not_found' }
    if (row.request_fingerprint !== input.requestFingerprint) {
      return { status: 'conflict', existingRunId: row.run_id }
    }
    const runRecord = await getRun({ ...input, runId: row.run_id })
    if (!runRecord) throw new Error('idempotency record refers to a missing scoped run')
    return { status: 'match', runRecord }
  }

  async function submitAndEnqueue(input: SubmitAndEnqueueInput<TPayload>): Promise<SubmitAndEnqueueResult> {
    validateSubmission(input)
    const run = input.runRecord.run
    const tenantId = run.tenantId
    const workspaceId = run.workspaceId
    const conversationId = run.conversationId
    const activeConversation: Conversation = clone({
      ...input.conversation,
      activeRunId: isRunActive(run) ? run.id : undefined,
      updatedAt: run.updatedAt,
    })

    try {
      return await transaction(options.pool, async (client) => {
        const reserved = await client.query<IdempotencyRow>(`insert into chatbi_query_idempotency (
  tenant_id, workspace_id, conversation_id, idempotency_key,
  request_fingerprint, run_id, created_at
) values ($1, $2, $3, $4, $5, $6, $7::timestamptz)
on conflict (tenant_id, workspace_id, conversation_id, idempotency_key) do nothing
returning request_fingerprint, run_id`, [
          tenantId,
          workspaceId,
          conversationId,
          input.idempotencyKey,
          input.requestFingerprint,
          run.id,
          instant(input.job?.enqueuedAt ?? run.createdAt, input.job ? 'job.enqueuedAt' : 'run.createdAt'),
        ])

        if (!reserved.rowCount) {
          const existing = await client.query<IdempotencyRow>(`select request_fingerprint, run_id
from chatbi_query_idempotency
where tenant_id = $1 and workspace_id = $2 and conversation_id = $3 and idempotency_key = $4
for update`, [tenantId, workspaceId, conversationId, input.idempotencyKey])
          const idempotency = existing.rows[0]
          if (!idempotency) throw new Error('idempotency reservation disappeared during submission')
          if (idempotency.request_fingerprint !== input.requestFingerprint) {
            conflict('idempotency_conflict', { existingRunId: idempotency.run_id })
          }
          return await loadExistingSubmission(client, tenantId, workspaceId, conversationId, idempotency.run_id)
        }

        await client.query(`insert into chatbi_query_conversations (
  conversation_id, tenant_id, workspace_id, business_domain_id, active_run_id,
  payload_json, created_at, updated_at
) values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
on conflict (conversation_id) do nothing`, [
          conversationId,
          tenantId,
          workspaceId,
          input.conversation.businessDomainId,
          activeConversation.activeRunId ?? null,
          stringifyJson(activeConversation, 'conversation'),
          instant(input.conversation.createdAt, 'conversation.createdAt'),
          instant(run.updatedAt, 'run.updatedAt'),
        ])

        const lockedConversation = await client.query<ConversationRow>(`select conversation_id, tenant_id,
  workspace_id, business_domain_id, active_run_id, payload_json
from chatbi_query_conversations where conversation_id = $1 for update`, [conversationId])
        const current = lockedConversation.rows[0]
        if (!current) throw new Error('conversation disappeared during submission')
        if (current.tenant_id !== tenantId
          || current.workspace_id !== workspaceId
          || current.business_domain_id !== input.conversation.businessDomainId) {
          conflict('conversation_scope_conflict')
        }
        if (current.active_run_id && current.active_run_id !== run.id) {
          conflict('conversation_active_run_conflict', { activeRunId: current.active_run_id })
        }

        const attached = await client.query<ConversationRow>(`update chatbi_query_conversations
set business_domain_id = $5,
    active_run_id = $4,
    payload_json = $6::jsonb,
    updated_at = $7::timestamptz
where conversation_id = $1
  and tenant_id = $2
  and workspace_id = $3
  and business_domain_id = $5
  and (active_run_id is null or active_run_id = $8)
returning conversation_id, tenant_id, workspace_id, business_domain_id, active_run_id, payload_json`, [
          conversationId,
          tenantId,
          workspaceId,
          activeConversation.activeRunId ?? null,
          input.conversation.businessDomainId,
          stringifyJson(activeConversation, 'conversation'),
          instant(run.updatedAt, 'run.updatedAt'),
          run.id,
        ])
        if (!attached.rowCount) conflict('conversation_active_run_conflict')

        const insertedRun = await client.query<RunRow>(`insert into chatbi_query_runs (
  run_id, tenant_id, workspace_id, conversation_id, request_fingerprint,
  display_status, internal_status, request_id, trace_id, stored_record_json,
  created_at, updated_at
) values (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb,
  $11::timestamptz, $12::timestamptz
) on conflict (run_id) do nothing
returning run_id, tenant_id, workspace_id, conversation_id, request_fingerprint, stored_record_json`, [
          run.id,
          tenantId,
          workspaceId,
          conversationId,
          input.requestFingerprint,
          run.displayStatus,
          run.internalStatus,
          input.runRecord.requestId,
          input.runRecord.traceId,
          stringifyJson(input.runRecord, 'runRecord'),
          instant(run.createdAt, 'run.createdAt'),
          instant(run.updatedAt, 'run.updatedAt'),
        ])
        if (!insertedRun.rowCount) {
          const collision = await client.query<RunRow>(`select run_id, tenant_id, workspace_id, conversation_id,
  request_fingerprint, stored_record_json
from chatbi_query_runs where run_id = $1 for update`, [run.id])
          conflict('run_identity_conflict', { existingRunId: collision.rows[0]?.run_id ?? run.id })
        }

        for (const event of input.runRecord.audit) {
          await client.query(`insert into chatbi_query_audit_events (
  tenant_id, workspace_id, run_id, event_id, event_type, actor_user_id,
  occurred_at, payload_json
) values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)`, [
            tenantId,
            workspaceId,
            run.id,
            event.id,
            event.type,
            event.actorUserId,
            instant(event.at, 'audit.at'),
            stringifyJson(event, 'audit event'),
          ])
        }

        if (input.job) {
          const maxAttempts = input.job.maxAttempts ?? 3
          const availableAt = input.job.availableAt ?? input.job.enqueuedAt
          const insertedJob = await client.query(`insert into chatbi_run_jobs (
  run_id, tenant_id, workspace_id, payload_fingerprint, payload_json, status,
  attempt, max_attempts, fence, enqueued_at, available_at, created_at, updated_at
) values (
  $1, $2, $3, $4, $5::jsonb, 'queued', 0, $6, 0,
  $7::timestamptz, $8::timestamptz, $7::timestamptz, $7::timestamptz
) on conflict (run_id) do nothing
returning run_id`, [
            run.id,
            tenantId,
            workspaceId,
            input.job.payloadFingerprint,
            stringifyJson(input.job.payload, 'job.payload'),
            maxAttempts,
            instant(input.job.enqueuedAt, 'job.enqueuedAt'),
            instant(availableAt, 'job.availableAt'),
          ])
          if (!insertedJob.rowCount) conflict('run_identity_conflict', { existingRunId: run.id })
        }

        return {
          ok: true,
          created: true,
          conversation: clone(activeConversation),
          runRecord: clone(input.runRecord),
        }
      })
    } catch (error) {
      if (error instanceof SubmissionConflict) return error.result
      throw error
    }
  }

  async function cancelRun(input: CancelControlPlaneRunInput<TEvent>): Promise<CancelControlPlaneRunResult> {
    validateCancel(input)
    const cancelledAt = instant(input.cancelledAt, 'cancelledAt')
    return await transaction(options.pool, async (client) => {
      const job = await lockJob(client, input.runId)
      const storedRow = await lockStoredRun(client, input.runId)
      if (!storedRow) return { ok: false, reason: 'not_found' }
      if (storedRow.tenant_id !== input.tenantId
        || storedRow.workspace_id !== input.workspaceId
        || storedRow.conversation_id !== input.conversationId) {
        return { ok: false, reason: 'scope_conflict' }
      }
      const stored = parseJson<StoredRunRecord>(storedRow.stored_record_json)
      if (stored.run.id !== input.runId
        || stored.run.tenantId !== input.tenantId
        || stored.run.workspaceId !== input.workspaceId
        || stored.run.conversationId !== input.conversationId) {
        return { ok: false, reason: 'scope_conflict' }
      }
      const conversationRow = await lockConversation(client, input.conversationId)
      if (!conversationRow) return { ok: false, reason: 'invalid_state' }
      if (conversationRow.tenant_id !== input.tenantId
        || conversationRow.workspace_id !== input.workspaceId
        || conversationRow.business_domain_id !== input.actor.businessDomainId) {
        return { ok: false, reason: 'scope_conflict' }
      }
      if (stored.run.internalStatus === 'cancelled' && stored.run.terminationReason === 'cancelled_by_user') {
        return {
          ok: true,
          applied: false,
          conversation: parseJson<Conversation>(conversationRow.payload_json),
          runRecord: stored,
        }
      }
      if (job && (job.status === 'completed' || job.status === 'failed')) {
        return { ok: false, reason: 'terminal_conflict' }
      }
      if (job && (job.tenant_id !== input.tenantId || job.workspace_id !== input.workspaceId)) {
        return { ok: false, reason: 'scope_conflict' }
      }
      if (!isRunActive(stored.run) || conversationRow.active_run_id !== input.runId) {
        return { ok: false, reason: 'terminal_conflict' }
      }
      if (!job && stored.run.displayStatus === 'querying') return { ok: false, reason: 'invalid_state' }

      const cancelledRun = transitionRun(stored.run, { type: 'CANCELLED', at: cancelledAt })
      const audit: AuditEvent = {
        id: `audit_cancel_${input.event.eventId}`,
        at: cancelledAt,
        type: 'query.cancelled',
        actorUserId: input.actor.userId,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        summary: '用户已取消查询，执行租约与结果发布权限同时失效。',
      }
      const runRecord: StoredRunRecord = { ...stored, run: cancelledRun, audit: [...stored.audit, audit] }
      const conversation: Conversation = {
        ...parseJson<Conversation>(conversationRow.payload_json),
        activeRunId: undefined,
        updatedAt: cancelledAt,
      }

      if (job?.status === 'leased') {
        await closeAttempt(client, input.runId, integer(job.attempt, 'attempt'), cancelledAt, 'cancelled')
      }
      if (job && job.status !== 'cancelled') {
        await client.query(`update chatbi_run_jobs
set status = 'cancelled',
    cancel_requested_at = coalesce(cancel_requested_at, $2::timestamptz),
    cancelled_at = coalesce(cancelled_at, $2::timestamptz),
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    updated_at = $2::timestamptz
where run_id = $1`, [input.runId, cancelledAt])
      }
      await updateStoredRun(client, runRecord)
      await updateConversation(client, conversation, input.actor.businessDomainId)
      await insertAudit(client, audit)
      await appendEvent(client, input.tenantId, input.workspaceId, input.runId, input.event)
      return { ok: true, applied: true, conversation, runRecord }
    })
  }

  async function commitAttempt(
    input: CommitControlPlaneAttemptInput<TResult, TEvent, TPage, TMetadata>,
  ): Promise<RunJobMutationResult<TPayload, TResult>> {
    validateCommit(input)
    const mutation = input.job.input
    const at = mutationAt(input.job)
    const tokenHash = hashToken(mutation.leaseToken)
    const terminal = terminalIdentity(input.job)

    return await transaction(options.pool, async (client) => {
      const job = await lockJob(client, mutation.runId)
      if (matchesTerminal(job, mutation, tokenHash, terminal.kind, terminal.fingerprint)) {
        return { ok: true, applied: false, job: await requiredJob<TPayload, TResult>(client, mutation.runId) }
      }
      const invalid = await mutationFailure<TPayload, TResult>(client, job, mutation, at)
      if (invalid) return invalid
      if (input.job.type === 'retry') {
        if (!input.job.input.failure.retryable) {
          return { ok: false, reason: 'failure_not_retryable', job: await requiredJob<TPayload, TResult>(client, mutation.runId) }
        }
        if (integer(job!.attempt, 'attempt') >= integer(job!.max_attempts, 'max_attempts')) {
          return { ok: false, reason: 'attempts_exhausted', job: await requiredJob<TPayload, TResult>(client, mutation.runId) }
        }
      }

      const storedRow = await lockStoredRun(client, mutation.runId)
      if (!storedRow) return { ok: false, reason: 'not_found' }
      if (storedRow.tenant_id !== job!.tenant_id || storedRow.workspace_id !== job!.workspace_id) {
        return { ok: false, reason: 'invalid_state' }
      }
      const currentStored = parseJson<StoredRunRecord>(storedRow.stored_record_json)
      const conversationRow = await lockConversation(client, storedRow.conversation_id)
      const currentConversation = conversationRow
        ? parseJson<Conversation>(conversationRow.payload_json)
        : undefined
      if (!conversationRow
        || conversationRow.tenant_id !== job!.tenant_id
        || conversationRow.workspace_id !== job!.workspace_id
        || conversationRow.active_run_id !== mutation.runId
        || conversationRow.business_domain_id !== input.conversation.businessDomainId
        || input.runRecord.run.tenantId !== job!.tenant_id
        || input.runRecord.run.workspaceId !== job!.workspace_id
        || input.runRecord.run.conversationId !== storedRow.conversation_id
        || currentStored.run.displayStatus !== 'querying'
        || !immutableRunIdentityMatches(currentStored, input.runRecord)
        || !currentConversation
        || !immutableConversationIdentityMatches(currentConversation, input.conversation)) {
        return { ok: false, reason: 'invalid_state' }
      }
      if (!auditSuffixMatches(currentStored.audit, input.runRecord.audit, input.newAuditEvents)) {
        return { ok: false, reason: 'invalid_state' }
      }

      if (input.resultPublication) await publishResult(client, input.resultPublication)
      await applyJobMutation(client, input.job, tokenHash)
      await updateStoredRun(client, input.runRecord)
      await updateConversation(client, input.conversation, conversationRow.business_domain_id)
      for (const audit of input.newAuditEvents) await insertAudit(client, audit)
      await appendEvent(client, job!.tenant_id, job!.workspace_id, mutation.runId, input.event)
      return { ok: true, applied: true, job: await requiredJob<TPayload, TResult>(client, mutation.runId) }
    })
  }

  return {
    getConversation,
    getRun,
    getRunByIdempotency,
    submitAndEnqueue,
    cancelRun,
    commitAttempt,
    async readiness() {
      try {
        await options.pool.query('select 1 as ready')
        return { ok: true as const }
      } catch {
        const error = new Error('PostgreSQL query control plane unavailable') as Error & { code?: string; retryable?: boolean }
        error.code = 'CONTROL_PLANE_UNAVAILABLE'
        error.retryable = true
        throw error
      }
    },
    async close() {
      if (options.closePool) await options.pool.end?.()
    },
  }
}

async function loadExistingSubmission(
  client: PostgresQueryControlPlaneClientLike,
  tenantId: string,
  workspaceId: string,
  conversationId: string,
  runId: string,
): Promise<SubmitAndEnqueueResult> {
  const runs = await client.query<RunRow>(`select run_id, tenant_id, workspace_id, conversation_id,
  request_fingerprint, stored_record_json
from chatbi_query_runs
where tenant_id = $1 and workspace_id = $2 and conversation_id = $3 and run_id = $4`, [
    tenantId,
    workspaceId,
    conversationId,
    runId,
  ])
  const conversations = await client.query<ConversationRow>(`select conversation_id, tenant_id, workspace_id,
  business_domain_id, active_run_id, payload_json
from chatbi_query_conversations
where tenant_id = $1 and workspace_id = $2 and conversation_id = $3`, [
    tenantId,
    workspaceId,
    conversationId,
  ])
  if (!runs.rows[0] || !conversations.rows[0]) {
    throw new Error('idempotent submission is missing its durable run or conversation')
  }
  return {
    ok: true,
    created: false,
    conversation: parseJson<Conversation>(conversations.rows[0].payload_json),
    runRecord: parseJson<StoredRunRecord>(runs.rows[0].stored_record_json),
  }
}

async function transaction<T>(
  pool: PostgresQueryControlPlanePoolLike,
  work: (client: PostgresQueryControlPlaneClientLike) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let transactionStarted = false
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    transactionStarted = true
    const result = await work(client)
    await client.query('COMMIT')
    transactionStarted = false
    return result
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK')
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error('rollback failed')
      }
    }
    throw error
  } finally {
    client.release(releaseError)
  }
}

function validateSubmission<TPayload>(input: SubmitAndEnqueueInput<TPayload>) {
  nonEmpty(input.idempotencyKey, 'idempotencyKey')
  nonEmpty(input.requestFingerprint, 'requestFingerprint')
  const run = input.runRecord.run
  nonEmpty(run.id, 'run.id')
  nonEmpty(run.tenantId, 'run.tenantId')
  nonEmpty(run.workspaceId, 'run.workspaceId')
  nonEmpty(run.conversationId, 'run.conversationId')
  if (input.conversation.id !== run.conversationId
    || input.conversation.tenantId !== run.tenantId
    || input.conversation.workspaceId !== run.workspaceId
    || (input.job && input.job.runId !== run.id)
    || (input.job && input.job.tenantId !== run.tenantId)
    || (input.job && input.job.workspaceId !== run.workspaceId)) {
    throw new Error('conversation, run and job must share one tenant/workspace/run boundary')
  }
  if (input.conversation.activeRunId && input.conversation.activeRunId !== run.id) {
    throw new Error('input conversation has a different active run')
  }
  if (run.displayStatus === 'querying' && !input.job) throw new Error('a querying run requires a job')
  if (run.displayStatus !== 'querying' && input.job) throw new Error('only a querying run may enqueue a job')
  if (input.job) {
    nonEmpty(input.job.payloadFingerprint, 'job.payloadFingerprint')
    const maxAttempts = input.job.maxAttempts ?? 3
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('job.maxAttempts must be a positive integer')
  }
  for (const event of input.runRecord.audit) {
    if (event.runId !== run.id || event.tenantId !== run.tenantId || event.workspaceId !== run.workspaceId) {
      throw new Error('audit event is outside the submitted run boundary')
    }
  }
}

function validateConversationKey(input: ControlPlaneConversationKey) {
  nonEmpty(input.tenantId, 'tenantId')
  nonEmpty(input.workspaceId, 'workspaceId')
  nonEmpty(input.conversationId, 'conversationId')
}

function validateRunKey(input: ControlPlaneRunKey) {
  nonEmpty(input.tenantId, 'tenantId')
  nonEmpty(input.workspaceId, 'workspaceId')
  nonEmpty(input.runId, 'runId')
}

function validateIdempotencyLookup(input: ControlPlaneIdempotencyLookup) {
  validateConversationKey(input)
  nonEmpty(input.idempotencyKey, 'idempotencyKey')
  nonEmpty(input.requestFingerprint, 'requestFingerprint')
}

function conflict(
  reason: SubmitAndEnqueueConflictReason,
  details: { existingRunId?: string; activeRunId?: string } = {},
): never {
  throw new SubmissionConflict({ ok: false, reason, ...details })
}

function stringifyJson(value: unknown, name: string) {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error(`${name} must be JSON serializable`)
  return json
}

function parseJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : structuredClone(value)) as T
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function instant(value: string, name: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid ISO instant`)
  return new Date(value).toISOString()
}

function nonEmpty(value: string, name: string) {
  if (!value.trim()) throw new Error(`${name} cannot be empty`)
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
}

function integer(value: unknown, name: string) {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is missing`)
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${name} is not a safe non-negative integer`)
  return number
}

function iso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('database returned an invalid timestamp')
  return date.toISOString()
}

function assignIso<T extends object, K extends keyof T>(target: T, key: K, value: string | Date | null) {
  if (value !== null) target[key] = iso(value) as T[K]
}

function hashToken(token: string) {
  nonEmpty(token, 'leaseToken')
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function failureFingerprint(failure: RunJobFailure) {
  return [failure.code, failure.message, String(failure.retryable), failure.debugReference ?? ''].join(':')
}

function fingerprint(value: unknown) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
