import { describe, expect, it } from 'vitest'
import {
  planQueryReconciliation,
  reconciliationFindingId,
  reconciliationFindingIdentity,
  type QueryReconciliationSnapshot,
} from '../persistence/queryReconcilerPorts'

const now = '2026-07-15T12:00:00.000Z'

function snapshot(patch: Partial<QueryReconciliationSnapshot> = {}): QueryReconciliationSnapshot {
  return {
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    runId: 'run_reconcile',
    conversationId: 'conversation_reconcile',
    runDisplayStatus: 'querying',
    runInternalStatus: 'executing',
    conversationExists: true,
    conversationActiveRunId: 'run_reconcile',
    scopeConsistent: true,
    job: { status: 'queued', attempt: 0, fence: 0 },
    ...patch,
  }
}

describe('durable query reconciliation policy', () => {
  it('releases a terminal Conversation and fences only an expired active job', async () => {
    const state = snapshot({
      runDisplayStatus: 'completed',
      runInternalStatus: 'succeeded',
      runResultId: 'result_1',
      job: {
        status: 'leased',
        attempt: 2,
        fence: 4,
        leaseExpiresAt: '2026-07-15T11:59:59.000Z',
      },
      manifest: { attempt: 2, resultId: 'result_1' },
    })

    expect(planQueryReconciliation(state, now)).toEqual([
      {
        code: 'terminal_run_active_conversation',
        severity: 'warning',
        repair: 'release_conversation',
      },
      { code: 'terminal_run_active_job', severity: 'critical', repair: 'fence_job' },
    ])
    await expect(reconciliationFindingId(state, 'terminal_run_active_job'))
      .resolves.toMatch(/^qrf:v2:sha256:[0-9a-f]{64}$/)
  })

  it('hashes canonical JSON so scoped IDs containing colons cannot cross field boundaries', async () => {
    const left = snapshot({ tenantId: 'tenant:a', workspaceId: 'workspace' })
    const right = snapshot({ tenantId: 'tenant', workspaceId: 'a:workspace' })

    expect(reconciliationFindingIdentity(left, 'terminal_run_active_job'))
      .not.toBe(reconciliationFindingIdentity(right, 'terminal_run_active_job'))
    await expect(reconciliationFindingId(left, 'terminal_run_active_job'))
      .resolves.not.toBe(await reconciliationFindingId(right, 'terminal_run_active_job'))
  })

  it('uses the standard SHA-256 digest of the canonical finding identity', async () => {
    const state = snapshot()

    expect(reconciliationFindingIdentity(state, 'terminal_run_active_job')).toBe(
      '["query_reconciliation_identity.v2","tenant_demo","workspace_sales","run_reconcile","conversation_reconcile","terminal_run_active_job","querying","executing",["queued",0,0],null]',
    )
    await expect(reconciliationFindingId(state, 'terminal_run_active_job')).resolves.toBe(
      'qrf:v2:sha256:f1921e5488a4929a42ed05438b01c451e7d24d85590823ce5c6e893fa26da658',
    )
  })

  it('never fences an unexpired lease even when the public Run is terminal', () => {
    const findings = planQueryReconciliation(snapshot({
      runDisplayStatus: 'failed',
      runInternalStatus: 'failed',
      conversationActiveRunId: undefined,
      job: {
        status: 'leased',
        attempt: 1,
        fence: 9,
        leaseExpiresAt: '2026-07-15T12:00:01.000Z',
      },
    }), now)

    expect(findings).toEqual([{ code: 'terminal_run_unexpired_lease', severity: 'critical' }])
  })

  it('alerts for a missing or mismatched manifest and never invents publication work', () => {
    const missing = planQueryReconciliation(snapshot({
      runDisplayStatus: 'completed',
      runInternalStatus: 'succeeded',
      runResultId: 'result_1',
      conversationActiveRunId: undefined,
      job: { status: 'completed', attempt: 1, fence: 1 },
    }), now)
    const mismatch = planQueryReconciliation(snapshot({
      runDisplayStatus: 'completed',
      runInternalStatus: 'succeeded',
      runResultId: 'result_1',
      conversationActiveRunId: undefined,
      job: { status: 'completed', attempt: 2, fence: 2 },
      manifest: { attempt: 1, resultId: 'different_result' },
    }), now)

    expect(missing).toEqual([{ code: 'completed_run_missing_manifest', severity: 'critical' }])
    expect(mismatch).toEqual([{ code: 'completed_run_manifest_mismatch', severity: 'critical' }])
    expect([...missing, ...mismatch].every((finding) => finding.repair === undefined)).toBe(true)
  })

  it('alerts instead of promoting an active Run from a terminal job and manifest', () => {
    const findings = planQueryReconciliation(snapshot({
      job: { status: 'completed', attempt: 1, fence: 1 },
      manifest: { attempt: 1, resultId: 'result_1' },
    }), now)

    expect(findings).toEqual([
      { code: 'manifest_for_non_completed_run', severity: 'critical' },
      { code: 'terminal_job_active_run', severity: 'critical' },
    ])
    expect(findings.every((finding) => finding.repair === undefined)).toBe(true)
  })

  it('suppresses every repair when a tenant/workspace boundary is inconsistent', () => {
    expect(planQueryReconciliation(snapshot({
      runDisplayStatus: 'failed',
      runInternalStatus: 'failed',
      scopeConsistent: false,
    }), now)).toEqual([{ code: 'scope_mismatch', severity: 'critical' }])
  })
})
