import type { RunDisplayStatus, RunInternalStatus } from '../domain'
import type { MaybePromise, RunJobStatus } from './jobPorts'

export type QueryReconciliationIssueCode =
  | 'scope_mismatch'
  | 'missing_conversation'
  | 'terminal_run_active_conversation'
  | 'terminal_run_active_job'
  | 'terminal_run_unexpired_lease'
  | 'completed_run_missing_result'
  | 'completed_run_missing_manifest'
  | 'completed_run_manifest_mismatch'
  | 'manifest_for_non_completed_run'
  | 'active_run_conversation_mismatch'
  | 'active_run_missing_job'
  | 'terminal_job_active_run'

export type QueryReconciliationRepair = 'release_conversation' | 'fence_job'

export interface QueryReconciliationSnapshot {
  tenantId: string
  workspaceId: string
  runId: string
  conversationId: string
  runDisplayStatus: RunDisplayStatus
  runInternalStatus: RunInternalStatus
  runResultId?: string
  conversationExists: boolean
  conversationActiveRunId?: string
  scopeConsistent: boolean
  job?: {
    status: RunJobStatus
    attempt: number
    fence: number
    leaseExpiresAt?: string
  }
  manifest?: {
    attempt: number
    resultId: string
  }
}

export interface PlannedQueryReconciliationFinding {
  code: QueryReconciliationIssueCode
  severity: 'warning' | 'critical'
  repair?: QueryReconciliationRepair
}

export interface QueryReconciliationFinding extends PlannedQueryReconciliationFinding {
  tenantId: string
  workspaceId: string
  runId: string
  /** Stable for the same observed fenced state so monitoring can deduplicate alerts. */
  findingId: string
  disposition: 'repaired' | 'alerted'
}

export interface ReconcileQueryBatchInput {
  now: string
  limit: number
}

export interface QueryReconciliationBatchReport {
  scanned: number
  repaired: number
  alerted: number
  findings: QueryReconciliationFinding[]
}

export interface DurableQueryReconciler {
  reconcileBatch(input: ReconcileQueryBatchInput): MaybePromise<QueryReconciliationBatchReport>
}

/**
 * Browser-safe policy: only fence work or release a terminal Conversation.
 * A manifest is evidence, never material to synthesize; missing or mismatched
 * results are therefore always alerts and never publication instructions.
 */
export function planQueryReconciliation(
  snapshot: QueryReconciliationSnapshot,
  now: string,
): PlannedQueryReconciliationFinding[] {
  instant(now, 'now')
  if (!snapshot.conversationExists) {
    return [{ code: 'missing_conversation', severity: 'critical' }]
  }
  if (!snapshot.scopeConsistent) {
    return [{ code: 'scope_mismatch', severity: 'critical' }]
  }

  const findings: PlannedQueryReconciliationFinding[] = []
  const runActive = snapshot.runDisplayStatus === 'understanding'
    || snapshot.runDisplayStatus === 'querying'
    || snapshot.runDisplayStatus === 'needs_clarification'
  const runTerminal = snapshot.runDisplayStatus === 'completed'
    || snapshot.runDisplayStatus === 'failed'
    || snapshot.runInternalStatus === 'cancelled'
  const jobActive = snapshot.job?.status === 'queued'
    || snapshot.job?.status === 'retry_wait'
    || snapshot.job?.status === 'leased'
  const jobTerminal = snapshot.job?.status === 'completed'
    || snapshot.job?.status === 'failed'
    || snapshot.job?.status === 'cancelled'

  if (runTerminal && snapshot.conversationActiveRunId === snapshot.runId) {
    findings.push({
      code: 'terminal_run_active_conversation',
      severity: 'warning',
      repair: 'release_conversation',
    })
  }
  if (runTerminal && jobActive) {
    const unexpiredLease = snapshot.job?.status === 'leased'
      && snapshot.job.leaseExpiresAt !== undefined
      && Date.parse(snapshot.job.leaseExpiresAt) > Date.parse(now)
    findings.push(unexpiredLease
      ? { code: 'terminal_run_unexpired_lease', severity: 'critical' }
      : { code: 'terminal_run_active_job', severity: 'critical', repair: 'fence_job' })
  }

  if (snapshot.runDisplayStatus === 'completed') {
    if (!snapshot.runResultId) {
      findings.push({ code: 'completed_run_missing_result', severity: 'critical' })
    } else if (!snapshot.manifest) {
      findings.push({ code: 'completed_run_missing_manifest', severity: 'critical' })
    } else if (snapshot.manifest.resultId !== snapshot.runResultId
      || (snapshot.job?.status === 'completed' && snapshot.manifest.attempt !== snapshot.job.attempt)) {
      findings.push({ code: 'completed_run_manifest_mismatch', severity: 'critical' })
    }
  } else if (snapshot.manifest) {
    findings.push({ code: 'manifest_for_non_completed_run', severity: 'critical' })
  }

  if (runActive) {
    if (snapshot.conversationActiveRunId !== snapshot.runId) {
      findings.push({ code: 'active_run_conversation_mismatch', severity: 'critical' })
    }
    if (!snapshot.job && snapshot.runDisplayStatus === 'querying') {
      findings.push({ code: 'active_run_missing_job', severity: 'critical' })
    } else if (jobTerminal) {
      findings.push({ code: 'terminal_job_active_run', severity: 'critical' })
    }
  }
  return findings
}

export function reconciliationFindingId(
  snapshot: QueryReconciliationSnapshot,
  code: QueryReconciliationIssueCode,
): Promise<string> {
  return sha256(reconciliationFindingIdentity(snapshot, code))
    .then((digest) => `qrf:v2:sha256:${digest}`)
}

/**
 * Canonical, unambiguous identity persisted beside the digest. JSON string
 * escaping and fixed tuple positions prevent arbitrary scoped IDs (including
 * IDs containing `:`) from crossing field boundaries.
 */
export function reconciliationFindingIdentity(
  snapshot: QueryReconciliationSnapshot,
  code: QueryReconciliationIssueCode,
): string {
  return JSON.stringify([
    'query_reconciliation_identity.v2',
    snapshot.tenantId,
    snapshot.workspaceId,
    snapshot.runId,
    snapshot.conversationId,
    code,
    snapshot.runDisplayStatus,
    snapshot.runInternalStatus,
    snapshot.job
      ? [snapshot.job.status, snapshot.job.attempt, snapshot.job.fence]
      : null,
    snapshot.manifest
      ? [snapshot.manifest.attempt, snapshot.manifest.resultId]
      : null,
  ])
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function instant(value: string, name: string) {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a valid ISO instant`)
}
