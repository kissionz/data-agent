import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createPostgresQueryControlPlane,
  type PostgresQueryControlPlaneTransactionalOutbox,
  type QueryControlPlaneOutboxEnqueueInput,
  type PostgresQueryControlPlaneClientLike,
  type PostgresQueryControlPlanePoolLike,
} from '../../apps/api/src/adapters/postgresQueryControlPlane'
import type {
  CommitControlPlaneAttemptInput,
  SubmitAndEnqueueInput,
} from '../../src/persistence/controlPlanePorts'
import type { RunResult } from '../../src/domain'
import type { QueryRunJobPublication } from '../../src/application/queryExecutionCoordinator'

interface Call { text: string; values?: readonly unknown[] }
interface Payload { runId: string; question: string }

const at = '2026-07-15T10:00:00.000Z'
const at1 = '2026-07-15T10:00:01.000Z'
const leaseExpiresAt = '2026-07-15T10:01:00.000Z'
const requestFingerprint = '{"mode":"trusted","question":"过去 12 个月净收入趋势","semanticVersion":"sales-v3"}'

class ScriptedClient implements PostgresQueryControlPlaneClientLike {
  readonly calls: Call[] = []
  released = false
  releaseError: Error | boolean | undefined

  constructor(private readonly handler: (text: string, values?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return await this.handler(text, values) as { rows: Row[]; rowCount: number | null }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseError = error
  }
}

class ScriptedPool implements PostgresQueryControlPlanePoolLike {
  readonly directCalls: Call[] = []
  constructor(readonly client: ScriptedClient, private readonly directHandler = async () => ({ rows: [], rowCount: 0 })) {}
  async connect() { return this.client }
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.directCalls.push({ text, values })
    return await this.directHandler(text, values) as { rows: Row[]; rowCount: number | null }
  }
}

class RecordingTransactionalOutbox implements PostgresQueryControlPlaneTransactionalOutbox {
  readonly events: QueryControlPlaneOutboxEnqueueInput[] = []
  readonly clients: PostgresQueryControlPlaneClientLike[] = []

  constructor(
    private readonly outcome: 'created' | 'idempotent' | 'conflict' | 'throw' = 'created',
  ) {}

  async enqueueWithClient(
    client: PostgresQueryControlPlaneClientLike,
    input: QueryControlPlaneOutboxEnqueueInput,
  ) {
    this.clients.push(client)
    this.events.push(structuredClone(input))
    if (this.outcome === 'throw') throw new Error('outbox write failed: password=must-not-escape')
    if (this.outcome === 'conflict') return { ok: false as const, reason: 'idempotency_conflict' as const }
    return { ok: true as const, created: this.outcome === 'created' }
  }
}

function empty() { return Promise.resolve({ rows: [], rowCount: 0 }) }

function makeInput(options: { runId?: string; status?: 'querying' | 'failed'; withJob?: boolean } = {}): SubmitAndEnqueueInput<Payload> {
  const runId = options.runId ?? 'run_atomic'
  const status = options.status ?? 'querying'
  const withJob = options.withJob ?? status === 'querying'
  const conversation = {
    id: 'conversation_atomic',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    title: '净收入分析',
    businessDomainId: 'sales',
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
      id: runId,
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      conversationId: conversation.id,
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
    requestId: `request_${runId}`,
    traceId: `trace_${runId}`,
    audit: [{
      id: `audit_${runId}`,
      at,
      type: 'question.accepted' as const,
      actorUserId: 'user_1',
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      runId,
      summary: '问题已接收。',
    }],
  }
  return {
    idempotencyKey: 'request-key-1',
    requestFingerprint,
    conversation,
    runRecord,
    job: withJob ? {
      runId,
      tenantId: conversation.tenantId,
      workspaceId: conversation.workspaceId,
      payloadFingerprint: 'sha256:payload-v1',
      payload: { runId, question: runRecord.run.question },
      enqueuedAt: at,
      maxAttempts: 3,
    } : undefined,
  }
}

function conversationRow(input: SubmitAndEnqueueInput<Payload>) {
  return {
    conversation_id: input.conversation.id,
    tenant_id: input.conversation.tenantId,
    workspace_id: input.conversation.workspaceId,
    business_domain_id: input.conversation.businessDomainId,
    active_run_id: input.runRecord.run.displayStatus === 'querying' ? input.runRecord.run.id : null,
    payload_json: {
      ...input.conversation,
      ...(input.runRecord.run.displayStatus === 'querying' ? { activeRunId: input.runRecord.run.id } : {}),
    },
  }
}

function runRow(input: SubmitAndEnqueueInput<Payload>) {
  return {
    run_id: input.runRecord.run.id,
    tenant_id: input.runRecord.run.tenantId,
    workspace_id: input.runRecord.run.workspaceId,
    conversation_id: input.runRecord.run.conversationId,
    request_fingerprint: input.requestFingerprint,
    stored_record_json: input.runRecord,
  }
}

function tokenHash(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function jobRow(patch: Record<string, unknown> = {}) {
  return {
    run_id: 'run_atomic',
    tenant_id: 'tenant_demo',
    workspace_id: 'workspace_sales',
    payload_fingerprint: 'sha256:payload-v1',
    payload_json: { runId: 'run_atomic', question: '过去 12 个月净收入趋势' },
    status: 'leased',
    attempt: 1,
    max_attempts: 3,
    fence: 1,
    enqueued_at: at,
    available_at: at,
    lease_owner: 'worker_a',
    lease_token_hash: tokenHash('lease-a'),
    lease_expires_at: leaseExpiresAt,
    cancel_requested_at: null,
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_failure_json: null,
    result_fingerprint: null,
    result_json: null,
    terminal_kind: null,
    terminal_attempt: null,
    terminal_fence: null,
    terminal_worker_id: null,
    terminal_lease_token_hash: null,
    terminal_fingerprint: null,
    ...patch,
  }
}

function resultFixture(): RunResult {
  return {
    id: 'result_atomic',
    columns: [],
    rows: [],
    chartSpec: {
      id: 'chart_atomic',
      title: '净收入趋势',
      description: '测试结果',
      type: 'table',
      yAxisColumnIds: [],
      source: 'validated_result_spec',
      safety: { grounded: true, warnings: [] },
    },
    completeness: 'full',
    incompleteSteps: [],
    warnings: [],
    answer: {
      headline: '查询完成',
      summary: '测试结果',
      facts: [],
      semanticVersion: 'sales-v3',
      generatedFrom: 'query_result',
    },
    freshnessAt: at1,
  }
}

function completeCommitInput(): CommitControlPlaneAttemptInput<
  QueryRunJobPublication,
  { type: string },
  { rows: unknown[] },
  { semanticVersion: string }
> {
  const submitted = makeInput()
  const audit = {
    id: 'audit_complete',
    at: at1,
    type: 'query.completed' as const,
    actorUserId: 'user_1',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    runId: 'run_atomic',
    summary: '查询完成。',
  }
  return {
    job: {
      type: 'complete',
      input: {
        runId: 'run_atomic', attempt: 1, fence: 1, workerId: 'worker_a', leaseToken: 'lease-a',
        completedAt: at1,
        resultFingerprint: 'result-v1',
        result: {
          schemaVersion: 'chatbi_result_manifest_reference.v1',
          type: 'result_manifest',
          resultId: 'result_atomic',
          manifestChecksum: 'manifest-v1',
        },
      },
    },
    conversation: { ...submitted.conversation, updatedAt: at1 },
    runRecord: {
      ...submitted.runRecord,
      executedQuery: true,
      run: {
        ...submitted.runRecord.run,
        displayStatus: 'completed',
        internalStatus: 'succeeded',
        result: resultFixture(),
        version: submitted.runRecord.run.version + 1,
        updatedAt: at1,
      },
      audit: [...submitted.runRecord.audit, audit],
    },
    newAuditEvents: [audit],
    event: { eventId: 'event_complete', event: { type: 'run.completed' }, occurredAt: at1 },
    resultPublication: {
      pages: [],
      manifest: {
        tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: 'run_atomic', attempt: 1,
        resultId: 'result_atomic', manifestChecksum: 'manifest-v1', pageChecksums: [], totalRows: 0,
        metadata: { semanticVersion: 'sales-v3' }, publishedAt: at1,
      },
    },
  }
}

function failureCommitInput(kind: 'fail' | 'retry'): CommitControlPlaneAttemptInput<unknown, { type: string }> {
  const submitted = makeInput()
  const audit = {
    id: `audit_${kind}`,
    at: at1,
    type: 'query.completed' as const,
    actorUserId: 'user_1',
    tenantId: 'tenant_demo',
    workspaceId: 'workspace_sales',
    runId: 'run_atomic',
    summary: kind === 'fail' ? '查询失败。' : '查询等待重试。',
  }
  const failure = { code: 'QUERY_UNAVAILABLE', message: 'retry later', retryable: true }
  return {
    job: kind === 'fail'
      ? {
          type: 'fail',
          input: { runId: 'run_atomic', attempt: 1, fence: 1, workerId: 'worker_a', leaseToken: 'lease-a', failedAt: at1, failure },
        }
      : {
          type: 'retry',
          input: {
            runId: 'run_atomic', attempt: 1, fence: 1, workerId: 'worker_a', leaseToken: 'lease-a', failedAt: at1,
            availableAt: '2026-07-15T10:00:05.000Z', failure,
          },
        },
    conversation: {
      ...submitted.conversation,
      ...(kind === 'retry' ? { activeRunId: 'run_atomic' } : {}),
      updatedAt: at1,
    },
    runRecord: {
      ...submitted.runRecord,
      run: kind === 'fail'
        ? {
            ...submitted.runRecord.run,
            displayStatus: 'failed',
            internalStatus: 'failed',
            error: { code: 'INTERNAL_ERROR', userMessage: '查询失败', retryable: true, debugReference: 'query_failed' },
            updatedAt: at1,
          }
        : { ...submitted.runRecord.run, updatedAt: at1 },
      audit: [...submitted.runRecord.audit, audit],
    },
    newAuditEvents: [audit],
    event: { eventId: `event_${kind}`, event: { type: `run.${kind}` }, occurredAt: at1 },
  }
}

describe('PostgreSQL atomic query control-plane unit boundary', () => {
  it('ships scoped idempotency, conversation CAS, run and audit tables', () => {
    const sql = readFileSync(new URL('../../scripts/postgres/query-control-plane.sql', import.meta.url), 'utf8')
    expect(sql).toContain('create table if not exists chatbi_query_conversations')
    expect(sql).toContain('create table if not exists chatbi_query_runs')
    expect(sql).toContain('create table if not exists chatbi_query_idempotency')
    expect(sql).toContain('request_fingerprint text not null')
    expect(sql).toContain('primary key (tenant_id, workspace_id, conversation_id, idempotency_key)')
    expect(sql).toContain('create table if not exists chatbi_query_audit_events')
  })

  it('exposes a public-safe PostgreSQL readiness probe', async () => {
    const client = new ScriptedClient(async () => empty())
    const healthy = createPostgresQueryControlPlane({
      pool: new ScriptedPool(client, async () => ({ rows: [{ ready: 1 }], rowCount: 1 })),
    })
    await expect(healthy.readiness()).resolves.toEqual({ ok: true })

    const unavailable = createPostgresQueryControlPlane({
      pool: new ScriptedPool(client, async () => { throw new Error('password=super-secret host=private-db') }),
    })
    const error = await unavailable.readiness().catch((caught: unknown) => caught as Error & { code?: string })
    expect(error).toMatchObject({ message: 'PostgreSQL query control plane unavailable', code: 'CONTROL_PLANE_UNAVAILABLE' })
    expect(JSON.stringify(error)).not.toContain('super-secret')
  })

  it('publishes conversation, run, audit and job through parameters in one transaction', async () => {
    const input = makeInput()
    Object.assign(input.job!.payload, {
      sql: 'select * from private_table',
      parameters: { password: 'warehouse-password' },
      credential: 'postgresql://admin:secret@private-db/warehouse',
      rows: [{ customer_email: 'private@example.com' }],
    })
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_query_idempotency')) {
        return { rows: [{ request_fingerprint: requestFingerprint, run_id: input.runRecord.run.id }], rowCount: 1 }
      }
      if (text.startsWith('select conversation_id') && text.includes('for update')) {
        return { rows: [conversationRow(input)], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_query_conversations')) {
        return { rows: [conversationRow(input)], rowCount: 1 }
      }
      if (text.startsWith('insert into chatbi_query_runs')) return { rows: [runRow(input)], rowCount: 1 }
      if (text.startsWith('insert into chatbi_run_jobs')) return { rows: [{ run_id: input.runRecord.run.id }], rowCount: 1 }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    const result = await controlPlane.submitAndEnqueue(input)

    expect(result).toMatchObject({ ok: true, created: true, runRecord: { run: { id: 'run_atomic' } } })
    expect(client.calls[0].text).toBe('BEGIN')
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    expect(client.released).toBe(true)
    const reservation = client.calls.find((call) => call.text.startsWith('insert into chatbi_query_idempotency'))!
    expect(reservation.values).toEqual([
      'tenant_demo', 'workspace_sales', 'conversation_atomic', 'request-key-1',
      requestFingerprint, 'run_atomic', at,
    ])
    const job = client.calls.find((call) => call.text.startsWith('insert into chatbi_run_jobs'))!
    expect(job.values?.[4]).toBe(JSON.stringify(input.job?.payload))
    expect(client.calls.some((call) => call.text.includes(input.runRecord.run.question))).toBe(false)
    expect(outbox.clients).toEqual([client])
    expect(outbox.events).toEqual([{
      eventId: `outbox_query_run_${createHash('sha256').update(
        '{"aggregateId":"run_atomic","aggregateType":"query_run","tenantId":"tenant_demo","topic":"query.run.submitted.v1","workspaceId":"workspace_sales"}',
      ).digest('hex')}`,
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      aggregateType: 'query_run',
      aggregateId: 'run_atomic',
      topic: 'query.run.submitted.v1',
      payload: {
        schemaVersion: 'query_control_plane.v1',
        type: 'query.run.submitted',
        runId: 'run_atomic',
        conversationId: 'conversation_atomic',
        state: 'querying',
        workScheduled: true,
      },
      occurredAt: at,
      availableAt: at,
    }])
    const publicEvent = JSON.stringify(outbox.events[0])
    expect(publicEvent).not.toContain('private_table')
    expect(publicEvent).not.toContain('warehouse-password')
    expect(publicEvent).not.toContain('postgresql://')
    expect(publicEvent).not.toContain('private@example.com')
    expect(publicEvent).not.toMatch(/"(sql|parameters|params|credential|credentials|rows|result|data)"/i)
  })

  it('atomically saves a terminal run without creating a query job or active run', async () => {
    const input = makeInput({ status: 'failed', withJob: false })
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_query_idempotency')) {
        return { rows: [{ request_fingerprint: requestFingerprint, run_id: input.runRecord.run.id }], rowCount: 1 }
      }
      if (text.startsWith('select conversation_id') && text.includes('for update')) {
        return { rows: [conversationRow(input)], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_query_conversations')) {
        return { rows: [conversationRow(input)], rowCount: 1 }
      }
      if (text.startsWith('insert into chatbi_query_runs')) return { rows: [runRow(input)], rowCount: 1 }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    const result = await controlPlane.submitAndEnqueue(input)

    expect(result).toMatchObject({ ok: true, created: true, conversation: { activeRunId: undefined } })
    expect(client.calls.some((call) => call.text.includes('insert into chatbi_run_jobs'))).toBe(false)
    expect(outbox.events).toHaveLength(1)
    expect(outbox.events[0]).toMatchObject({
      topic: 'query.run.submitted.v1',
      payload: { state: 'failed', workScheduled: false },
    })
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('returns the durable existing run for the same canonical request identity', async () => {
    const input = makeInput()
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_query_idempotency')) return empty()
      if (text.startsWith('select request_fingerprint')) {
        return { rows: [{ request_fingerprint: requestFingerprint, run_id: input.runRecord.run.id }], rowCount: 1 }
      }
      if (text.startsWith('select run_id')) return { rows: [runRow(input)], rowCount: 1 }
      if (text.startsWith('select conversation_id')) return { rows: [conversationRow(input)], rowCount: 1 }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    await expect(controlPlane.submitAndEnqueue(input)).resolves.toMatchObject({
      ok: true,
      created: false,
      runRecord: { run: { id: input.runRecord.run.id } },
    })
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_query_runs'))).toBe(false)
    expect(outbox.events).toHaveLength(0)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('rolls back a changed request fingerprint without leaving an idempotency reservation', async () => {
    const input = makeInput()
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_query_idempotency')) return empty()
      if (text.startsWith('select request_fingerprint')) {
        return { rows: [{ request_fingerprint: '{"question":"different"}', run_id: 'run_existing' }], rowCount: 1 }
      }
      return empty()
    })
    const controlPlane = createPostgresQueryControlPlane<Payload>({ pool: new ScriptedPool(client) })

    await expect(controlPlane.submitAndEnqueue(input)).resolves.toEqual({
      ok: false,
      reason: 'idempotency_conflict',
      existingRunId: 'run_existing',
    })
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it.each(['conflict', 'throw'] as const)(
    'rolls back every business write when the transactional outbox returns %s',
    async (outcome) => {
      const input = makeInput()
      const client = new ScriptedClient(async (text) => {
        if (text.startsWith('insert into chatbi_query_idempotency')) {
          return { rows: [{ request_fingerprint: requestFingerprint, run_id: input.runRecord.run.id }], rowCount: 1 }
        }
        if (text.startsWith('select conversation_id') && text.includes('for update')) {
          return { rows: [conversationRow(input)], rowCount: 1 }
        }
        if (text.startsWith('update chatbi_query_conversations')) {
          return { rows: [conversationRow(input)], rowCount: 1 }
        }
        if (text.startsWith('insert into chatbi_query_runs')) return { rows: [runRow(input)], rowCount: 1 }
        if (text.startsWith('insert into chatbi_run_jobs')) {
          return { rows: [{ run_id: input.runRecord.run.id }], rowCount: 1 }
        }
        return empty()
      })
      const outbox = new RecordingTransactionalOutbox(outcome)
      const controlPlane = createPostgresQueryControlPlane<Payload>({
        pool: new ScriptedPool(client),
        transactionalOutbox: outbox,
      })

      const error = await controlPlane.submitAndEnqueue(input).catch((caught: unknown) => caught as Error)

      expect(error.message).toBe(outcome === 'conflict'
        ? 'query control-plane outbox idempotency conflict'
        : 'query control-plane outbox enqueue failed')
      expect(error.message).not.toContain('must-not-escape')
      expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_run_jobs'))).toBe(true)
      expect(outbox.clients).toEqual([client])
      expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
      expect(client.calls.some((call) => call.text === 'COMMIT')).toBe(false)
      expect(client.released).toBe(true)
    },
  )

  it('rejects rebinding an existing conversation to another business domain', async () => {
    const input = makeInput()
    const client = new ScriptedClient(async (text) => {
      if (text.startsWith('insert into chatbi_query_idempotency')) {
        return { rows: [{ request_fingerprint: requestFingerprint, run_id: input.runRecord.run.id }], rowCount: 1 }
      }
      if (text.startsWith('select conversation_id') && text.includes('for update')) {
        return { rows: [{ ...conversationRow(input), business_domain_id: 'finance' }], rowCount: 1 }
      }
      return empty()
    })
    const controlPlane = createPostgresQueryControlPlane<Payload>({ pool: new ScriptedPool(client) })

    await expect(controlPlane.submitAndEnqueue(input)).resolves.toEqual({
      ok: false,
      reason: 'conversation_scope_conflict',
    })
    expect(client.calls.some((call) => call.text.startsWith('update chatbi_query_conversations'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('cancels job, Run, Conversation, audit and event in the same transaction', async () => {
    const submitted = makeInput()
    const currentConversation = { ...conversationRow(submitted), active_run_id: 'run_atomic' }
    const client = new ScriptedClient(async (text) => {
      if (text === 'select * from chatbi_run_jobs where run_id = $1 for update') return { rows: [jobRow()], rowCount: 1 }
      if (text.startsWith('select run_id') && text.includes('for update')) return { rows: [runRow(submitted)], rowCount: 1 }
      if (text.startsWith('select conversation_id') && text.includes('for update')) return { rows: [currentConversation], rowCount: 1 }
      if (text.startsWith('update chatbi_query_runs') || text.startsWith('update chatbi_query_conversations')) {
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('select current_sequence')) return { rows: [{ current_sequence: 0 }], rowCount: 1 }
      if (text.startsWith('select content_fingerprint')) return empty()
      if (text.startsWith('update chatbi_run_event_streams')) return { rows: [], rowCount: 1 }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload, unknown, { type: string }>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    const result = await controlPlane.cancelRun({
      tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: 'run_atomic',
      conversationId: 'conversation_atomic', cancelledAt: at1,
      actor: {
        tenantId: 'tenant_demo', workspaceId: 'workspace_sales', userId: 'user_1', roles: ['business_user'],
        businessDomainId: 'sales', semanticVersion: 'sales-v3', locale: 'zh-CN', timezone: 'Asia/Shanghai',
      },
      event: { eventId: 'event_cancel', event: { type: 'run.cancelled' }, occurredAt: at1 },
    })

    expect(result).toMatchObject({
      ok: true,
      applied: true,
      conversation: { activeRunId: undefined },
      runRecord: { run: { internalStatus: 'cancelled', terminationReason: 'cancelled_by_user' } },
    })
    expect(client.calls.some((call) => call.text.startsWith('update chatbi_run_jobs'))).toBe(true)
    expect(client.calls.some((call) => call.text.startsWith('update chatbi_query_runs'))).toBe(true)
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_query_audit_events'))).toBe(true)
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_run_events'))).toBe(true)
    expect(outbox.clients).toEqual([client])
    expect(outbox.events).toHaveLength(1)
    expect(outbox.events[0]).toMatchObject({
      tenantId: 'tenant_demo',
      workspaceId: 'workspace_sales',
      aggregateType: 'query_run',
      aggregateId: 'run_atomic',
      topic: 'query.run.cancelled.v1',
      payload: {
        schemaVersion: 'query_control_plane.v1',
        type: 'query.run.cancelled',
        runId: 'run_atomic',
        conversationId: 'conversation_atomic',
        state: 'cancelled',
      },
      occurredAt: at1,
      availableAt: at1,
    })
    expect(client.calls[0].text).toBe('BEGIN')
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('returns an already-cancelled durable Run idempotently without appending duplicate state', async () => {
    const submitted = makeInput()
    const cancelledRecord = {
      ...submitted.runRecord,
      run: {
        ...submitted.runRecord.run,
        displayStatus: 'waiting_input' as const,
        internalStatus: 'cancelled' as const,
        terminationReason: 'cancelled_by_user' as const,
        updatedAt: at1,
      },
    }
    const client = new ScriptedClient(async (text) => {
      if (text === 'select * from chatbi_run_jobs where run_id = $1 for update') {
        return { rows: [jobRow({ status: 'cancelled', lease_owner: null, lease_token_hash: null, lease_expires_at: null })], rowCount: 1 }
      }
      if (text.startsWith('select run_id') && text.includes('for update')) {
        return { rows: [{ ...runRow(submitted), stored_record_json: cancelledRecord }], rowCount: 1 }
      }
      if (text.startsWith('select conversation_id') && text.includes('for update')) {
        return { rows: [{ ...conversationRow(submitted), active_run_id: null, payload_json: submitted.conversation }], rowCount: 1 }
      }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload, unknown, { type: string }>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    const result = await controlPlane.cancelRun({
      tenantId: 'tenant_demo', workspaceId: 'workspace_sales', runId: 'run_atomic',
      conversationId: 'conversation_atomic', cancelledAt: at1,
      actor: {
        tenantId: 'tenant_demo', workspaceId: 'workspace_sales', userId: 'user_1', roles: ['business_user'],
        businessDomainId: 'sales', semanticVersion: 'sales-v3', locale: 'zh-CN', timezone: 'Asia/Shanghai',
      },
      event: { eventId: 'event_cancel', event: { type: 'run.cancelled' }, occurredAt: at1 },
    })

    expect(result).toMatchObject({ ok: true, applied: false, runRecord: { run: { internalStatus: 'cancelled' } } })
    expect(client.calls.some((call) => call.text.startsWith('update '))).toBe(false)
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_run_events'))).toBe(false)
    expect(outbox.events).toHaveLength(0)
  })

  it('publishes immutable result manifest and terminal job/Run/event in one transaction', async () => {
    const submitted = makeInput()
    const commit = completeCommitInput()
    let terminal = false
    const client = new ScriptedClient(async (text) => {
      if (text === 'select * from chatbi_run_jobs where run_id = $1 for update') return { rows: [jobRow()], rowCount: 1 }
      if (text.startsWith('select run_id') && text.includes('for update')) return { rows: [runRow(submitted)], rowCount: 1 }
      if (text.startsWith('select conversation_id') && text.includes('for update')) {
        return { rows: [{ ...conversationRow(submitted), active_run_id: 'run_atomic' }], rowCount: 1 }
      }
      if (text.startsWith('select page_index')) return empty()
      if (text.startsWith('insert into chatbi_result_manifests')) {
        return { rows: [{ manifest_checksum: 'manifest-v1', content_fingerprint: 'stored' }], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_run_jobs')) { terminal = true; return empty() }
      if (text.startsWith('update chatbi_query_runs') || text.startsWith('update chatbi_query_conversations')) {
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('select current_sequence')) return { rows: [{ current_sequence: 0 }], rowCount: 1 }
      if (text.startsWith('select content_fingerprint')) return empty()
      if (text.startsWith('update chatbi_run_event_streams')) return { rows: [], rowCount: 1 }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') {
        return { rows: [jobRow({
          status: terminal ? 'completed' : 'leased', lease_owner: null, lease_token_hash: null,
          lease_expires_at: null, completed_at: at1, result_fingerprint: 'result-v1',
          result_json: commit.job.type === 'complete' ? commit.job.input.result : null,
          terminal_kind: 'completed', terminal_attempt: 1,
          terminal_fence: 1, terminal_worker_id: 'worker_a', terminal_lease_token_hash: tokenHash('lease-a'),
          terminal_fingerprint: 'result-v1',
        })], rowCount: 1 }
      }
      if (text.startsWith('select attempt, fence')) {
        return { rows: [{
          attempt: 1, fence: 1, worker_id: 'worker_a', started_at: at,
          lease_expires_at: leaseExpiresAt, ended_at: at1, outcome: 'completed', failure_json: null,
        }], rowCount: 1 }
      }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<
      Payload,
      QueryRunJobPublication,
      { type: string },
      { rows: unknown[] },
      { semanticVersion: string }
    >({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    const result = await controlPlane.commitAttempt(commit)

    expect(result).toMatchObject({ ok: true, applied: true, job: { status: 'completed', resultFingerprint: 'result-v1' } })
    const manifestIndex = client.calls.findIndex((call) => call.text.startsWith('insert into chatbi_result_manifests'))
    const runIndex = client.calls.findIndex((call) => call.text.startsWith('update chatbi_query_runs'))
    const commitIndex = client.calls.findIndex((call) => call.text === 'COMMIT')
    expect(manifestIndex).toBeGreaterThan(0)
    expect(runIndex).toBeGreaterThan(manifestIndex)
    expect(commitIndex).toBeGreaterThan(runIndex)
    const jobUpdate = client.calls.find((call) => call.text.startsWith('update chatbi_run_jobs'))!
    expect(JSON.parse(String(jobUpdate.values?.[3]))).toEqual({
      schemaVersion: 'chatbi_result_manifest_reference.v1',
      type: 'result_manifest',
      resultId: 'result_atomic',
      manifestChecksum: 'manifest-v1',
    })
    expect(String(jobUpdate.values?.[3])).not.toContain('answer')
    expect(String(jobUpdate.values?.[3])).not.toContain('rows')
    expect(String(jobUpdate.values?.[3])).not.toContain('columns')
    expect(outbox.clients).toEqual([client])
    expect(outbox.events).toHaveLength(1)
    expect(outbox.events[0]).toMatchObject({
      topic: 'query.attempt.completed.v1',
      payload: {
        schemaVersion: 'query_control_plane.v1',
        type: 'query.attempt.completed',
        runId: 'run_atomic',
        conversationId: 'conversation_atomic',
        state: 'completed',
        attempt: 1,
        fence: 1,
      },
      occurredAt: at1,
      availableAt: at1,
    })
    expect(JSON.stringify(outbox.events[0])).not.toContain('result_atomic')
    expect(JSON.stringify(outbox.events[0])).not.toContain('result-v1')
  })

  it.each([
    ['fail', 'failed'],
    ['retry', 'retry_wait'],
  ] as const)('atomically applies %s job mutation with Run, Conversation, audit and event', async (kind, status) => {
    const submitted = makeInput()
    const commit = failureCommitInput(kind)
    commit.job.input.failure.message = 'password=warehouse-secret at private-db\nError: stack trace'
    commit.job.input.failure.debugReference = 'select * from private_table -- stack'
    let mutated = false
    const client = new ScriptedClient(async (text) => {
      if (text === 'select * from chatbi_run_jobs where run_id = $1 for update') return { rows: [jobRow()], rowCount: 1 }
      if (text.startsWith('select run_id') && text.includes('for update')) return { rows: [runRow(submitted)], rowCount: 1 }
      if (text.startsWith('select conversation_id') && text.includes('for update')) {
        return { rows: [{ ...conversationRow(submitted), active_run_id: 'run_atomic' }], rowCount: 1 }
      }
      if (text.startsWith('update chatbi_run_jobs')) { mutated = true; return empty() }
      if (text.startsWith('update chatbi_query_runs') || text.startsWith('update chatbi_query_conversations')) {
        return { rows: [], rowCount: 1 }
      }
      if (text.startsWith('select current_sequence')) return { rows: [{ current_sequence: 0 }], rowCount: 1 }
      if (text.startsWith('select content_fingerprint')) return empty()
      if (text.startsWith('update chatbi_run_event_streams')) return { rows: [], rowCount: 1 }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') {
        return { rows: [jobRow({
          status: mutated ? status : 'leased', lease_owner: null, lease_token_hash: null, lease_expires_at: null,
          failed_at: kind === 'fail' ? at1 : null,
          available_at: kind === 'retry' ? '2026-07-15T10:00:05.000Z' : at,
          last_failure_json: { code: 'QUERY_UNAVAILABLE', message: 'retry later', retryable: true },
          terminal_kind: kind === 'fail' ? 'failed' : 'retry_scheduled', terminal_attempt: 1,
          terminal_fence: 1, terminal_worker_id: 'worker_a', terminal_lease_token_hash: tokenHash('lease-a'),
          terminal_fingerprint: 'stored',
        })], rowCount: 1 }
      }
      if (text.startsWith('select attempt, fence')) {
        return { rows: [{
          attempt: 1, fence: 1, worker_id: 'worker_a', started_at: at, lease_expires_at: leaseExpiresAt,
          ended_at: at1, outcome: kind === 'fail' ? 'failed' : 'retry_scheduled',
          failure_json: { code: 'QUERY_UNAVAILABLE', message: 'retry later', retryable: true },
        }], rowCount: 1 }
      }
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    const result = await controlPlane.commitAttempt(commit)

    expect(result).toMatchObject({ ok: true, applied: true, job: { status } })
    expect(client.calls.some((call) => call.text.startsWith('update chatbi_query_runs'))).toBe(true)
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_query_audit_events'))).toBe(true)
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_run_events'))).toBe(true)
    expect(outbox.clients).toEqual([client])
    expect(outbox.events).toHaveLength(1)
    expect(outbox.events[0]).toMatchObject({
      topic: kind === 'fail' ? 'query.attempt.failed.v1' : 'query.attempt.retry_scheduled.v1',
      payload: {
        schemaVersion: 'query_control_plane.v1',
        type: kind === 'fail' ? 'query.attempt.failed' : 'query.attempt.retry_scheduled',
        runId: 'run_atomic',
        conversationId: 'conversation_atomic',
        state: status,
        attempt: 1,
        fence: 1,
        ...(kind === 'retry' ? { nextAttemptAt: '2026-07-15T10:00:05.000Z' } : {}),
      },
    })
    const publicEvent = JSON.stringify(outbox.events[0])
    expect(publicEvent).not.toContain('warehouse-secret')
    expect(publicEvent).not.toContain('private_table')
    expect(publicEvent).not.toContain('stack trace')
    expect(publicEvent).not.toMatch(/"(message|stack|sql|parameters|credentials|rows|result|data)"/i)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('fences an old worker before it can publish Run, event or result state', async () => {
    const commit = completeCommitInput()
    const client = new ScriptedClient(async (text) => {
      if (text === 'select * from chatbi_run_jobs where run_id = $1 for update') {
        return { rows: [jobRow({ attempt: 2, fence: 2, lease_owner: 'worker_new' })], rowCount: 1 }
      }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') {
        return { rows: [jobRow({ attempt: 2, fence: 2, lease_owner: 'worker_new' })], rowCount: 1 }
      }
      if (text.startsWith('select attempt, fence')) return empty()
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload, QueryRunJobPublication>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    await expect(controlPlane.commitAttempt(commit)).resolves.toMatchObject({ ok: false, reason: 'stale_lease' })
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_result_manifests'))).toBe(false)
    expect(client.calls.some((call) => call.text.startsWith('update chatbi_query_runs'))).toBe(false)
    expect(outbox.events).toHaveLength(0)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('returns an identical completed lease mutation idempotently without republishing', async () => {
    const commit = completeCommitInput()
    const terminal = jobRow({
      status: 'completed', lease_owner: null, lease_token_hash: null, lease_expires_at: null,
      completed_at: at1,
      result_fingerprint: 'result-v1',
      result_json: commit.job.type === 'complete' ? commit.job.input.result : null,
      terminal_kind: 'completed', terminal_attempt: 1, terminal_fence: 1,
      terminal_worker_id: 'worker_a', terminal_lease_token_hash: tokenHash('lease-a'), terminal_fingerprint: 'result-v1',
    })
    const client = new ScriptedClient(async (text) => {
      if (text === 'select * from chatbi_run_jobs where run_id = $1 for update') return { rows: [terminal], rowCount: 1 }
      if (text === 'select * from chatbi_run_jobs where run_id = $1') return { rows: [terminal], rowCount: 1 }
      if (text.startsWith('select attempt, fence')) return empty()
      return empty()
    })
    const outbox = new RecordingTransactionalOutbox()
    const controlPlane = createPostgresQueryControlPlane<Payload, QueryRunJobPublication>({
      pool: new ScriptedPool(client),
      transactionalOutbox: outbox,
    })

    await expect(controlPlane.commitAttempt(commit)).resolves.toMatchObject({
      ok: true,
      applied: false,
      job: { status: 'completed' },
    })
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_result_manifests'))).toBe(false)
    expect(client.calls.some((call) => call.text.startsWith('update chatbi_query_runs'))).toBe(false)
    expect(outbox.events).toHaveLength(0)
  })

  it('rejects job/status mismatches before opening a transaction', async () => {
    const client = new ScriptedClient(async () => empty())
    const controlPlane = createPostgresQueryControlPlane<Payload>({ pool: new ScriptedPool(client) })

    await expect(controlPlane.submitAndEnqueue(makeInput({ status: 'querying', withJob: false })))
      .rejects.toThrow('querying run requires a job')
    await expect(controlPlane.submitAndEnqueue(makeInput({ status: 'failed', withJob: true })))
      .rejects.toThrow('only a querying run may enqueue a job')
    expect(client.calls).toHaveLength(0)
  })
})
