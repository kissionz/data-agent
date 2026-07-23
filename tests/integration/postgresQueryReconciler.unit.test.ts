import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  createPostgresQueryReconciler,
  type PostgresQueryReconcilerClientLike,
  type PostgresQueryReconcilerPoolLike,
} from '../../apps/api/src/adapters/postgresQueryReconciler'

interface Call { text: string; values?: readonly unknown[] }
interface Result { rows: unknown[]; rowCount: number | null }

const now = '2026-07-15T12:00:00.000Z'

class ScriptedClient implements PostgresQueryReconcilerClientLike {
  readonly calls: Call[] = []
  released = false
  releaseError: Error | boolean | undefined

  constructor(private readonly handler: (text: string, values?: readonly unknown[]) => Promise<Result>) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return await this.handler(text, values) as { rows: Row[]; rowCount: number | null }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseError = error
  }
}

class ScriptedPool implements PostgresQueryReconcilerPoolLike {
  readonly calls: Call[] = []

  constructor(
    readonly client: ScriptedClient,
    private readonly candidates: string[] = ['run_reconcile'],
  ) {}

  async connect() { return this.client }

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return {
      rows: this.candidates.map((run_id) => ({ run_id })) as Row[],
      rowCount: this.candidates.length,
    }
  }
}

function row(patch: Record<string, unknown> = {}) {
  return {
    run_id: 'run_reconcile',
    run_tenant_id: 'tenant_demo',
    run_workspace_id: 'workspace_sales',
    conversation_id: 'conversation_reconcile',
    display_status: 'completed',
    internal_status: 'succeeded',
    run_result_id: 'result_1',
    conversation_tenant_id: 'tenant_demo',
    conversation_workspace_id: 'workspace_sales',
    active_run_id: 'run_reconcile',
    job_tenant_id: 'tenant_demo',
    job_workspace_id: 'workspace_sales',
    job_status: 'leased',
    job_attempt: 2,
    job_fence: 5,
    lease_expires_at: '2026-07-15T11:59:59.000Z',
    manifest_attempt: 2,
    manifest_result_id: 'result_1',
    ...patch,
  }
}

function empty(): Promise<Result> {
  return Promise.resolve({ rows: [], rowCount: 0 })
}

describe('PostgreSQL durable query reconciler', () => {
  it('uses a bounded scan, row locks and fenced CAS to repair only provable terminal state', async () => {
    const state = row()
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.startsWith('select run.conversation_id')) {
        return { rows: [{ conversation_id: 'conversation_reconcile', job_exists: true }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_run_jobs')) return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      if (text.startsWith('select run_id from chatbi_query_runs')) return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      if (text.startsWith('select conversation_id from chatbi_query_conversations')) {
        return { rows: [{ conversation_id: 'conversation_reconcile' }], rowCount: 1 }
      }
      if (text.includes('from chatbi_query_runs run')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('update chatbi_query_conversations')) return { rows: [], rowCount: 1 }
      if (text.startsWith('update chatbi_run_jobs')) return { rows: [], rowCount: 1 }
      if (text.startsWith('update chatbi_run_job_attempts')) return { rows: [], rowCount: 1 }
      if (text.startsWith('insert into chatbi_query_reconciliation_findings')) {
        return { rows: [{ finding_id: values?.[0] }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const pool = new ScriptedPool(client)
    const reconciler = createPostgresQueryReconciler({ pool, maxBatchSize: 25 })

    await expect(reconciler.reconcileBatch({ now, limit: 10 })).resolves.toMatchObject({
      scanned: 1,
      repaired: 2,
      alerted: 0,
      findings: [
        { code: 'terminal_run_active_conversation', disposition: 'repaired' },
        { code: 'terminal_run_active_job', disposition: 'repaired' },
      ],
    })

    expect(pool.calls[0].values).toEqual([10])
    expect(pool.calls[0].text).toContain('limit $1')
    const jobLockIndex = client.calls.findIndex((call) => call.text.startsWith('select run_id from chatbi_run_jobs'))
    const runLockIndex = client.calls.findIndex((call) => call.text.startsWith('select run_id from chatbi_query_runs'))
    const conversationLockIndex = client.calls.findIndex((call) => call.text.startsWith('select conversation_id from chatbi_query_conversations'))
    expect(jobLockIndex).toBeLessThan(runLockIndex)
    expect(runLockIndex).toBeLessThan(conversationLockIndex)
    const jobUpdate = client.calls.find((call) => call.text.startsWith('update chatbi_run_jobs'))!
    expect(jobUpdate.text).toContain('fence = $2')
    expect(jobUpdate.text).toContain('attempt = $5')
    expect(jobUpdate.text).toContain("lease_expires_at <= $3::timestamptz")
    expect(jobUpdate.values).toEqual(['run_reconcile', 5, now, ['queued', 'leased', 'retry_wait'], 2])
    expect(client.calls.some((call) => /(?:insert|update) chatbi_result_(?:pages|manifests)/.test(call.text))).toBe(false)
    expect(client.released).toBe(true)
  })

  it('alerts on a missing manifest without writing a result or guessing a Run transition', async () => {
    const state = row({
      active_run_id: null,
      job_status: 'completed',
      job_attempt: 2,
      job_fence: 5,
      lease_expires_at: null,
      manifest_attempt: null,
      manifest_result_id: null,
    })
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.startsWith('select run.conversation_id')) {
        return { rows: [{ conversation_id: 'conversation_reconcile', job_exists: true }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_run_jobs')) return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      if (text.startsWith('select run_id from chatbi_query_runs')) return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      if (text.startsWith('select conversation_id from chatbi_query_conversations')) {
        return { rows: [{ conversation_id: 'conversation_reconcile' }], rowCount: 1 }
      }
      if (text.includes('from chatbi_query_runs run')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('insert into chatbi_query_reconciliation_findings')) {
        return { rows: [{ finding_id: values?.[0] }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const reconciler = createPostgresQueryReconciler({ pool: new ScriptedPool(client) })

    const report = await reconciler.reconcileBatch({ now, limit: 1 })

    expect(report).toMatchObject({
      scanned: 1,
      repaired: 0,
      alerted: 1,
      findings: [{ code: 'completed_run_missing_manifest', disposition: 'alerted' }],
    })
    expect(client.calls.filter((call) => call.text.startsWith('update '))).toEqual([])
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_query_reconciliation_findings'))).toBe(true)
    expect(JSON.stringify(client.calls)).not.toContain('insert into chatbi_result')
  })

  it('does not fence a live lease and returns a stable alert for monitoring deduplication', async () => {
    const state = row({
      active_run_id: null,
      display_status: 'failed',
      internal_status: 'failed',
      run_result_id: null,
      lease_expires_at: '2026-07-15T12:00:01.000Z',
      manifest_attempt: null,
      manifest_result_id: null,
    })
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.startsWith('select run.conversation_id')) {
        return { rows: [{ conversation_id: 'conversation_reconcile', job_exists: true }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_run_jobs')) return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      if (text.startsWith('select run_id from chatbi_query_runs')) return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      if (text.startsWith('select conversation_id from chatbi_query_conversations')) {
        return { rows: [{ conversation_id: 'conversation_reconcile' }], rowCount: 1 }
      }
      if (text.includes('from chatbi_query_runs run')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('insert into chatbi_query_reconciliation_findings')) {
        return { rows: [{ finding_id: values?.[0] }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const reconciler = createPostgresQueryReconciler({ pool: new ScriptedPool(client) })

    const first = await reconciler.reconcileBatch({ now, limit: 1 })
    const second = await reconciler.reconcileBatch({ now, limit: 1 })

    expect(first).toMatchObject({ repaired: 0, alerted: 1 })
    expect(first.findings[0]).toMatchObject({
      code: 'terminal_run_unexpired_lease',
      disposition: 'alerted',
    })
    expect(second.findings[0].findingId).toBe(first.findings[0].findingId)
    expect(client.calls.filter((call) => call.text.startsWith('update '))).toEqual([])
  })

  it('fails closed and rolls back when a finding digest resolves to different persisted identity', async () => {
    const state = row({
      active_run_id: null,
      job_status: 'completed',
      job_attempt: 2,
      job_fence: 5,
      lease_expires_at: null,
      manifest_attempt: null,
      manifest_result_id: null,
    })
    const client = new ScriptedClient(async (text) => {
      if (text === 'BEGIN' || text === 'ROLLBACK') return await empty()
      if (text.startsWith('select run.conversation_id')) {
        return { rows: [{ conversation_id: 'conversation_reconcile', job_exists: true }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_run_jobs')) {
        return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_query_runs')) {
        return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      }
      if (text.startsWith('select conversation_id from chatbi_query_conversations')) {
        return { rows: [{ conversation_id: 'conversation_reconcile' }], rowCount: 1 }
      }
      if (text.includes('from chatbi_query_runs run')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('insert into chatbi_query_reconciliation_findings')) {
        return { rows: [], rowCount: 0 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const reconciler = createPostgresQueryReconciler({ pool: new ScriptedPool(client) })

    await expect(reconciler.reconcileBatch({ now, limit: 1 }))
      .rejects.toThrow('query reconciliation finding identity conflict')
    const persisted = client.calls.find((call) => call.text.startsWith('insert into chatbi_query_reconciliation_findings'))!
    expect(persisted.text).toContain('identity_json = excluded.identity_json')
    expect(persisted.text).toContain('returning finding_id')
    expect(client.calls.map((call) => call.text)).toContain('ROLLBACK')
    expect(client.calls.map((call) => call.text)).not.toContain('COMMIT')
  })

  it('rejects an unbounded caller batch before issuing SQL', async () => {
    const client = new ScriptedClient(async () => await empty())
    const pool = new ScriptedPool(client, [])
    const reconciler = createPostgresQueryReconciler({ pool, maxBatchSize: 20 })

    await expect(reconciler.reconcileBatch({ now, limit: 21 }))
      .rejects.toThrow('limit cannot exceed configured maxBatchSize 20')
    expect(pool.calls).toEqual([])
  })

  it('skips the candidate when a job appears after the unlocked identity read', async () => {
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.startsWith('select run.conversation_id')) {
        return { rows: [{ conversation_id: 'conversation_reconcile', job_exists: false }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_query_runs')) {
        return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      }
      if (text.startsWith('select exists(') && text.includes('from chatbi_run_jobs')) {
        return { rows: [{ job_exists: true }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const reconciler = createPostgresQueryReconciler({ pool: new ScriptedPool(client) })

    await expect(reconciler.reconcileBatch({ now, limit: 1 })).resolves.toEqual({
      scanned: 1,
      repaired: 0,
      alerted: 0,
      findings: [],
    })
    expect(client.calls.some((call) => call.text.startsWith('update '))).toBe(false)
    expect(client.calls.some((call) => call.text.startsWith('insert into chatbi_query_reconciliation_findings'))).toBe(false)
  })

  it('persists an orphaned Conversation alert without requiring a Conversation FK row', async () => {
    const state = row({
      conversation_tenant_id: null,
      conversation_workspace_id: null,
      active_run_id: null,
      job_tenant_id: null,
      job_workspace_id: null,
      job_status: null,
      job_attempt: null,
      job_fence: null,
      lease_expires_at: null,
    })
    const client = new ScriptedClient(async (text, values) => {
      if (text === 'BEGIN' || text === 'COMMIT') return await empty()
      if (text.startsWith('select run.conversation_id')) {
        return { rows: [{ conversation_id: 'conversation_reconcile', job_exists: false }], rowCount: 1 }
      }
      if (text.startsWith('select run_id from chatbi_query_runs')) {
        return { rows: [{ run_id: 'run_reconcile' }], rowCount: 1 }
      }
      if (text.startsWith('select exists(') && text.includes('from chatbi_run_jobs')) {
        return { rows: [{ job_exists: false }], rowCount: 1 }
      }
      if (text.startsWith('select conversation_id from chatbi_query_conversations')) return await empty()
      if (text.startsWith('select exists(') && text.includes('from chatbi_query_conversations')) {
        return { rows: [{ conversation_exists: false }], rowCount: 1 }
      }
      if (text.includes('from chatbi_query_runs run')) return { rows: [state], rowCount: 1 }
      if (text.startsWith('insert into chatbi_query_reconciliation_findings')) {
        return { rows: [{ finding_id: values?.[0] }], rowCount: 1 }
      }
      throw new Error(`unexpected SQL: ${text}`)
    })
    const reconciler = createPostgresQueryReconciler({ pool: new ScriptedPool(client) })

    const report = await reconciler.reconcileBatch({ now, limit: 1 })

    expect(report.findings).toMatchObject([{ code: 'missing_conversation', disposition: 'alerted' }])
    const persisted = client.calls.find((call) => call.text.startsWith('insert into chatbi_query_reconciliation_findings'))!
    expect(persisted.values?.[1]).toBe(
      '["query_reconciliation_identity.v2","tenant_demo","workspace_sales","run_reconcile","conversation_reconcile","missing_conversation","completed","succeeded",null,[2,"result_1"]]',
    )
    expect(persisted.values?.[5]).toBe('conversation_reconcile')
  })

  it('ships durable deduplicated finding storage for alerts and repair evidence', () => {
    const migration = readFileSync(
      new URL('../../scripts/postgres/005-query-reconciler.sql', import.meta.url),
      'utf8',
    )

    expect(migration).toContain('create table if not exists chatbi_query_reconciliation_findings')
    expect(migration).toContain('finding_id text primary key')
    expect(migration).toContain("finding_id ~ '^qrf:v2:sha256:[0-9a-f]{64}$'")
    expect(migration).toContain("identity_schema = 'query_reconciliation_identity.v2'")
    expect(migration).toContain('unique (identity_schema, identity_json)')
    expect(migration).toContain("disposition in ('alerted', 'repaired')")
    expect(migration).toContain('occurrence_count')
    expect(migration).toContain('repaired_at')
    expect(migration).not.toContain('references chatbi_query_conversations')
  })
})
