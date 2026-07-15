import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { createPostgresQueryControlPlane } from '../../apps/api/src/adapters/postgresQueryControlPlane'
import { createPostgresRunJobQueue } from '../../apps/api/src/adapters/postgresRunJobQueue'
import type {
  CommitControlPlaneAttemptInput,
  SubmitAndEnqueueInput,
} from '../../src/persistence/controlPlanePorts'
import type { RunJobLease } from '../../src/persistence/jobPorts'
import type { RunResult } from '../../src/domain'

interface Payload { runId: string; question: string }

const databaseUrl = process.env.CHATBI_TEST_POSTGRES_ADMIN_URL
  ?? 'postgresql://chatbi_admin:chatbi_admin@127.0.0.1:55432/chatbi_test'
const at = '2026-07-15T10:00:00.000Z'
const at1 = '2026-07-15T10:00:01.000Z'

function makeInput(options: {
  runId: string
  idempotencyKey: string
  requestFingerprint: string
  conversationId?: string
  businessDomainId?: string
  status?: 'querying' | 'failed'
}): SubmitAndEnqueueInput<Payload> {
  const status = options.status ?? 'querying'
  const conversationId = options.conversationId ?? 'conversation_race'
  const businessDomainId = options.businessDomainId ?? 'sales'
  const conversation = {
    id: conversationId,
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    title: '原子提交测试',
    businessDomainId,
    mode: 'trusted' as const,
    semanticVersion: 'sales-v3',
    state: {
      metrics: { value: ['net_revenue'], source: 'user' as const },
      dimensions: { value: [], source: 'system_default' as const },
      filters: { value: {}, source: 'system_default' as const },
      timeRange: { value: 'P12M', source: 'user' as const },
      grain: { value: 'month' as const, source: 'system_default' as const },
      presentation: { value: 'line' as const, source: 'system_default' as const },
      assumptions: [],
    },
    createdBy: 'user_1',
    createdAt: at,
    updatedAt: at,
  }
  const runRecord = {
    run: {
      id: options.runId,
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      conversationId,
      question: '过去 12 个月净收入趋势',
      mode: conversation.mode,
      semanticVersion: conversation.semanticVersion,
      displayStatus: status,
      internalStatus: status === 'querying' ? 'executing' as const : 'failed' as const,
      version: 2,
      createdAt: at,
      updatedAt: at,
    },
    executedQuery: false,
    requestId: `request_${options.runId}`,
    traceId: `trace_${options.runId}`,
    audit: [{
      id: `audit_${options.runId}`,
      at,
      type: 'question.accepted' as const,
      actorUserId: 'user_1',
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      runId: options.runId,
      summary: '问题已接收。',
    }],
  }
  return {
    idempotencyKey: options.idempotencyKey,
    requestFingerprint: options.requestFingerprint,
    conversation,
    runRecord,
    job: status === 'querying' ? {
      runId: options.runId,
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      payloadFingerprint: `payload:${options.requestFingerprint}`,
      payload: { runId: options.runId, question: runRecord.run.question },
      enqueuedAt: at,
      maxAttempts: 3,
    } : undefined,
  }
}

function resultFixture(runId: string): RunResult {
  return {
    id: `result_${runId}`,
    columns: [],
    rows: [],
    chartSpec: {
      id: `chart_${runId}`,
      title: '净收入趋势',
      description: '原子结果',
      type: 'table',
      yAxisColumnIds: [],
      source: 'validated_result_spec',
      safety: { grounded: true, warnings: [] },
    },
    completeness: 'full',
    incompleteSteps: [],
    warnings: [],
    answer: {
      headline: '查询完成', summary: '原子结果', facts: [], semanticVersion: 'sales-v3', generatedFrom: 'query_result',
    },
    freshnessAt: at1,
  }
}

function completeCommit(
  submitted: SubmitAndEnqueueInput<Payload>,
  lease: RunJobLease<Payload>,
  eventId = `event_complete_${submitted.runRecord.run.id}`,
): CommitControlPlaneAttemptInput<{ type: 'executed' }, { type: string }, { rows: unknown[] }, { semanticVersion: string }> {
  const runId = submitted.runRecord.run.id
  const audit = {
    id: `audit_complete_${runId}`,
    at: at1,
    type: 'query.completed' as const,
    actorUserId: 'user_1',
    tenantId: submitted.runRecord.run.tenantId,
    workspaceId: submitted.runRecord.run.workspaceId,
    runId,
    summary: '查询完成。',
  }
  return {
    job: {
      type: 'complete',
      input: {
        runId, attempt: lease.attempt, fence: lease.fence, workerId: lease.workerId, leaseToken: lease.leaseToken,
        completedAt: at1, resultFingerprint: `result:${runId}`, result: { type: 'executed' },
      },
    },
    conversation: { ...submitted.conversation, activeRunId: undefined, updatedAt: at1 },
    runRecord: {
      ...submitted.runRecord,
      executedQuery: true,
      run: {
        ...submitted.runRecord.run,
        displayStatus: 'completed', internalStatus: 'succeeded', result: resultFixture(runId),
        version: submitted.runRecord.run.version + 1, updatedAt: at1,
      },
      audit: [...submitted.runRecord.audit, audit],
    },
    newAuditEvents: [audit],
    event: { eventId, event: { type: 'run.completed' }, occurredAt: at1 },
    resultPublication: {
      pages: [],
      manifest: {
        tenantId: submitted.runRecord.run.tenantId,
        workspaceId: submitted.runRecord.run.workspaceId,
        runId,
        attempt: lease.attempt,
        resultId: `result_${runId}`,
        manifestChecksum: `manifest:${runId}`,
        pageChecksums: [],
        totalRows: 0,
        metadata: { semanticVersion: submitted.runRecord.run.semanticVersion },
        publishedAt: at1,
      },
    },
  }
}

describe('PostgreSQL atomic query control-plane real integration', () => {
  let admin: Pool
  let poolA: Pool
  let poolB: Pool
  let controlPlaneA: ReturnType<typeof createPostgresQueryControlPlane<Payload>>
  let controlPlaneB: ReturnType<typeof createPostgresQueryControlPlane<Payload>>
  let queue: ReturnType<typeof createPostgresRunJobQueue<Payload>>

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 2_000 })
    poolA = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    poolB = new Pool({ connectionString: databaseUrl, max: 4, connectionTimeoutMillis: 2_000 })
    await admin.query(readFileSync(new URL('../../scripts/postgres/control-plane.sql', import.meta.url), 'utf8'))
    await admin.query(readFileSync(new URL('../../scripts/postgres/result-event-store.sql', import.meta.url), 'utf8'))
    await admin.query(readFileSync(new URL('../../scripts/postgres/query-control-plane.sql', import.meta.url), 'utf8'))
    controlPlaneA = createPostgresQueryControlPlane<Payload>({ pool: poolA })
    controlPlaneB = createPostgresQueryControlPlane<Payload>({ pool: poolB })
    queue = createPostgresRunJobQueue<Payload>({ pool: poolA })
  })

  beforeEach(async () => {
    await admin.query(`truncate table
      chatbi_query_audit_events,
      chatbi_query_idempotency,
      chatbi_run_events,
      chatbi_run_event_streams,
      chatbi_result_manifests,
      chatbi_result_pages,
      chatbi_run_job_attempts,
      chatbi_run_jobs,
      chatbi_query_runs,
      chatbi_query_conversations`)
  })

  afterAll(async () => {
    await queue?.close()
    await Promise.all([poolA?.end(), poolB?.end(), admin?.end()])
  })

  it('lets exactly one of two adapter instances create the same idempotent submission', async () => {
    const fingerprint = '{"mode":"trusted","question":"trend"}'
    const [first, second] = await Promise.all([
      controlPlaneA.submitAndEnqueue(makeInput({ runId: 'run_race_a', idempotencyKey: 'same-key', requestFingerprint: fingerprint })),
      controlPlaneB.submitAndEnqueue(makeInput({ runId: 'run_race_b', idempotencyKey: 'same-key', requestFingerprint: fingerprint })),
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) throw new Error('expected both idempotent calls to succeed')
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(first.runRecord.run.id).toBe(second.runRecord.run.id)
    const counts = await admin.query<{ runs: string; jobs: string; idempotency: string }>(`select
      (select count(*) from chatbi_query_runs)::text as runs,
      (select count(*) from chatbi_run_jobs)::text as jobs,
      (select count(*) from chatbi_query_idempotency)::text as idempotency`)
    expect(counts.rows[0]).toEqual({ runs: '1', jobs: '1', idempotency: '1' })
  })

  it('rejects a concurrent changed fingerprint and preserves only the winner', async () => {
    const results = await Promise.all([
      controlPlaneA.submitAndEnqueue(makeInput({ runId: 'run_changed_a', idempotencyKey: 'changed-key', requestFingerprint: '{"question":"a"}' })),
      controlPlaneB.submitAndEnqueue(makeInput({ runId: 'run_changed_b', idempotencyKey: 'changed-key', requestFingerprint: '{"question":"b"}' })),
    ])
    const winner = results.find((result) => result.ok)
    const conflict = results.find((result) => !result.ok)

    expect(winner).toMatchObject({ ok: true, created: true })
    expect(conflict).toMatchObject({ ok: false, reason: 'idempotency_conflict' })
    if (!winner?.ok || !conflict || conflict.ok) throw new Error('expected one winner and one conflict')
    expect(conflict.existingRunId).toBe(winner.runRecord.run.id)
    const stored = await admin.query<{ run_id: string }>('select run_id from chatbi_query_runs')
    expect(stored.rows).toEqual([{ run_id: winner.runRecord.run.id }])
  })

  it('uses conversation active-run CAS across two different idempotency keys', async () => {
    const results = await Promise.all([
      controlPlaneA.submitAndEnqueue(makeInput({ runId: 'run_active_a', idempotencyKey: 'active-a', requestFingerprint: '{"question":"a"}' })),
      controlPlaneB.submitAndEnqueue(makeInput({ runId: 'run_active_b', idempotencyKey: 'active-b', requestFingerprint: '{"question":"b"}' })),
    ])

    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: 'conversation_active_run_conflict' }),
    ])
    const state = await admin.query<{ conversations: string; runs: string; jobs: string; idempotency: string }>(`select
      (select count(*) from chatbi_query_conversations)::text as conversations,
      (select count(*) from chatbi_query_runs)::text as runs,
      (select count(*) from chatbi_run_jobs)::text as jobs,
      (select count(*) from chatbi_query_idempotency)::text as idempotency`)
    expect(state.rows[0]).toEqual({ conversations: '1', runs: '1', jobs: '1', idempotency: '1' })
  })

  it('commits terminal submissions with audit but without an active run or job', async () => {
    const input = makeInput({
      runId: 'run_terminal',
      idempotencyKey: 'terminal-key',
      requestFingerprint: '{"question":"denied"}',
      status: 'failed',
    })

    await expect(controlPlaneA.submitAndEnqueue(input)).resolves.toMatchObject({ ok: true, created: true })
    const state = await admin.query<{ active_run_id: string | null; jobs: string; audits: string }>(`select
      conversation.active_run_id,
      (select count(*) from chatbi_run_jobs)::text as jobs,
      (select count(*) from chatbi_query_audit_events)::text as audits
    from chatbi_query_conversations conversation`)
    expect(state.rows[0]).toEqual({ active_run_id: null, jobs: '0', audits: '1' })
  })

  it('cannot rebind an existing scoped conversation to another business domain', async () => {
    await controlPlaneA.submitAndEnqueue(makeInput({
      runId: 'run_sales',
      idempotencyKey: 'domain-sales',
      requestFingerprint: '{"question":"sales"}',
      businessDomainId: 'sales',
      status: 'failed',
    }))

    await expect(controlPlaneB.submitAndEnqueue(makeInput({
      runId: 'run_finance',
      idempotencyKey: 'domain-finance',
      requestFingerprint: '{"question":"finance"}',
      businessDomainId: 'finance',
      status: 'failed',
    }))).resolves.toEqual({ ok: false, reason: 'conversation_scope_conflict' })
    const state = await admin.query<{ business_domain_id: string; runs: string; idempotency: string }>(`select
      conversation.business_domain_id,
      (select count(*) from chatbi_query_runs)::text as runs,
      (select count(*) from chatbi_query_idempotency)::text as idempotency
    from chatbi_query_conversations conversation`)
    expect(state.rows[0]).toEqual({ business_domain_id: 'sales', runs: '1', idempotency: '1' })
  })

  it('serializes cancel versus complete so only one public outcome can win', async () => {
    const submitted = makeInput({
      runId: 'run_cancel_complete_race',
      idempotencyKey: 'cancel-complete-race',
      requestFingerprint: '{"question":"race"}',
    })
    await controlPlaneA.submitAndEnqueue(submitted)
    const lease = (await queue.claimNext({ workerId: 'worker_race', now: at, leaseMs: 60_000, runId: submitted.runRecord.run.id }))!

    const results = await Promise.all([
      controlPlaneA.commitAttempt(completeCommit(submitted, lease)),
      controlPlaneB.cancelRun({
        tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: submitted.runRecord.run.id,
        conversationId: submitted.conversation.id, cancelledAt: at1,
        actor: {
          tenantId: 'tenant_demo', workspaceId: 'workspace_sales', userId: 'user_1', roles: ['business_user'],
          businessDomainId: 'sales', semanticVersion: 'sales-v3', locale: 'zh-CN', timezone: 'Asia/Shanghai',
        },
        event: { eventId: 'event_cancel_race', event: { type: 'run.cancelled' }, occurredAt: at1 },
      }),
    ])

    expect(results.filter((result) => result.ok && result.applied)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, reason: 'terminal_conflict' }),
    ])
    const state = await admin.query<{
      job_status: string
      run_status: string
      active_run_id: string | null
      manifests: string
      events: string
    }>(`select
      job.status as job_status,
      run.stored_record_json->'run'->>'displayStatus' as run_status,
      conversation.active_run_id,
      (select count(*) from chatbi_result_manifests)::text as manifests,
      (select count(*) from chatbi_run_events)::text as events
    from chatbi_run_jobs job
    join chatbi_query_runs run on run.run_id = job.run_id
    join chatbi_query_conversations conversation on conversation.conversation_id = run.conversation_id`)
    expect(state.rows[0].active_run_id).toBeNull()
    expect(state.rows[0].events).toBe('1')
    if (state.rows[0].job_status === 'completed') {
      expect(state.rows[0]).toMatchObject({ run_status: 'completed', manifests: '1' })
    } else {
      expect(state.rows[0]).toMatchObject({ job_status: 'cancelled', run_status: 'waiting_input', manifests: '0' })
    }
  })

  it('rolls back manifest, job and Run when the final event append fails', async () => {
    const submitted = makeInput({
      runId: 'run_crash_boundary',
      idempotencyKey: 'crash-boundary',
      requestFingerprint: '{"question":"crash"}',
    })
    await controlPlaneA.submitAndEnqueue(submitted)
    const lease = (await queue.claimNext({ workerId: 'worker_crash', now: at, leaseMs: 60_000, runId: submitted.runRecord.run.id }))!
    const commit = completeCommit(submitted, lease, 'event_conflict')
    await admin.query(`insert into chatbi_run_event_streams (
      tenant_id, workspace_id, run_id, current_sequence, updated_at
    ) values ($1, $2, $3, 1, $4::timestamptz)`, ['tenant_demo', 'workspace_sales', submitted.runRecord.run.id, at])
    await admin.query(`insert into chatbi_run_events (
      tenant_id, workspace_id, run_id, sequence, idempotency_key, content_fingerprint, event_json, occurred_at
    ) values ($1, $2, $3, 1, 'event_conflict', 'different-content', '{"type":"other"}'::jsonb, $4::timestamptz)`, [
      'tenant_demo', 'workspace_sales', submitted.runRecord.run.id, at,
    ])

    await expect(controlPlaneA.commitAttempt(commit)).rejects.toThrow('run event idempotency conflict')

    const state = await admin.query<{ job_status: string; run_status: string; manifests: string; audits: string }>(`select
      job.status as job_status,
      run.stored_record_json->'run'->>'displayStatus' as run_status,
      (select count(*) from chatbi_result_manifests)::text as manifests,
      (select count(*) from chatbi_query_audit_events)::text as audits
    from chatbi_run_jobs job join chatbi_query_runs run on run.run_id = job.run_id`)
    expect(state.rows[0]).toEqual({ job_status: 'leased', run_status: 'querying', manifests: '0', audits: '1' })
  })
})
