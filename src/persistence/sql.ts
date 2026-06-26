import type { Conversation } from '../domain'
import type { AuditEvent } from '../contracts'
import type { ChatBiPersistence, StoredRunRecord } from './ports'
import type { RetentionCleanupPlan } from './retention'

export interface SqlPersistenceClient {
  execute(statement: string, params?: Record<string, unknown>): void
  queryOne<T>(statement: string, params?: Record<string, unknown>): T | undefined
  queryMany<T>(statement: string, params?: Record<string, unknown>): T[]
}

interface ConversationRow {
  payload_json: string
}

interface RunRow {
  payload_json: string
}

interface IdempotencyRow {
  run_id: string
}

interface AuditRow {
  payload_json: string
}

interface MigrationVersionRow {
  version: number
}

export const CHATBI_SQL_MIGRATION_VERSION = 1

export const CHATBI_SQL_MIGRATION_TABLE = `create table if not exists chatbi_schema_migrations (
  version integer primary key,
  name text not null,
  applied_at text not null
)`

export const CHATBI_SQL_MIGRATION = [
  CHATBI_SQL_MIGRATION_TABLE,
  `create table if not exists chatbi_conversations (
  id text primary key,
  tenant_id text not null,
  workspace_id text not null,
  active_run_id text,
  payload_json text not null,
  created_at text not null,
  updated_at text not null
)`,
  `create table if not exists chatbi_runs (
  id text primary key,
  conversation_id text not null,
  tenant_id text not null,
  workspace_id text not null,
  display_status text not null,
  internal_status text not null,
  request_id text not null,
  trace_id text not null,
  executed_query integer not null,
  analysis_ir_json text,
  query_execution_json text,
  payload_json text not null,
  created_at text not null,
  updated_at text not null
)`,
  `create index if not exists chatbi_runs_conversation_idx on chatbi_runs (conversation_id, updated_at)`,
  `create table if not exists chatbi_idempotency (
  idempotency_key text primary key,
  run_id text not null,
  created_at text not null
)`,
  `create table if not exists chatbi_audit_events (
  id text primary key,
  run_id text not null,
  type text not null,
  actor_user_id text not null,
  tenant_id text not null,
  workspace_id text not null,
  at text not null,
  payload_json text not null
)`,
  `create index if not exists chatbi_audit_events_run_idx on chatbi_audit_events (run_id, at)`,
  `create index if not exists chatbi_audit_events_scope_idx on chatbi_audit_events (tenant_id, workspace_id, type, at)`,
  `create table if not exists chatbi_result_blobs (
  id text primary key,
  run_id text not null,
  tenant_id text not null,
  workspace_id text not null,
  classification text not null,
  payload_ref text not null,
  created_at text not null
)`,
  `create index if not exists chatbi_result_blobs_retention_idx on chatbi_result_blobs (tenant_id, workspace_id, created_at)`,
  `create table if not exists chatbi_data_samples (
  id text primary key,
  data_source_id text not null,
  tenant_id text not null,
  workspace_id text not null,
  classification text not null,
  payload_ref text not null,
  created_at text not null
)`,
  `create index if not exists chatbi_data_samples_retention_idx on chatbi_data_samples (tenant_id, workspace_id, created_at)`,
] as const

export interface ChatBiSqlMigration {
  version: number
  name: string
  statements: readonly string[]
}

export interface ChatBiSqlMigrationResult {
  appliedVersions: number[]
  skippedVersions: number[]
  executedStatements: number
  latestVersion: number
}

export interface ExecutedRetentionCleanup {
  dataClass: RetentionCleanupPlan['items'][number]['dataClass']
  table: RetentionCleanupPlan['items'][number]['table']
  statement: string
  params: Record<string, string | number>
}

export const CHATBI_SQL_MIGRATIONS: readonly ChatBiSqlMigration[] = [
  {
    version: CHATBI_SQL_MIGRATION_VERSION,
    name: 'chatbi_core_persistence',
    statements: CHATBI_SQL_MIGRATION,
  },
]

export function migrateChatBiSqlPersistence(client: SqlPersistenceClient): void {
  CHATBI_SQL_MIGRATION.forEach((statement) => client.execute(statement))
}

export function runChatBiSqlMigrations(
  client: SqlPersistenceClient,
  migrations: readonly ChatBiSqlMigration[] = CHATBI_SQL_MIGRATIONS,
  appliedAt = new Date(0).toISOString(),
): ChatBiSqlMigrationResult {
  client.execute(CHATBI_SQL_MIGRATION_TABLE)
  const appliedRows = client.queryMany<MigrationVersionRow>('select version from chatbi_schema_migrations order by version asc')
  const applied = new Set(appliedRows.map((row) => Number(row.version)))
  const result: ChatBiSqlMigrationResult = {
    appliedVersions: [],
    skippedVersions: [],
    executedStatements: 0,
    latestVersion: appliedRows.reduce((latest, row) => Math.max(latest, Number(row.version)), 0),
  }

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) {
      result.skippedVersions.push(migration.version)
      result.latestVersion = Math.max(result.latestVersion, migration.version)
      continue
    }
    migration.statements.forEach((statement) => {
      client.execute(statement)
      result.executedStatements += 1
    })
    client.execute(`insert into chatbi_schema_migrations (
  version, name, applied_at
) values (
  :version, :name, :applied_at
) on conflict (version) do nothing`, {
      version: migration.version,
      name: migration.name,
      applied_at: appliedAt,
    })
    result.executedStatements += 1
    result.appliedVersions.push(migration.version)
    result.latestVersion = Math.max(result.latestVersion, migration.version)
    applied.add(migration.version)
  }

  return result
}

export function executeRetentionCleanupPlan(
  client: SqlPersistenceClient,
  plan: RetentionCleanupPlan,
): ExecutedRetentionCleanup[] {
  return plan.sqlStatements.map((statement, index) => {
    client.execute(statement.statement, statement.params)
    const item = plan.items[index]
    return {
      dataClass: item.dataClass,
      table: item.table,
      statement: statement.statement,
      params: statement.params,
    }
  })
}

export function createSqlChatBiPersistence(client: SqlPersistenceClient): ChatBiPersistence {
  return {
    getConversation(conversationId) {
      const row = client.queryOne<ConversationRow>(
        'select payload_json from chatbi_conversations where id = :id',
        { id: conversationId },
      )
      return row ? clone(parseJson<Conversation>(row.payload_json)) : undefined
    },
    saveConversation(conversation) {
      client.execute(`insert into chatbi_conversations (
  id, tenant_id, workspace_id, active_run_id, payload_json, created_at, updated_at
) values (
  :id, :tenant_id, :workspace_id, :active_run_id, :payload_json, :created_at, :updated_at
) on conflict (id) do update set
  tenant_id = excluded.tenant_id,
  workspace_id = excluded.workspace_id,
  active_run_id = excluded.active_run_id,
  payload_json = excluded.payload_json,
  updated_at = excluded.updated_at`, {
        id: conversation.id,
        tenant_id: conversation.tenantId,
        workspace_id: conversation.workspaceId,
        active_run_id: conversation.activeRunId ?? null,
        payload_json: stringify(conversation),
        created_at: conversation.createdAt,
        updated_at: conversation.updatedAt,
      })
    },
    getRun(runId) {
      const row = client.queryOne<RunRow>(
        'select payload_json from chatbi_runs where id = :id',
        { id: runId },
      )
      return row ? clone(parseJson<StoredRunRecord>(row.payload_json)) : undefined
    },
    saveRun(record) {
      client.execute(`insert into chatbi_runs (
  id, conversation_id, tenant_id, workspace_id, display_status, internal_status,
  request_id, trace_id, executed_query, analysis_ir_json, query_execution_json,
  payload_json, created_at, updated_at
) values (
  :id, :conversation_id, :tenant_id, :workspace_id, :display_status, :internal_status,
  :request_id, :trace_id, :executed_query, :analysis_ir_json, :query_execution_json,
  :payload_json, :created_at, :updated_at
) on conflict (id) do update set
  display_status = excluded.display_status,
  internal_status = excluded.internal_status,
  request_id = excluded.request_id,
  trace_id = excluded.trace_id,
  executed_query = excluded.executed_query,
  analysis_ir_json = excluded.analysis_ir_json,
  query_execution_json = excluded.query_execution_json,
  payload_json = excluded.payload_json,
  updated_at = excluded.updated_at`, {
        id: record.run.id,
        conversation_id: record.run.conversationId,
        tenant_id: record.run.tenantId,
        workspace_id: record.run.workspaceId,
        display_status: record.run.displayStatus,
        internal_status: record.run.internalStatus,
        request_id: record.requestId,
        trace_id: record.traceId,
        executed_query: record.executedQuery ? 1 : 0,
        analysis_ir_json: record.analysisIr ? stringify(record.analysisIr) : null,
        query_execution_json: record.queryExecution ? stringify(record.queryExecution) : null,
        payload_json: stringify(record),
        created_at: record.run.createdAt,
        updated_at: record.run.updatedAt,
      })
      client.execute('delete from chatbi_audit_events where run_id = :run_id', { run_id: record.run.id })
      record.audit.forEach((event) => saveAuditEvent(client, record.run.id, event))
    },
    getRunIdByIdempotencyKey(idempotencyKey) {
      const row = client.queryOne<IdempotencyRow>(
        'select run_id from chatbi_idempotency where idempotency_key = :idempotency_key',
        { idempotency_key: idempotencyKey },
      )
      return row?.run_id
    },
    saveIdempotencyKey(idempotencyKey, runId) {
      client.execute(`insert into chatbi_idempotency (
  idempotency_key, run_id, created_at
) values (
  :idempotency_key, :run_id, :created_at
) on conflict (idempotency_key) do update set run_id = excluded.run_id`, {
        idempotency_key: idempotencyKey,
        run_id: runId,
        created_at: new Date(0).toISOString(),
      })
    },
    listAuditEvents(runId) {
      return client.queryMany<AuditRow>(
        'select payload_json from chatbi_audit_events where run_id = :run_id order by at asc',
        { run_id: runId },
      ).map((row) => clone(parseJson<AuditEvent>(row.payload_json)))
    },
  }
}

function saveAuditEvent(client: SqlPersistenceClient, runId: string, event: AuditEvent) {
  client.execute(`insert into chatbi_audit_events (
  id, run_id, type, actor_user_id, tenant_id, workspace_id, at, payload_json
) values (
  :id, :run_id, :type, :actor_user_id, :tenant_id, :workspace_id, :at, :payload_json
)`, {
    id: event.id,
    run_id: runId,
    type: event.type,
    actor_user_id: event.actorUserId,
    tenant_id: event.tenantId,
    workspace_id: event.workspaceId,
    at: event.at,
    payload_json: stringify(event),
  })
}

function stringify(value: unknown): string {
  return JSON.stringify(value)
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function clone<T>(value: T): T {
  if (value === undefined) return value
  return structuredClone(value)
}
