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
  ) as missing_trigger_count`, [
    requiredControlPlaneRelations,
    requiredControlPlaneTriggers.map(({ relation }) => relation),
    requiredControlPlaneTriggers.map(({ trigger }) => trigger),
  ])
  const row = result.rows[0]
  if (
    integer(row?.missing_relation_count, 'missing relation count') > 0
    || integer(row?.missing_trigger_count, 'missing trigger count') > 0
  ) {
    throw new PostgresMigrationError(
      'MIGRATION_SCHEMA_INVALID',
      'Control-plane schema validation failed',
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
