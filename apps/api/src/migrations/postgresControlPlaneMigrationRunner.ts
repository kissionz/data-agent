import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

interface PgResult<Row = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
}

export interface PostgresMigrationClientLike {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresMigrationPoolLike {
  connect(): Promise<PostgresMigrationClientLike>
  end?(): Promise<void>
}

export interface PostgresControlPlaneMigration {
  version: number
  name: string
  sql: string
  checksum: string
}

export interface PostgresControlPlaneMigrationResult {
  appliedVersions: number[]
  skippedVersions: number[]
  latestVersion: number
}

export type PostgresMigrationErrorCode =
  | 'MIGRATION_DEFINITION_INVALID'
  | 'MIGRATION_CHECKSUM_MISMATCH'
  | 'MIGRATION_FUTURE_VERSION'
  | 'MIGRATION_LEDGER_INVALID'
  | 'MIGRATION_SCHEMA_INVALID'
  | 'MIGRATION_LOCK_FAILED'
  | 'MIGRATION_FAILED'

export class PostgresMigrationError extends Error {
  constructor(readonly code: PostgresMigrationErrorCode, message: string) {
    super(message)
    this.name = 'PostgresMigrationError'
  }
}

interface AppliedMigrationRow {
  version: number | string
  name: string
  checksum: string
}

const ADVISORY_LOCK_KEY = '7410042001'

const requiredControlPlaneRelations = [
  'chatbi_schema_migrations',
  'chatbi_run_jobs',
  'chatbi_run_job_attempts',
  'chatbi_result_pages',
  'chatbi_result_manifests',
  'chatbi_run_event_streams',
  'chatbi_run_events',
  'chatbi_query_conversations',
  'chatbi_query_runs',
  'chatbi_query_idempotency',
  'chatbi_query_audit_events',
  'chatbi_query_reconciliation_findings',
  'chatbi_query_outbox',
  'chatbi_query_outbox_attempts',
] as const

const requiredControlPlaneTriggers = [
  {
    relation: 'chatbi_result_manifests',
    trigger: 'chatbi_result_manifests_immutable',
  },
  {
    relation: 'chatbi_result_pages',
    trigger: 'chatbi_result_pages_published_immutable',
  },
] as const

const requiredOutboxColumns = [
  ...[
    'event_id',
    'tenant_id',
    'workspace_id',
    'aggregate_type',
    'aggregate_id',
    'topic',
    'payload_fingerprint',
    'payload_json',
    'status',
    'attempt',
    'max_attempts',
    'fence',
    'occurred_at',
    'available_at',
    'lease_owner',
    'lease_token_hash',
    'lease_expires_at',
    'published_at',
    'dead_lettered_at',
    'publication_fingerprint',
    'last_failure_json',
    'terminal_kind',
    'terminal_attempt',
    'terminal_fence',
    'terminal_publisher_id',
    'terminal_lease_token_hash',
    'terminal_fingerprint',
    'created_at',
    'updated_at',
  ].map((column) => ({ relation: 'chatbi_query_outbox', column })),
  ...[
    'event_id',
    'tenant_id',
    'workspace_id',
    'attempt',
    'fence',
    'publisher_id',
    'lease_token_hash',
    'started_at',
    'lease_expires_at',
    'ended_at',
    'outcome',
    'failure_json',
  ].map((column) => ({ relation: 'chatbi_query_outbox_attempts', column })),
] as const

const requiredOutboxIndexes = [
  'chatbi_query_outbox_claim_idx',
  'chatbi_query_outbox_expired_lease_idx',
  'chatbi_query_outbox_scope_idx',
  'chatbi_query_outbox_attempts_scope_idx',
] as const

const requiredOutboxConstraints = [
  ...[
    'chatbi_query_outbox_pkey',
    'chatbi_query_outbox_aggregate_type_check',
    'chatbi_query_outbox_attempt_check',
    'chatbi_query_outbox_max_attempts_check',
    'chatbi_query_outbox_fence_check',
    'chatbi_query_outbox_scope_event_key',
    'chatbi_query_outbox_status_check',
    'chatbi_query_outbox_payload_fingerprint_check',
    'chatbi_query_outbox_available_time_check',
    'chatbi_query_outbox_lease_shape_check',
    'chatbi_query_outbox_terminal_shape_check',
    'chatbi_query_outbox_terminal_metadata_check',
  ].map((constraint) => ({ relation: 'chatbi_query_outbox', constraint })),
  ...[
    'chatbi_query_outbox_attempts_pkey',
    'chatbi_query_outbox_attempts_event_fence_key',
    'chatbi_query_outbox_attempts_attempt_check',
    'chatbi_query_outbox_attempts_fence_check',
    'chatbi_query_outbox_attempts_lease_token_hash_check',
    'chatbi_query_outbox_attempts_outcome_check',
    'chatbi_query_outbox_attempts_scope_event_fk',
    'chatbi_query_outbox_attempts_terminal_shape_check',
  ].map((constraint) => ({ relation: 'chatbi_query_outbox_attempts', constraint })),
] as const

const migrationFiles = [
  {
    version: 1,
    name: '001-control-plane-baseline',
    url: new URL('../../../../scripts/postgres/001-control-plane-baseline.sql', import.meta.url),
  },
  { version: 2, name: '002-control-plane', url: new URL('../../../../scripts/postgres/control-plane.sql', import.meta.url) },
  { version: 3, name: '003-result-event-store', url: new URL('../../../../scripts/postgres/result-event-store.sql', import.meta.url) },
  { version: 4, name: '004-query-control-plane', url: new URL('../../../../scripts/postgres/query-control-plane.sql', import.meta.url) },
  { version: 5, name: '005-query-reconciler', url: new URL('../../../../scripts/postgres/005-query-reconciler.sql', import.meta.url) },
  { version: 6, name: '006-query-outbox', url: new URL('../../../../scripts/postgres/006-query-outbox.sql', import.meta.url) },
] as const

interface ExpectedColumnDefinition {
  relationName: string
  columnName: string
  dataType: string
  notNull: boolean
  defaultDefinition: string | null
}

interface ExpectedIndexDefinition {
  relationName: string
  indexName: string
  unique: boolean
  keyDefinitions: string[]
  predicateDefinition: string
}

interface ExpectedConstraintDefinition {
  relationName: string
  constraintName: string
  kind: 'c' | 'p' | 'u' | 'f'
  localColumns: string[]
  definitionSignature: string | null
  targetRelation: string | null
  targetColumns: string[]
  deleteAction: 'a' | 'c'
}

interface ExpectedTriggerDefinition {
  relationName: string
  triggerName: string
  functionName: string
  functionSourceSignature: string
}

const expectedOutboxColumnDefinitions: readonly ExpectedColumnDefinition[] = [
  expectedColumn('chatbi_query_outbox', 'event_id', 'text', true),
  expectedColumn('chatbi_query_outbox', 'tenant_id', 'text', true),
  expectedColumn('chatbi_query_outbox', 'workspace_id', 'text', true),
  expectedColumn('chatbi_query_outbox', 'aggregate_type', 'text', true),
  expectedColumn('chatbi_query_outbox', 'aggregate_id', 'text', true),
  expectedColumn('chatbi_query_outbox', 'topic', 'text', true),
  expectedColumn('chatbi_query_outbox', 'payload_fingerprint', 'text', true),
  expectedColumn('chatbi_query_outbox', 'payload_json', 'jsonb', true),
  expectedColumn('chatbi_query_outbox', 'status', 'text', true, "'pending'::text"),
  expectedColumn('chatbi_query_outbox', 'attempt', 'integer', true, '0'),
  expectedColumn('chatbi_query_outbox', 'max_attempts', 'integer', true),
  expectedColumn('chatbi_query_outbox', 'fence', 'bigint', true, '0'),
  expectedColumn('chatbi_query_outbox', 'occurred_at', 'timestamp with time zone', true),
  expectedColumn('chatbi_query_outbox', 'available_at', 'timestamp with time zone', true),
  expectedColumn('chatbi_query_outbox', 'lease_owner', 'text', false),
  expectedColumn('chatbi_query_outbox', 'lease_token_hash', 'text', false),
  expectedColumn('chatbi_query_outbox', 'lease_expires_at', 'timestamp with time zone', false),
  expectedColumn('chatbi_query_outbox', 'published_at', 'timestamp with time zone', false),
  expectedColumn('chatbi_query_outbox', 'dead_lettered_at', 'timestamp with time zone', false),
  expectedColumn('chatbi_query_outbox', 'publication_fingerprint', 'text', false),
  expectedColumn('chatbi_query_outbox', 'last_failure_json', 'jsonb', false),
  expectedColumn('chatbi_query_outbox', 'terminal_kind', 'text', false),
  expectedColumn('chatbi_query_outbox', 'terminal_attempt', 'integer', false),
  expectedColumn('chatbi_query_outbox', 'terminal_fence', 'bigint', false),
  expectedColumn('chatbi_query_outbox', 'terminal_publisher_id', 'text', false),
  expectedColumn('chatbi_query_outbox', 'terminal_lease_token_hash', 'text', false),
  expectedColumn('chatbi_query_outbox', 'terminal_fingerprint', 'text', false),
  expectedColumn('chatbi_query_outbox', 'created_at', 'timestamp with time zone', true),
  expectedColumn('chatbi_query_outbox', 'updated_at', 'timestamp with time zone', true),
  expectedColumn('chatbi_query_outbox_attempts', 'event_id', 'text', true),
  expectedColumn('chatbi_query_outbox_attempts', 'tenant_id', 'text', true),
  expectedColumn('chatbi_query_outbox_attempts', 'workspace_id', 'text', true),
  expectedColumn('chatbi_query_outbox_attempts', 'attempt', 'integer', true),
  expectedColumn('chatbi_query_outbox_attempts', 'fence', 'bigint', true),
  expectedColumn('chatbi_query_outbox_attempts', 'publisher_id', 'text', true),
  expectedColumn('chatbi_query_outbox_attempts', 'lease_token_hash', 'text', true),
  expectedColumn('chatbi_query_outbox_attempts', 'started_at', 'timestamp with time zone', true),
  expectedColumn('chatbi_query_outbox_attempts', 'lease_expires_at', 'timestamp with time zone', true),
  expectedColumn('chatbi_query_outbox_attempts', 'ended_at', 'timestamp with time zone', false),
  expectedColumn('chatbi_query_outbox_attempts', 'outcome', 'text', false),
  expectedColumn('chatbi_query_outbox_attempts', 'failure_json', 'jsonb', false),
] as const

const expectedOutboxIndexDefinitions: readonly ExpectedIndexDefinition[] = [
  expectedIndex(
    'chatbi_query_outbox',
    'chatbi_query_outbox_claim_idx',
    ['available_at', 'occurred_at', 'event_id'],
    "status = any(array['pending', 'retry_wait']::text[])",
  ),
  expectedIndex(
    'chatbi_query_outbox',
    'chatbi_query_outbox_expired_lease_idx',
    ['lease_expires_at', 'event_id'],
    "status = 'leased'::text",
  ),
  expectedIndex(
    'chatbi_query_outbox',
    'chatbi_query_outbox_scope_idx',
    ['tenant_id', 'workspace_id', 'status', 'updated_at desc'],
  ),
  expectedIndex(
    'chatbi_query_outbox_attempts',
    'chatbi_query_outbox_attempts_scope_idx',
    ['tenant_id', 'workspace_id', 'started_at desc'],
  ),
] as const

const outboxMigrationSql = readFileSync(migrationFiles[5].url, 'utf8')
const resultEventStoreMigrationSql = readFileSync(migrationFiles[2].url, 'utf8')

const expectedOutboxConstraintDefinitions: readonly ExpectedConstraintDefinition[] = [
  expectedKeyConstraint(
    'chatbi_query_outbox',
    'chatbi_query_outbox_pkey',
    'p',
    ['event_id'],
  ),
  expectedKeyConstraint(
    'chatbi_query_outbox',
    'chatbi_query_outbox_scope_event_key',
    'u',
    ['tenant_id', 'workspace_id', 'event_id'],
  ),
  ...[
    'chatbi_query_outbox_aggregate_type_check',
    'chatbi_query_outbox_attempt_check',
    'chatbi_query_outbox_max_attempts_check',
    'chatbi_query_outbox_fence_check',
    'chatbi_query_outbox_status_check',
    'chatbi_query_outbox_payload_fingerprint_check',
    'chatbi_query_outbox_available_time_check',
    'chatbi_query_outbox_lease_shape_check',
    'chatbi_query_outbox_terminal_shape_check',
    'chatbi_query_outbox_terminal_metadata_check',
  ].map((constraintName) => expectedCheckConstraint(
    'chatbi_query_outbox',
    constraintName,
    extractNamedCheckExpression(outboxMigrationSql, constraintName),
  )),
  expectedKeyConstraint(
    'chatbi_query_outbox_attempts',
    'chatbi_query_outbox_attempts_pkey',
    'p',
    ['event_id', 'attempt'],
  ),
  expectedKeyConstraint(
    'chatbi_query_outbox_attempts',
    'chatbi_query_outbox_attempts_event_fence_key',
    'u',
    ['event_id', 'fence'],
  ),
  ...[
    'chatbi_query_outbox_attempts_attempt_check',
    'chatbi_query_outbox_attempts_fence_check',
    'chatbi_query_outbox_attempts_lease_token_hash_check',
    'chatbi_query_outbox_attempts_outcome_check',
  ].map((constraintName) => expectedCheckConstraint(
    'chatbi_query_outbox_attempts',
    constraintName,
    extractNamedCheckExpression(outboxMigrationSql, constraintName),
  )),
  expectedForeignKeyConstraint(
    'chatbi_query_outbox_attempts',
    'chatbi_query_outbox_attempts_scope_event_fk',
    ['tenant_id', 'workspace_id', 'event_id'],
    'chatbi_query_outbox',
    ['tenant_id', 'workspace_id', 'event_id'],
    'c',
  ),
  expectedCheckConstraint(
    'chatbi_query_outbox_attempts',
    'chatbi_query_outbox_attempts_terminal_shape_check',
    extractNamedCheckExpression(outboxMigrationSql, 'chatbi_query_outbox_attempts_terminal_shape_check'),
  ),
] as const

const expectedTriggerDefinitions: readonly ExpectedTriggerDefinition[] = [
  {
    relationName: 'chatbi_result_manifests',
    triggerName: 'chatbi_result_manifests_immutable',
    functionName: 'chatbi_reject_published_result_mutation',
    functionSourceSignature: functionSourceSignature(extractFunctionSource(
      resultEventStoreMigrationSql,
      'chatbi_reject_published_result_mutation',
    )),
  },
  {
    relationName: 'chatbi_result_pages',
    triggerName: 'chatbi_result_pages_published_immutable',
    functionName: 'chatbi_reject_published_page_mutation',
    functionSourceSignature: functionSourceSignature(extractFunctionSource(
      resultEventStoreMigrationSql,
      'chatbi_reject_published_page_mutation',
    )),
  },
] as const

export const POSTGRES_SCHEMA_MIGRATIONS_TABLE = `create table if not exists chatbi_schema_migrations (
  version integer primary key,
  name text not null,
  checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null
)`

export function loadPostgresControlPlaneMigrations(): PostgresControlPlaneMigration[] {
  return migrationFiles.map((migration) => {
    const sql = readFileSync(migration.url, 'utf8')
    return {
      version: migration.version,
      name: migration.name,
      sql,
      checksum: checksum(sql),
    }
  })
}

export async function runPostgresControlPlaneMigrations(
  pool: PostgresMigrationPoolLike,
  migrations: readonly PostgresControlPlaneMigration[] = loadPostgresControlPlaneMigrations(),
): Promise<PostgresControlPlaneMigrationResult> {
  const ordered = validateMigrations(migrations)
  let client: PostgresMigrationClientLike
  try {
    client = await pool.connect()
  } catch {
    throw new PostgresMigrationError('MIGRATION_FAILED', 'Control-plane migration database is unavailable')
  }
  let lockHeld = false
  let destroyConnection = false
  try {
    try {
      const locked = await client.query<{ locked: boolean }>(
        'select pg_try_advisory_lock($1::bigint) as locked',
        [ADVISORY_LOCK_KEY],
      )
      if (locked.rows[0]?.locked !== true) {
        throw new PostgresMigrationError(
          'MIGRATION_LOCK_FAILED',
          'Another control-plane migration process currently holds the lock',
        )
      }
      lockHeld = true
      await client.query(POSTGRES_SCHEMA_MIGRATIONS_TABLE)
    } catch (error) {
      if (error instanceof PostgresMigrationError) throw error
      destroyConnection = true
      throw new PostgresMigrationError('MIGRATION_LOCK_FAILED', 'Could not acquire the control-plane migration lock')
    }

    const appliedRows = await client.query<AppliedMigrationRow>(`select version, name, checksum
from chatbi_schema_migrations order by version asc`)
    const normalizedAppliedRows = appliedRows.rows.map((row) => ({
      ...row,
      version: integer(row.version, 'migration version'),
    }))
    const latestKnownVersion = ordered.at(-1)!.version
    if (normalizedAppliedRows.some(({ version }) => version > latestKnownVersion)) {
      throw new PostgresMigrationError(
        'MIGRATION_FUTURE_VERSION',
        `Database schema is newer than this migrator (latest known version ${String(latestKnownVersion).padStart(3, '0')})`,
      )
    }
    const applied = validateAppliedMigrationPrefix(normalizedAppliedRows)
    for (const migration of ordered) {
      const existing = applied.get(migration.version)
      if (!existing) continue
      if (existing.name !== migration.name || existing.checksum !== migration.checksum) {
        throw new PostgresMigrationError(
          'MIGRATION_CHECKSUM_MISMATCH',
          `Applied migration ${formatMigration(migration)} no longer matches its recorded checksum`,
        )
      }
    }
    if (applied.size === 0) await rejectUnmanagedControlPlaneRelations(client)

    const result: PostgresControlPlaneMigrationResult = {
      appliedVersions: [],
      skippedVersions: [],
      latestVersion: normalizedAppliedRows.at(-1)?.version ?? 0,
    }
    for (const migration of ordered) {
      if (applied.has(migration.version)) {
        result.skippedVersions.push(migration.version)
        result.latestVersion = Math.max(result.latestVersion, migration.version)
        continue
      }
      let transactionStarted = false
      try {
        await client.query('BEGIN')
        transactionStarted = true
        await client.query(migration.sql)
        await client.query(`insert into chatbi_schema_migrations (
  version, name, checksum, applied_at
) values ($1, $2, $3, statement_timestamp())`, [
          migration.version,
          migration.name,
          migration.checksum,
        ])
        await client.query('COMMIT')
        transactionStarted = false
      } catch {
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK')
          } catch {
            destroyConnection = true
          }
        }
        throw new PostgresMigrationError(
          'MIGRATION_FAILED',
          `Control-plane migration ${formatMigration(migration)} failed`,
        )
      }
      result.appliedVersions.push(migration.version)
      result.latestVersion = migration.version
      applied.set(migration.version, {
        version: migration.version,
        name: migration.name,
        checksum: migration.checksum,
      })
    }
    await validateControlPlaneSchema(client)
    return result
  } catch (error) {
    if (error instanceof PostgresMigrationError) throw error
    throw new PostgresMigrationError('MIGRATION_FAILED', 'Control-plane migration state could not be inspected')
  } finally {
    if (lockHeld) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>(
          'select pg_advisory_unlock($1::bigint) as unlocked',
          [ADVISORY_LOCK_KEY],
        )
        if (unlocked.rows[0]?.unlocked !== true) destroyConnection = true
      } catch {
        destroyConnection = true
      }
    }
    client.release(destroyConnection || undefined)
  }
}

function validateMigrations(migrations: readonly PostgresControlPlaneMigration[]) {
  const ordered = [...migrations].sort((left, right) => left.version - right.version)
  if (ordered.length === 0 || ordered.some((migration, index) => migration.version !== index + 1)) {
    throw new PostgresMigrationError(
      'MIGRATION_DEFINITION_INVALID',
      'Control-plane migrations must be a contiguous sequence beginning at 001',
    )
  }
  for (const migration of ordered) {
    if (!migration.name.startsWith(String(migration.version).padStart(3, '0'))
      || !migration.sql.trim()
      || migration.checksum !== checksum(migration.sql)) {
      throw new PostgresMigrationError(
        'MIGRATION_DEFINITION_INVALID',
        `Control-plane migration ${formatMigration(migration)} has an invalid name, body, or checksum`,
      )
    }
  }
  return ordered
}

function validateAppliedMigrationPrefix(rows: readonly (AppliedMigrationRow & { version: number })[]) {
  const ordered = [...rows].sort((left, right) => left.version - right.version)
  if (ordered.some((row, index) => row.version !== index + 1)) {
    throw new PostgresMigrationError(
      'MIGRATION_LEDGER_INVALID',
      'Applied control-plane migrations must be a contiguous prefix beginning at 001',
    )
  }
  return new Map(ordered.map((row) => [row.version, row]))
}

async function rejectUnmanagedControlPlaneRelations(client: PostgresMigrationClientLike) {
  const result = await client.query<{ existing_relation_count: number | string }>(`select count(*)::integer as existing_relation_count
from unnest($1::text[]) as expected(relation_name)
where to_regclass(format('%I.%I', current_schema(), expected.relation_name)) is not null`, [
    requiredControlPlaneRelations.filter((relation) => relation !== 'chatbi_schema_migrations'),
  ])
  if (integer(result.rows[0]?.existing_relation_count, 'existing relation count') > 0) {
    throw new PostgresMigrationError(
      'MIGRATION_SCHEMA_INVALID',
      'Control-plane schema contains unmanaged relations',
    )
  }
}

async function validateControlPlaneSchema(client: PostgresMigrationClientLike) {
  const result = await client.query<{
    missing_relation_count: number | string
    missing_trigger_count: number | string
    missing_outbox_column_count: number | string
    missing_outbox_index_count: number | string
    missing_outbox_constraint_count: number | string
  }>(`select
  (
    select count(*)::integer
    from unnest($1::text[]) as expected(relation_name)
    where not exists (
      select 1
      from pg_class
      where oid = to_regclass(format('%I.%I', current_schema(), expected.relation_name))
        and relkind in ('r', 'p')
    )
  ) as missing_relation_count,
  (
    select count(*)::integer
    from unnest($2::text[], $3::text[]) as expected(relation_name, trigger_name)
    where not exists (
      select 1
      from pg_trigger
      where tgrelid = to_regclass(format('%I.%I', current_schema(), expected.relation_name))
        and tgname = expected.trigger_name
        and not tgisinternal
        and tgenabled <> 'D'
    )
  ) as missing_trigger_count,
  (
    select count(*)::integer
    from unnest($4::text[], $5::text[]) as expected(relation_name, column_name)
    where not exists (
      select 1
      from pg_attribute
      where attrelid = to_regclass(format('%I.%I', current_schema(), expected.relation_name))
        and attname = expected.column_name
        and attnum > 0
        and not attisdropped
    )
  ) as missing_outbox_column_count,
  (
    select count(*)::integer
    from unnest($6::text[]) as expected(index_name)
    where to_regclass(format('%I.%I', current_schema(), expected.index_name)) is null
  ) as missing_outbox_index_count,
  (
    select count(*)::integer
    from unnest($7::text[], $8::text[]) as expected(relation_name, constraint_name)
    where not exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass(format('%I.%I', current_schema(), expected.relation_name))
        and conname = expected.constraint_name
        and convalidated
    )
  ) as missing_outbox_constraint_count`, [
    requiredControlPlaneRelations,
    requiredControlPlaneTriggers.map(({ relation }) => relation),
    requiredControlPlaneTriggers.map(({ trigger }) => trigger),
    requiredOutboxColumns.map(({ relation }) => relation),
    requiredOutboxColumns.map(({ column }) => column),
    requiredOutboxIndexes,
    requiredOutboxConstraints.map(({ relation }) => relation),
    requiredOutboxConstraints.map(({ constraint }) => constraint),
  ])
  const row = result.rows[0]
  if (
    integer(row?.missing_relation_count, 'missing relation count') > 0
    || integer(row?.missing_trigger_count, 'missing trigger count') > 0
    || integer(row?.missing_outbox_column_count, 'missing outbox column count') > 0
    || integer(row?.missing_outbox_index_count, 'missing outbox index count') > 0
    || integer(row?.missing_outbox_constraint_count, 'missing outbox constraint count') > 0
  ) {
    throw new PostgresMigrationError(
      'MIGRATION_SCHEMA_INVALID',
      'Control-plane schema validation failed',
    )
  }
  await validateControlPlaneDefinitionSignatures(client)
}

async function validateControlPlaneDefinitionSignatures(client: PostgresMigrationClientLike) {
  const columnDefinitions = await client.query<{ definition_mismatch_count: number | string }>(`with expected as (
  select *
  from jsonb_to_recordset($1::jsonb) as item(
    "relationName" text,
    "columnName" text,
    "dataType" text,
    "notNull" boolean,
    "defaultDefinition" text
  )
), actual as (
  select
    relation.relname as "relationName",
    attribute.attname as "columnName",
    format_type(attribute.atttypid, attribute.atttypmod) as "dataType",
    attribute.attnotnull as "notNull",
    case when default_value.oid is null then null else
      regexp_replace(
        replace(
          replace(lower(pg_get_expr(default_value.adbin, default_value.adrelid, true)), '::text[]', ''),
          '::text',
          ''
        ),
        '[[:space:]()"]+',
        '',
        'g'
      )
    end as "defaultDefinition",
    attribute.attidentity,
    attribute.attgenerated,
    relation.relkind,
    relation.relpersistence,
    relation.relrowsecurity,
    relation.relforcerowsecurity
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_attribute attribute on attribute.attrelid = relation.oid
  left join pg_attrdef default_value
    on default_value.adrelid = relation.oid and default_value.adnum = attribute.attnum
  where namespace.nspname = current_schema()
    and relation.relname in (select distinct "relationName" from expected)
    and attribute.attnum > 0
    and not attribute.attisdropped
), compared as (
  select expected.*, actual.*,
    expected."relationName" is null
      or actual."relationName" is null
      or expected."dataType" <> actual."dataType"
      or expected."notNull" <> actual."notNull"
      or expected."defaultDefinition" is distinct from actual."defaultDefinition"
      or actual.attidentity <> ''
      or actual.attgenerated <> ''
      or actual.relkind <> 'r'
      or actual.relpersistence <> 'p'
      or actual.relrowsecurity
      or actual.relforcerowsecurity as mismatched
  from expected
  full join actual using ("relationName", "columnName")
)
select count(*) filter (where mismatched)::integer as definition_mismatch_count
from compared`, [JSON.stringify(expectedOutboxColumnDefinitions)])

  const indexDefinitions = await client.query<{ definition_mismatch_count: number | string }>(`with expected as (
  select *
  from jsonb_to_recordset($1::jsonb) as item(
    "relationName" text,
    "indexName" text,
    "unique" boolean,
    "keyDefinitions" jsonb,
    "predicateDefinition" text
  )
), actual as (
  select
    relation.relname as "relationName",
    index_relation.relname as "indexName",
    definition.indisunique as "unique",
    (
      select jsonb_agg(
        regexp_replace(lower(pg_get_indexdef(definition.indexrelid, position, true)), '[[:space:]"]+', '', 'g')
        order by position
      )
      from generate_series(1, definition.indnkeyatts) as position
    ) as "keyDefinitions",
    regexp_replace(
      replace(
        replace(lower(coalesce(pg_get_expr(definition.indpred, definition.indrelid, true), '')), '::text[]', ''),
        '::text',
        ''
      ),
      '[[:space:]()"]+',
      '',
      'g'
    ) as "predicateDefinition",
    access_method.amname,
    definition.indisvalid,
    definition.indisready,
    definition.indislive,
    definition.indisprimary,
    definition.indisexclusion,
    definition.indisclustered,
    definition.indnullsnotdistinct,
    definition.indnatts,
    definition.indnkeyatts
  from pg_index definition
  join pg_class index_relation on index_relation.oid = definition.indexrelid
  join pg_class relation on relation.oid = definition.indrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_am access_method on access_method.oid = index_relation.relam
  where namespace.nspname = current_schema()
    and index_relation.relname in (select "indexName" from expected)
), compared as (
  select expected.*, actual.*,
    expected."indexName" is null
      or actual."indexName" is null
      or expected."relationName" <> actual."relationName"
      or expected."unique" <> actual."unique"
      or expected."keyDefinitions" <> actual."keyDefinitions"
      or expected."predicateDefinition" <> actual."predicateDefinition"
      or actual.amname <> 'btree'
      or not actual.indisvalid
      or not actual.indisready
      or not actual.indislive
      or actual.indisprimary
      or actual.indisexclusion
      or actual.indisclustered
      or actual.indnullsnotdistinct
      or actual.indnatts <> actual.indnkeyatts
      or actual.indnkeyatts <> jsonb_array_length(expected."keyDefinitions") as mismatched
  from expected
  full join actual using ("indexName")
)
select count(*) filter (where mismatched)::integer as definition_mismatch_count
from compared`, [JSON.stringify(expectedOutboxIndexDefinitions)])

  const constraintDefinitions = await client.query<{ definition_mismatch_count: number | string }>(`with expected as (
  select *
  from jsonb_to_recordset($1::jsonb) as item(
    "relationName" text,
    "constraintName" text,
    kind "char",
    "localColumns" jsonb,
    "definitionSignature" text,
    "targetRelation" text,
    "targetColumns" jsonb,
    "deleteAction" "char"
  )
), actual as (
  select
    relation.relname as "relationName",
    definition.conname as "constraintName",
    definition.contype as kind,
    (
      select coalesce(jsonb_agg(attribute.attname order by key_position.ordinality), '[]'::jsonb)
      from unnest(definition.conkey) with ordinality as key_position(attnum, ordinality)
      join pg_attribute attribute
        on attribute.attrelid = definition.conrelid and attribute.attnum = key_position.attnum
    ) as "localColumns",
    case when definition.contype = 'c' then
      regexp_replace(
        replace(
          replace(lower(pg_get_expr(definition.conbin, definition.conrelid, true)), '::text[]', ''),
          '::text',
          ''
        ),
        '[[:space:]()"]+',
        '',
        'g'
      )
    else null end as "definitionSignature",
    target.relname as "targetRelation",
    target_namespace.nspname as target_schema,
    case when definition.contype = 'f' then (
      select coalesce(jsonb_agg(attribute.attname order by key_position.ordinality), '[]'::jsonb)
      from unnest(definition.confkey) with ordinality as key_position(attnum, ordinality)
      join pg_attribute attribute
        on attribute.attrelid = definition.confrelid and attribute.attnum = key_position.attnum
    ) else '[]'::jsonb end as "targetColumns",
    case when definition.contype = 'f' then definition.confdeltype else 'a'::"char" end as "deleteAction",
    definition.confupdtype,
    definition.confmatchtype,
    definition.condeferrable,
    definition.condeferred,
    definition.convalidated,
    definition.conislocal,
    definition.coninhcount,
    definition.connoinherit,
    backing_index.indisunique as backing_index_unique,
    backing_index.indisvalid as backing_index_valid,
    backing_index.indisready as backing_index_ready,
    backing_index.indislive as backing_index_live
  from pg_constraint definition
  join pg_class relation on relation.oid = definition.conrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  left join pg_class target on target.oid = definition.confrelid
  left join pg_namespace target_namespace on target_namespace.oid = target.relnamespace
  left join pg_index backing_index on backing_index.indexrelid = definition.conindid
  where namespace.nspname = current_schema()
    and definition.conname in (select "constraintName" from expected)
), compared as (
  select expected.*, actual.*,
    expected."constraintName" is null
      or actual."constraintName" is null
      or expected."relationName" <> actual."relationName"
      or expected.kind <> actual.kind
      or (expected.kind <> 'c' and expected."localColumns" <> actual."localColumns")
      or expected."definitionSignature" is distinct from actual."definitionSignature"
      or expected."targetRelation" is distinct from actual."targetRelation"
      or (expected.kind = 'f' and actual.target_schema is distinct from current_schema())
      or expected."targetColumns" <> actual."targetColumns"
      or expected."deleteAction" <> actual."deleteAction"
      or (expected.kind = 'f' and actual.confupdtype <> 'a')
      or (expected.kind = 'f' and actual.confmatchtype <> 's')
      or actual.condeferrable
      or actual.condeferred
      or not actual.convalidated
      or not actual.conislocal
      or actual.coninhcount <> 0
      or actual.connoinherit
      or (expected.kind in ('p', 'u') and actual.backing_index_unique is distinct from true)
      or (expected.kind in ('p', 'u') and actual.backing_index_valid is distinct from true)
      or (expected.kind in ('p', 'u') and actual.backing_index_ready is distinct from true)
      or (expected.kind in ('p', 'u') and actual.backing_index_live is distinct from true) as mismatched
  from expected
  full join actual using ("constraintName")
)
select count(*) filter (where mismatched)::integer as definition_mismatch_count
from compared`, [JSON.stringify(expectedOutboxConstraintDefinitions)])

  const triggerDefinitions = await client.query<{ definition_mismatch_count: number | string }>(`with expected as (
  select *
  from jsonb_to_recordset($1::jsonb) as item(
    "relationName" text,
    "triggerName" text,
    "functionName" text,
    "functionSourceSignature" text
  )
), actual as (
  select
    relation.relname as "relationName",
    definition.tgname as "triggerName",
    routine.proname as "functionName",
    regexp_replace(lower(routine.prosrc), '[[:space:]]+', '', 'g') as "functionSourceSignature",
    definition.tgtype::integer,
    definition.tgenabled,
    definition.tgisinternal,
    definition.tgnargs,
    definition.tgconstraint,
    pg_get_expr(definition.tgqual, definition.tgrelid, true) as trigger_qual,
    routine_namespace.nspname as function_schema,
    language.lanname,
    routine.prorettype::regtype::text as return_type,
    routine.pronargs,
    routine.prokind,
    routine.provolatile,
    routine.prosecdef,
    routine.proleakproof,
    routine.proisstrict,
    routine.proparallel,
    routine.proconfig
  from pg_trigger definition
  join pg_class relation on relation.oid = definition.tgrelid
  join pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_proc routine on routine.oid = definition.tgfoid
  join pg_namespace routine_namespace on routine_namespace.oid = routine.pronamespace
  join pg_language language on language.oid = routine.prolang
  where namespace.nspname = current_schema()
    and relation.relname in (select "relationName" from expected)
    and not definition.tgisinternal
), compared as (
  select expected.*, actual.*,
    expected."triggerName" is null
      or actual."triggerName" is null
      or expected."relationName" <> actual."relationName"
      or expected."functionName" <> actual."functionName"
      or expected."functionSourceSignature" <> actual."functionSourceSignature"
      or actual.tgtype <> 27
      or actual.tgenabled <> 'O'
      or actual.tgisinternal
      or actual.tgnargs <> 0
      or actual.tgconstraint <> 0
      or actual.trigger_qual is not null
      or actual.function_schema <> current_schema()
      or actual.lanname <> 'plpgsql'
      or actual.return_type <> 'trigger'
      or actual.pronargs <> 0
      or actual.prokind <> 'f'
      or actual.provolatile <> 'v'
      or actual.prosecdef
      or actual.proleakproof
      or actual.proisstrict
      or actual.proparallel <> 'u'
      or actual.proconfig is not null as mismatched
  from expected
  full join actual using ("triggerName")
)
select count(*) filter (where mismatched)::integer as definition_mismatch_count
from compared`, [JSON.stringify(expectedTriggerDefinitions)])

  const mismatchCounts = [
    columnDefinitions,
    indexDefinitions,
    constraintDefinitions,
    triggerDefinitions,
  ].map((definition) => integer(
    definition.rows[0]?.definition_mismatch_count,
    'schema definition mismatch count',
  ))
  if (mismatchCounts.some((count) => count > 0)) {
    throw new PostgresMigrationError(
      'MIGRATION_SCHEMA_INVALID',
      'Control-plane schema definition validation failed',
    )
  }
}

function checksum(sql: string) {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

function integer(value: unknown, label: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`)
  return parsed
}

function formatMigration(migration: Pick<PostgresControlPlaneMigration, 'version' | 'name'>) {
  return `${String(migration.version).padStart(3, '0')} (${migration.name})`
}

function expectedColumn(
  relationName: string,
  columnName: string,
  dataType: string,
  notNull: boolean,
  defaultDefinition: string | null = null,
): ExpectedColumnDefinition {
  return {
    relationName,
    columnName,
    dataType,
    notNull,
    defaultDefinition: defaultDefinition === null ? null : catalogSqlSignature(defaultDefinition),
  }
}

function expectedIndex(
  relationName: string,
  indexName: string,
  keyDefinitions: readonly string[],
  predicateDefinition = '',
): ExpectedIndexDefinition {
  return {
    relationName,
    indexName,
    unique: false,
    keyDefinitions: keyDefinitions.map(indexKeySignature),
    predicateDefinition: catalogSqlSignature(predicateDefinition),
  }
}

function expectedKeyConstraint(
  relationName: string,
  constraintName: string,
  kind: 'p' | 'u',
  localColumns: string[],
): ExpectedConstraintDefinition {
  return {
    relationName,
    constraintName,
    kind,
    localColumns,
    definitionSignature: null,
    targetRelation: null,
    targetColumns: [],
    deleteAction: 'a',
  }
}

function expectedCheckConstraint(
  relationName: string,
  constraintName: string,
  expression: string,
): ExpectedConstraintDefinition {
  return {
    relationName,
    constraintName,
    kind: 'c',
    localColumns: [],
    definitionSignature: catalogSqlSignature(expression),
    targetRelation: null,
    targetColumns: [],
    deleteAction: 'a',
  }
}

function expectedForeignKeyConstraint(
  relationName: string,
  constraintName: string,
  localColumns: string[],
  targetRelation: string,
  targetColumns: string[],
  deleteAction: 'c',
): ExpectedConstraintDefinition {
  return {
    relationName,
    constraintName,
    kind: 'f',
    localColumns,
    definitionSignature: null,
    targetRelation,
    targetColumns,
    deleteAction,
  }
}

function catalogSqlSignature(value: string) {
  return value
    .toLowerCase()
    .replaceAll('::text[]', '')
    .replaceAll('::text', '')
    .replace(/[\s()"]/g, '')
}

function indexKeySignature(value: string) {
  return value.toLowerCase().replace(/[\s"]/g, '')
}

function functionSourceSignature(value: string) {
  return value.toLowerCase().replace(/\s/g, '')
}

function extractNamedCheckExpression(sql: string, constraintName: string) {
  const marker = `constraint ${constraintName}`
  const markerIndex = sql.toLowerCase().indexOf(marker)
  if (markerIndex < 0) throw new Error(`required constraint definition is missing: ${constraintName}`)
  const checkMatch = /\bcheck\s*\(/i.exec(sql.slice(markerIndex + marker.length))
  if (!checkMatch) throw new Error(`required CHECK definition is missing: ${constraintName}`)
  const openIndex = markerIndex + marker.length + checkMatch.index + checkMatch[0].lastIndexOf('(')
  let depth = 0
  let inString = false
  for (let index = openIndex; index < sql.length; index += 1) {
    const character = sql[index]
    if (character === "'" && sql[index - 1] !== '\\') {
      if (inString && sql[index + 1] === "'") {
        index += 1
        continue
      }
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return sql.slice(openIndex + 1, index)
    }
  }
  throw new Error(`required CHECK definition is unbalanced: ${constraintName}`)
}

function extractFunctionSource(sql: string, functionName: string) {
  const pattern = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${functionName}\\s*\\(\\s*\\)[\\s\\S]*?as\\s+\\$\\$([\\s\\S]*?)\\$\\$`,
    'i',
  )
  const source = pattern.exec(sql)?.[1]
  if (source === undefined) throw new Error(`required trigger function definition is missing: ${functionName}`)
  return source
}
