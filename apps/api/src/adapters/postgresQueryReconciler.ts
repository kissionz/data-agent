import type { RunDisplayStatus, RunInternalStatus } from '../../../../src/domain'
import type { RunJobStatus } from '../../../../src/persistence/jobPorts'
import {
  planQueryReconciliation,
  reconciliationFindingId,
  reconciliationFindingIdentity,
  type DurableQueryReconciler,
  type QueryReconciliationBatchReport,
  type QueryReconciliationFinding,
  type QueryReconciliationSnapshot,
  type ReconcileQueryBatchInput,
} from '../../../../src/persistence/queryReconcilerPorts'

interface PgResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface PostgresQueryReconcilerClientLike {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresQueryReconcilerPoolLike {
  connect(): Promise<PostgresQueryReconcilerClientLike>
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<Row>>
}

export interface PostgresQueryReconcilerOptions {
  pool: PostgresQueryReconcilerPoolLike
  maxBatchSize?: number
}

interface CandidateIdRow { run_id: string }
interface BoundaryIdentityRow { conversation_id: string; job_exists: boolean }

interface SnapshotRow {
  run_id: string
  run_tenant_id: string
  run_workspace_id: string
  conversation_id: string
  display_status: string
  internal_status: string
  run_result_id: string | null
  conversation_tenant_id: string | null
  conversation_workspace_id: string | null
  active_run_id: string | null
  job_tenant_id: string | null
  job_workspace_id: string | null
  job_status: string | null
  job_attempt: number | string | null
  job_fence: number | string | null
  lease_expires_at: string | Date | null
  manifest_attempt: number | string | null
  manifest_result_id: string | null
}

const ACTIVE_JOB_STATUSES = ['queued', 'leased', 'retry_wait'] as const

/**
 * Bounded production reconciler for states that should normally be impossible
 * after the atomic control-plane commit. It never inserts or updates result
 * pages/manifests and never promotes a Run from result-shaped data alone.
 */
export function createPostgresQueryReconciler(
  options: PostgresQueryReconcilerOptions,
): DurableQueryReconciler {
  const maxBatchSize = options.maxBatchSize ?? 100
  positiveInteger(maxBatchSize, 'maxBatchSize')
  if (maxBatchSize > 500) throw new Error('maxBatchSize cannot exceed 500')

  return {
    async reconcileBatch(input) {
      validateInput(input, maxBatchSize)
      const candidates = await options.pool.query<CandidateIdRow>(candidateSql, [input.limit])
      const findings: QueryReconciliationFinding[] = []
      for (const candidate of candidates.rows) {
        const fresh = await transaction(options.pool, async (client) => {
          const snapshot = await lockSnapshot(client, candidate.run_id)
          if (!snapshot) return []
          return await applyPlan(client, snapshot, input.now)
        })
        findings.push(...fresh)
      }
      return report(candidates.rows.length, findings)
    },
  }
}

async function applyPlan(
  client: PostgresQueryReconcilerClientLike,
  snapshot: QueryReconciliationSnapshot,
  now: string,
): Promise<QueryReconciliationFinding[]> {
  const planned = planQueryReconciliation(snapshot, now)
  const findings: QueryReconciliationFinding[] = []
  for (const finding of planned) {
    let repaired = false
    if (finding.repair === 'release_conversation') {
      const updated = await client.query(`update chatbi_query_conversations
set active_run_id = null,
    payload_json = jsonb_set(payload_json - 'activeRunId', '{updatedAt}', to_jsonb($4::text), true),
    updated_at = $4::timestamptz
where conversation_id = $1 and tenant_id = $2 and workspace_id = $3 and active_run_id = $5`, [
        snapshot.conversationId,
        snapshot.tenantId,
        snapshot.workspaceId,
        now,
        snapshot.runId,
      ])
      repaired = updated.rowCount === 1
    } else if (finding.repair === 'fence_job' && snapshot.job) {
      const updated = await client.query(`update chatbi_run_jobs
set status = 'cancelled',
    cancel_requested_at = coalesce(cancel_requested_at, $3::timestamptz),
    cancelled_at = coalesce(cancelled_at, $3::timestamptz),
    lease_owner = null, lease_token_hash = null, lease_expires_at = null,
    updated_at = $3::timestamptz
where run_id = $1 and fence = $2 and status = any($4::text[]) and attempt = $5
  and (status <> 'leased' or lease_expires_at <= $3::timestamptz)`, [
        snapshot.runId,
        snapshot.job.fence,
        now,
        ACTIVE_JOB_STATUSES,
        snapshot.job.attempt,
      ])
      repaired = updated.rowCount === 1
      if (repaired && snapshot.job.status === 'leased') {
        await client.query(`update chatbi_run_job_attempts
set ended_at = $4::timestamptz, outcome = 'cancelled'
where run_id = $1 and attempt = $2 and fence = $3 and ended_at is null`, [
          snapshot.runId,
          snapshot.job.attempt,
          snapshot.job.fence,
          now,
        ])
      }
    }
    const findingId = await reconciliationFindingId(snapshot, finding.code)
    findings.push({
      ...finding,
      tenantId: snapshot.tenantId,
      workspaceId: snapshot.workspaceId,
      runId: snapshot.runId,
      findingId,
      disposition: repaired ? 'repaired' : 'alerted',
    })
    await persistFinding(client, snapshot, findings[findings.length - 1], now)
  }
  return findings
}

async function lockSnapshot(
  client: PostgresQueryReconcilerClientLike,
  runId: string,
): Promise<QueryReconciliationSnapshot | undefined> {
  // Match the transactional control plane's Job -> Run -> Conversation order.
  // The first read is deliberately unlocked and used only to decide which
  // nullable boundary rows must be acquired; all policy reads happen after.
  const identity = await client.query<BoundaryIdentityRow>(`select run.conversation_id,
  exists(select 1 from chatbi_run_jobs job where job.run_id = run.run_id) as job_exists
from chatbi_query_runs run where run.run_id = $1`, [runId])
  const boundary = identity.rows[0]
  if (!boundary) return undefined
  if (boundary.job_exists) {
    const job = await client.query(`select run_id from chatbi_run_jobs
where run_id = $1 for update skip locked`, [runId])
    if (!job.rows[0]) return undefined
  }
  const run = await client.query(`select run_id from chatbi_query_runs
where run_id = $1 for update skip locked`, [runId])
  if (!run.rows[0]) return undefined
  if (!boundary.job_exists) {
    const appeared = await client.query<{ job_exists: boolean }>(`select exists(
  select 1 from chatbi_run_jobs where run_id = $1
) as job_exists`, [runId])
    if (appeared.rows[0]?.job_exists) return undefined
  }
  const conversation = await client.query(`select conversation_id from chatbi_query_conversations
where conversation_id = $1 for update skip locked`, [boundary.conversation_id])
  if (!conversation.rows[0]) {
    const existence = await client.query<{ conversation_exists: boolean }>(`select exists(
  select 1 from chatbi_query_conversations where conversation_id = $1
) as conversation_exists`, [boundary.conversation_id])
    // A concurrent transaction owns the row; do not wait while holding Job and
    // Run locks. A genuinely missing row is still reported below.
    if (existence.rows[0]?.conversation_exists) return undefined
    const missing = await client.query<SnapshotRow>(`${snapshotSelect} where run.run_id = $1`, [runId])
    return missing.rows[0] ? mapSnapshot(missing.rows[0]) : undefined
  }
  const refreshed = await client.query<SnapshotRow>(`${snapshotSelect} where run.run_id = $1`, [runId])
  if (!boundary.job_exists && refreshed.rows[0]?.job_status !== null) return undefined
  return refreshed.rows[0] ? mapSnapshot(refreshed.rows[0]) : undefined
}

function mapSnapshot(row: SnapshotRow): QueryReconciliationSnapshot {
  const conversationExists = row.conversation_tenant_id !== null && row.conversation_workspace_id !== null
  const scopeConsistent = conversationExists
    && row.conversation_tenant_id === row.run_tenant_id
    && row.conversation_workspace_id === row.run_workspace_id
    && (row.job_status === null
      || (row.job_tenant_id === row.run_tenant_id && row.job_workspace_id === row.run_workspace_id))
  const job = row.job_status === null ? undefined : {
    status: jobStatus(row.job_status),
    attempt: integer(row.job_attempt, 'job_attempt'),
    fence: integer(row.job_fence, 'job_fence'),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
  }
  const manifest = row.manifest_result_id === null ? undefined : {
    attempt: integer(row.manifest_attempt, 'manifest_attempt'),
    resultId: row.manifest_result_id,
  }
  return {
    tenantId: row.run_tenant_id,
    workspaceId: row.run_workspace_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    runDisplayStatus: displayStatus(row.display_status),
    runInternalStatus: internalStatus(row.internal_status),
    ...(row.run_result_id ? { runResultId: row.run_result_id } : {}),
    conversationExists,
    ...(row.active_run_id ? { conversationActiveRunId: row.active_run_id } : {}),
    scopeConsistent,
    ...(job ? { job } : {}),
    ...(manifest ? { manifest } : {}),
  }
}

async function persistFinding(
  client: PostgresQueryReconcilerClientLike,
  snapshot: QueryReconciliationSnapshot,
  finding: QueryReconciliationFinding,
  now: string,
) {
  const identityJson = reconciliationFindingIdentity(snapshot, finding.code)
  const evidence = {
    schemaVersion: 'query_reconciliation_finding.v1',
    code: finding.code,
    severity: finding.severity,
    disposition: finding.disposition,
    repair: finding.repair,
    run: {
      displayStatus: snapshot.runDisplayStatus,
      internalStatus: snapshot.runInternalStatus,
      hasResult: snapshot.runResultId !== undefined,
    },
    conversation: {
      exists: snapshot.conversationExists,
      activeRunMatches: snapshot.conversationActiveRunId === snapshot.runId,
    },
    job: snapshot.job ? {
      status: snapshot.job.status,
      attempt: snapshot.job.attempt,
      fence: snapshot.job.fence,
      leaseExpired: snapshot.job.leaseExpiresAt
        ? Date.parse(snapshot.job.leaseExpiresAt) <= Date.parse(now)
        : undefined,
    } : undefined,
    manifest: snapshot.manifest ? {
      present: true,
      attempt: snapshot.manifest.attempt,
      resultMatches: snapshot.manifest.resultId === snapshot.runResultId,
    } : { present: false },
  }
  const persisted = await client.query<{ finding_id: string }>(`insert into chatbi_query_reconciliation_findings (
  finding_id, identity_schema, identity_json,
  tenant_id, workspace_id, run_id, conversation_id,
  issue_code, severity, disposition, repair_action,
  evidence_json, first_seen_at, last_seen_at, occurrence_count, repaired_at
) values (
  $1, 'query_reconciliation_identity.v2', $2::jsonb,
  $3, $4, $5, $6,
  $7, $8, $9, $10,
  $11::jsonb, $12::timestamptz, $12::timestamptz, 1,
  case when $9 = 'repaired' then $12::timestamptz else null end
)
on conflict (finding_id) do update
set last_seen_at = excluded.last_seen_at,
    occurrence_count = chatbi_query_reconciliation_findings.occurrence_count + 1,
    disposition = excluded.disposition,
    repair_action = coalesce(chatbi_query_reconciliation_findings.repair_action, excluded.repair_action),
    repaired_at = coalesce(chatbi_query_reconciliation_findings.repaired_at, excluded.repaired_at),
    evidence_json = excluded.evidence_json
where chatbi_query_reconciliation_findings.identity_schema = excluded.identity_schema
  and chatbi_query_reconciliation_findings.identity_json = excluded.identity_json
  and chatbi_query_reconciliation_findings.tenant_id = excluded.tenant_id
  and chatbi_query_reconciliation_findings.workspace_id = excluded.workspace_id
  and chatbi_query_reconciliation_findings.run_id = excluded.run_id
  and chatbi_query_reconciliation_findings.conversation_id = excluded.conversation_id
  and chatbi_query_reconciliation_findings.issue_code = excluded.issue_code
returning finding_id`, [
    finding.findingId,
    identityJson,
    finding.tenantId,
    finding.workspaceId,
    finding.runId,
    snapshot.conversationId,
    finding.code,
    finding.severity,
    finding.disposition,
    finding.repair ?? null,
    JSON.stringify(evidence),
    now,
  ])
  if (persisted.rowCount !== 1 || persisted.rows[0]?.finding_id !== finding.findingId) {
    throw new Error('query reconciliation finding identity conflict')
  }
}

function report(scanned: number, findings: QueryReconciliationFinding[]): QueryReconciliationBatchReport {
  return {
    scanned,
    repaired: findings.filter((finding) => finding.disposition === 'repaired').length,
    alerted: findings.filter((finding) => finding.disposition === 'alerted').length,
    findings,
  }
}

async function transaction<T>(
  pool: PostgresQueryReconcilerPoolLike,
  work: (client: PostgresQueryReconcilerClientLike) => Promise<T>,
) {
  const client = await pool.connect()
  let started = false
  let releaseError: Error | undefined
  try {
    await client.query('BEGIN')
    started = true
    const value = await work(client)
    await client.query('COMMIT')
    started = false
    return value
  } catch (error) {
    if (started) {
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

const snapshotSelect = `select
  run.run_id,
  run.tenant_id as run_tenant_id,
  run.workspace_id as run_workspace_id,
  run.conversation_id,
  run.display_status,
  run.internal_status,
  run.stored_record_json #>> '{run,result,id}' as run_result_id,
  conversation.tenant_id as conversation_tenant_id,
  conversation.workspace_id as conversation_workspace_id,
  conversation.active_run_id,
  job.tenant_id as job_tenant_id,
  job.workspace_id as job_workspace_id,
  job.status as job_status,
  job.attempt as job_attempt,
  job.fence as job_fence,
  job.lease_expires_at,
  manifest.attempt as manifest_attempt,
  manifest.result_id as manifest_result_id
from chatbi_query_runs run
left join chatbi_query_conversations conversation on conversation.conversation_id = run.conversation_id
left join chatbi_run_jobs job on job.run_id = run.run_id
left join chatbi_result_manifests manifest
  on manifest.tenant_id = run.tenant_id
 and manifest.workspace_id = run.workspace_id
 and manifest.run_id = run.run_id`

const candidateSql = `${snapshotSelect}
where
  (run.display_status in ('completed', 'failed') or run.internal_status = 'cancelled')
  and (conversation.active_run_id = run.run_id or job.status in ('queued', 'leased', 'retry_wait'))
or run.display_status = 'completed'
  and (
    run.stored_record_json #>> '{run,result,id}' is null
    or manifest.run_id is null
    or manifest.result_id <> run.stored_record_json #>> '{run,result,id}'
    or (job.status = 'completed' and manifest.attempt <> job.attempt)
  )
or run.display_status in ('understanding', 'querying', 'needs_clarification')
  and (
    conversation.active_run_id is distinct from run.run_id
    or (run.display_status = 'querying' and job.run_id is null)
    or job.status in ('completed', 'failed', 'cancelled')
    or manifest.run_id is not null
  )
or conversation.conversation_id is null
or conversation.tenant_id <> run.tenant_id
or conversation.workspace_id <> run.workspace_id
or (job.run_id is not null and (job.tenant_id <> run.tenant_id or job.workspace_id <> run.workspace_id))
order by run.updated_at asc, run.run_id asc
limit $1`

function validateInput(input: ReconcileQueryBatchInput, maxBatchSize: number) {
  instant(input.now, 'now')
  positiveInteger(input.limit, 'limit')
  if (input.limit > maxBatchSize) throw new Error(`limit cannot exceed configured maxBatchSize ${maxBatchSize}`)
}

function displayStatus(value: string): RunDisplayStatus {
  if (value === 'waiting_input' || value === 'understanding' || value === 'querying'
    || value === 'needs_clarification' || value === 'completed' || value === 'failed') return value
  throw new Error('database returned an invalid Run display status')
}

function internalStatus(value: string): RunInternalStatus {
  if (value === 'idle' || value === 'planning' || value === 'executing'
    || value === 'awaiting_clarification' || value === 'succeeded' || value === 'failed' || value === 'cancelled') return value
  throw new Error('database returned an invalid Run internal status')
}

function jobStatus(value: string): RunJobStatus {
  if (value === 'queued' || value === 'leased' || value === 'retry_wait'
    || value === 'completed' || value === 'failed' || value === 'cancelled') return value
  throw new Error('database returned an invalid job status')
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
}

function integer(value: number | string | null, name: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative safe integer`)
  return parsed
}

function instant(value: string, name: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid ISO instant`)
}

function iso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('database returned an invalid timestamp')
  return date.toISOString()
}
