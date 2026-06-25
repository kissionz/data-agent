import { describe, expect, it } from 'vitest'
import { createChatBiApplicationService } from '../application'
import { createFileChatBiPersistence } from '../persistence/file'
import { createInMemoryChatBiPersistence } from '../persistence/memory'
import {
  CHATBI_SQL_MIGRATION,
  createSqlChatBiPersistence,
  migrateChatBiSqlPersistence,
  type SqlPersistenceClient,
} from '../persistence/sql'
import type { ActorContext } from '../contracts'

const actor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

describe('ChatBI persistence ports', () => {
  it('lets multiple application service instances share the same persistence adapter', () => {
    const persistence = createInMemoryChatBiPersistence()
    const firstService = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence,
    })
    const created = firstService.submitQuestion({
      idempotencyKey: 'persisted_run',
      conversationId: 'conversation_persisted',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected persisted run')

    const secondService = createChatBiApplicationService({
      now: () => '2026-06-23T09:01:00+08:00',
      persistence,
    })
    const loaded = secondService.getRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) throw new Error('expected loaded run')
    expect(loaded.data.runId).toBe(created.data.runId)
    expect(loaded.data.audit.map((event) => event.type)).toContain('result.ready')
  })

  it('stores idempotency keys in the persistence adapter', () => {
    const persistence = createInMemoryChatBiPersistence()
    const service = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence,
    })
    const first = service.submitQuestion({
      idempotencyKey: 'same_persistent_key',
      conversationId: 'conversation_idempotent_persisted',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    const second = service.submitQuestion({
      idempotencyKey: 'same_persistent_key',
      conversationId: 'conversation_idempotent_persisted',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })

    expect(first.ok && second.ok && first.data.runId === second.data.runId).toBe(true)
    expect(persistence.getRunIdByIdempotencyKey('same_persistent_key')).toBe(first.ok ? first.data.runId : undefined)
  })

  it('returns cloned records so callers cannot mutate stored state by reference', () => {
    const persistence = createInMemoryChatBiPersistence()
    const service = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence,
    })
    const created = service.submitQuestion({
      idempotencyKey: 'clone_guard',
      conversationId: 'conversation_clone_guard',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected run')
    const record = persistence.getRun(created.data.runId)
    if (!record?.run.result) throw new Error('expected stored result')
    record.run.result.rows[0].values.net_revenue = 0

    const loadedAgain = persistence.getRun(created.data.runId)
    expect(loadedAgain?.run.result?.rows[0].values.net_revenue).toBe(1184000)
  })

  it('lists audit events by run id without exposing missing runs as errors', () => {
    const persistence = createInMemoryChatBiPersistence()
    const service = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence,
    })
    const created = service.submitQuestion({
      idempotencyKey: 'audit_list',
      conversationId: 'conversation_audit_list',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected run')
    expect(persistence.listAuditEvents(created.data.runId).map((event) => event.type)).toEqual([
      'question.accepted',
      'planner.ir_created',
      'compiler.plan_created',
      'query.started',
      'query.completed',
      'result.ready',
    ])
    expect(persistence.listAuditEvents('missing')).toEqual([])
  })

  it('persists runs to a local JSON file that a new adapter instance can read', () => {
    const filePath = `/private/tmp/chatbi-persistence-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    const firstPersistence = createFileChatBiPersistence(filePath)
    const firstService = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence: firstPersistence,
    })
    const created = firstService.submitQuestion({
      idempotencyKey: 'file_persisted_run',
      conversationId: 'conversation_file_persisted',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected persisted file run')

    const secondPersistence = createFileChatBiPersistence(filePath)
    const secondService = createChatBiApplicationService({
      now: () => '2026-06-23T09:05:00+08:00',
      persistence: secondPersistence,
    })
    const loaded = secondService.getRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) throw new Error('expected loaded file run')
    expect(loaded.data.runId).toBe(created.data.runId)
    expect(secondPersistence.getRunIdByIdempotencyKey('file_persisted_run')).toBe(created.data.runId)
    expect(secondPersistence.listAuditEvents(created.data.runId).map((event) => event.type)).toContain('result.ready')
  })

  it('uses cloned file records so caller mutations do not leak back into disk state', () => {
    const filePath = `/private/tmp/chatbi-persistence-clone-${Date.now()}-${Math.random().toString(16).slice(2)}.json`
    const persistence = createFileChatBiPersistence(filePath)
    const service = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence,
    })
    const created = service.submitQuestion({
      idempotencyKey: 'file_clone_guard',
      conversationId: 'conversation_file_clone_guard',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected file run')
    const record = persistence.getRun(created.data.runId)
    if (!record?.run.result) throw new Error('expected result')
    record.run.result.rows[0].values.net_revenue = 0

    const freshAdapter = createFileChatBiPersistence(filePath)
    expect(freshAdapter.getRun(created.data.runId)?.run.result?.rows[0].values.net_revenue).toBe(1184000)
  })

  it('defines a production-shaped SQL migration for conversations, runs, idempotency and audit tables', () => {
    const client = new FakeSqlClient()
    migrateChatBiSqlPersistence(client)

    expect(client.executedStatements.join('\n')).toContain('create table if not exists chatbi_conversations')
    expect(client.executedStatements.join('\n')).toContain('create table if not exists chatbi_runs')
    expect(client.executedStatements.join('\n')).toContain('create table if not exists chatbi_idempotency')
    expect(client.executedStatements.join('\n')).toContain('create table if not exists chatbi_audit_events')
    expect(CHATBI_SQL_MIGRATION.length).toBeGreaterThanOrEqual(6)
  })

  it('persists runs through the SQL adapter and stores audit events in their own table', () => {
    const client = new FakeSqlClient()
    migrateChatBiSqlPersistence(client)
    const firstPersistence = createSqlChatBiPersistence(client)
    const firstService = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence: firstPersistence,
    })
    const created = firstService.submitQuestion({
      idempotencyKey: 'sql_persisted_run',
      conversationId: 'conversation_sql_persisted',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected sql persisted run')

    const secondPersistence = createSqlChatBiPersistence(client)
    const secondService = createChatBiApplicationService({
      now: () => '2026-06-23T09:05:00+08:00',
      persistence: secondPersistence,
    })
    const loaded = secondService.getRun({
      runId: created.data.runId,
      conversationId: created.data.conversationId,
      actor,
    })

    expect(loaded.ok).toBe(true)
    if (!loaded.ok) throw new Error('expected loaded sql run')
    expect(loaded.data.runId).toBe(created.data.runId)
    expect(secondPersistence.getRunIdByIdempotencyKey('sql_persisted_run')).toBe(created.data.runId)
    expect(client.auditEvents.get(created.data.runId)).toHaveLength(6)
    expect(secondPersistence.listAuditEvents(created.data.runId).map((event) => event.type)).toEqual([
      'question.accepted',
      'planner.ir_created',
      'compiler.plan_created',
      'query.started',
      'query.completed',
      'result.ready',
    ])
  })

  it('returns cloned SQL records so caller mutations do not leak back into stored JSON payloads', () => {
    const client = new FakeSqlClient()
    const persistence = createSqlChatBiPersistence(client)
    const service = createChatBiApplicationService({
      now: () => '2026-06-23T09:00:00+08:00',
      persistence,
    })
    const created = service.submitQuestion({
      idempotencyKey: 'sql_clone_guard',
      conversationId: 'conversation_sql_clone_guard',
      question: '过去 12 个月净收入趋势',
      mode: 'trusted',
      actor,
    })
    if (!created.ok) throw new Error('expected sql run')
    const record = persistence.getRun(created.data.runId)
    if (!record?.run.result) throw new Error('expected result')
    record.run.result.rows[0].values.net_revenue = 0

    expect(persistence.getRun(created.data.runId)?.run.result?.rows[0].values.net_revenue).toBe(1184000)
  })
})

class FakeSqlClient implements SqlPersistenceClient {
  executedStatements: string[] = []
  conversations = new Map<string, Record<string, unknown>>()
  runs = new Map<string, Record<string, unknown>>()
  idempotency = new Map<string, Record<string, unknown>>()
  auditEvents = new Map<string, Array<Record<string, unknown>>>()

  execute(statement: string, params: Record<string, unknown> = {}): void {
    this.executedStatements.push(statement)
    if (statement.startsWith('insert into chatbi_conversations')) {
      this.conversations.set(String(params.id), { ...params })
      return
    }
    if (statement.startsWith('insert into chatbi_runs')) {
      this.runs.set(String(params.id), { ...params })
      return
    }
    if (statement.startsWith('insert into chatbi_idempotency')) {
      this.idempotency.set(String(params.idempotency_key), { ...params })
      return
    }
    if (statement.startsWith('delete from chatbi_audit_events')) {
      this.auditEvents.set(String(params.run_id), [])
      return
    }
    if (statement.startsWith('insert into chatbi_audit_events')) {
      const runId = String(params.run_id)
      this.auditEvents.set(runId, [...(this.auditEvents.get(runId) ?? []), { ...params }])
    }
  }

  queryOne<T>(statement: string, params: Record<string, unknown> = {}): T | undefined {
    if (statement.includes('from chatbi_conversations')) return this.conversations.get(String(params.id)) as T | undefined
    if (statement.includes('from chatbi_runs')) return this.runs.get(String(params.id)) as T | undefined
    if (statement.includes('from chatbi_idempotency')) return this.idempotency.get(String(params.idempotency_key)) as T | undefined
    return undefined
  }

  queryMany<T>(statement: string, params: Record<string, unknown> = {}): T[] {
    if (statement.includes('from chatbi_audit_events')) return [...(this.auditEvents.get(String(params.run_id)) ?? [])] as T[]
    return []
  }
}
