import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  loadPostgresControlPlaneMigrations,
  PostgresMigrationError,
  runPostgresControlPlaneMigrations,
  type PostgresControlPlaneMigration,
  type PostgresMigrationClientLike,
  type PostgresMigrationPoolLike,
} from '../../apps/api/src/migrations/postgresControlPlaneMigrationRunner'
import {
  resolveControlPlaneMigrationCredential,
  runControlPlaneMigrationCli,
} from '../../apps/api/src/migrations/controlPlaneMigrationCli'

interface Call { text: string; values?: readonly unknown[] }
interface Applied { version: number; name: string; checksum: string }

class MigrationClient implements PostgresMigrationClientLike {
  readonly calls: Call[] = []
  readonly executedMigrationVersions: number[] = []
  readonly applied = new Map<number, Applied>()
  released = false
  releaseArgument: Error | boolean | undefined
  failVersion?: number
  lockAvailable = true
  unmanagedRelationCount = 0
  missingRelationCount = 0
  missingTriggerCount = 0

  constructor(private readonly migrations: readonly PostgresControlPlaneMigration[]) {}

  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text.startsWith('select pg_try_advisory_lock')) {
      return { rows: [{ locked: this.lockAvailable }] as Row[], rowCount: 1 }
    }
    if (text.startsWith('select pg_advisory_unlock')) return { rows: [{ unlocked: true }] as Row[], rowCount: 1 }
    if (text.startsWith('select version, name, checksum')) {
      return { rows: [...this.applied.values()].sort((a, b) => a.version - b.version) as Row[], rowCount: this.applied.size }
    }
    if (text.startsWith('select count(*)::integer as existing_relation_count')) {
      return {
        rows: [{ existing_relation_count: this.unmanagedRelationCount }] as Row[],
        rowCount: 1,
      }
    }
    if (text.startsWith('select\n  (\n    select count(*)::integer')) {
      return {
        rows: [{
          missing_relation_count: this.missingRelationCount,
          missing_trigger_count: this.missingTriggerCount,
        }] as Row[],
        rowCount: 1,
      }
    }
    const migration = this.migrations.find((candidate) => candidate.sql === text)
    if (migration) {
      if (this.failVersion === migration.version) {
        throw new Error('postgresql://admin:secret@private-db/chatbi internal driver failure')
      }
      this.executedMigrationVersions.push(migration.version)
      return { rows: [] as Row[], rowCount: null }
    }
    if (text.startsWith('insert into chatbi_schema_migrations')) {
      const version = Number(values?.[0])
      this.applied.set(version, {
        version,
        name: String(values?.[1]),
        checksum: String(values?.[2]),
      })
      return { rows: [] as Row[], rowCount: 1 }
    }
    return { rows: [] as Row[], rowCount: 0 }
  }

  release(error?: Error | boolean) {
    this.released = true
    this.releaseArgument = error
  }
}

class MigrationPool implements PostgresMigrationPoolLike {
  ended = false
  constructor(readonly client: MigrationClient) {}
  async connect() { return this.client }
  async end() { this.ended = true }
}

describe('PostgreSQL control-plane migration runner', () => {
  it('loads immutable 001-005 SQL files with SHA-256 checksums', () => {
    const migrations = loadPostgresControlPlaneMigrations()

    expect(migrations.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: '001-control-plane-baseline' },
      { version: 2, name: '002-control-plane' },
      { version: 3, name: '003-result-event-store' },
      { version: 4, name: '004-query-control-plane' },
      { version: 5, name: '005-query-reconciler' },
    ])
    expect(migrations.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true)
    expect(migrations.every((migration) => migration.sql.trim().length > 100)).toBe(true)
  })

  it('keeps the production migration chain free of demo data, roles and hard-coded databases', () => {
    const [baseline] = loadPostgresControlPlaneMigrations()
    const productionSql = loadPostgresControlPlaneMigrations()
      .map((migration) => migration.sql)
      .join('\n')
      .toLowerCase()

    expect(baseline.sql).toContain('create table if not exists chatbi_schema_migrations')
    expect(productionSql).not.toContain('semantic_sales')
    expect(productionSql).not.toContain('tenant_demo')
    expect(productionSql).not.toContain('create role')
    expect(productionSql).not.toContain('password')
    expect(productionSql).not.toContain('chatbi_test')
  })

  it('holds an advisory lock and commits each migration in strict version order', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)

    const result = await runPostgresControlPlaneMigrations(new MigrationPool(client), [...migrations].reverse())

    expect(result).toEqual({ appliedVersions: [1, 2, 3, 4, 5], skippedVersions: [], latestVersion: 5 })
    expect(client.executedMigrationVersions).toEqual([1, 2, 3, 4, 5])
    expect(client.calls[0]).toMatchObject({ text: 'select pg_try_advisory_lock($1::bigint) as locked' })
    expect(client.calls.at(-1)).toMatchObject({ text: 'select pg_advisory_unlock($1::bigint) as unlocked' })
    expect(client.calls.filter((call) => call.text === 'BEGIN')).toHaveLength(5)
    expect(client.calls.filter((call) => call.text === 'COMMIT')).toHaveLength(5)
    expect(client.released).toBe(true)
  })

  it('skips matching applied migrations without executing their SQL again', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    const pool = new MigrationPool(client)
    await runPostgresControlPlaneMigrations(pool, migrations)
    client.executedMigrationVersions.length = 0

    const result = await runPostgresControlPlaneMigrations(pool, migrations)

    expect(result).toEqual({ appliedVersions: [], skippedVersions: [1, 2, 3, 4, 5], latestVersion: 5 })
    expect(client.executedMigrationVersions).toEqual([])
  })

  it('refuses to adopt known control-plane relations when the ledger is empty', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    client.unmanagedRelationCount = 1

    await expect(runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)).rejects.toMatchObject({
      code: 'MIGRATION_SCHEMA_INVALID',
      message: 'Control-plane schema contains unmanaged relations',
    })
    expect(client.executedMigrationVersions).toEqual([])
    expect(client.calls.some((call) => call.text === 'BEGIN')).toBe(false)
    const preflight = client.calls.find((call) => call.text.startsWith('select count(*)::integer as existing_relation_count'))
    expect(preflight?.values?.[0]).toContain('chatbi_run_jobs')
    expect(preflight?.values?.[0]).not.toContain('chatbi_schema_migrations')
  })

  it.each([
    { name: 'required relation', missingRelationCount: 1, missingTriggerCount: 0 },
    { name: 'immutability trigger', missingRelationCount: 0, missingTriggerCount: 1 },
  ])('rejects a completed ledger when a $name is missing', async ({
    missingRelationCount,
    missingTriggerCount,
  }) => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    client.missingRelationCount = missingRelationCount
    client.missingTriggerCount = missingTriggerCount

    const error = await runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)
      .catch((caught: unknown) => caught as PostgresMigrationError)

    expect(error).toMatchObject({
      code: 'MIGRATION_SCHEMA_INVALID',
      message: 'Control-plane schema validation failed',
    })
    expect(error.message).not.toContain('chatbi_')
    const validation = client.calls.find((call) => call.text.includes('missing_relation_count'))
    expect(validation?.text).toContain("relkind in ('r', 'p')")
    expect(validation?.text).toContain("tgenabled <> 'D'")
    expect(validation?.values?.[0]).toEqual(expect.arrayContaining([
      'chatbi_schema_migrations',
      'chatbi_run_jobs',
      'chatbi_query_reconciliation_findings',
    ]))
    expect(validation?.values?.[1]).toEqual([
      'chatbi_result_manifests',
      'chatbi_result_pages',
    ])
    expect(validation?.values?.[2]).toEqual([
      'chatbi_result_manifests_immutable',
      'chatbi_result_pages_published_immutable',
    ])
  })

  it('refuses an applied migration whose name or checksum has changed', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    client.applied.set(1, { version: 1, name: migrations[0].name, checksum: '0'.repeat(64) })

    const error = await runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)
      .catch((caught: unknown) => caught as PostgresMigrationError)

    expect(error).toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' })
    expect(error.message).toContain('001')
    expect(client.executedMigrationVersions).toEqual([])
    expect(client.calls.at(-1)?.text).toContain('pg_advisory_unlock')
  })

  it('fails fast instead of waiting when another migrator holds the advisory lock', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    client.lockAvailable = false

    await expect(runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)).rejects.toMatchObject({
      code: 'MIGRATION_LOCK_FAILED',
      message: 'Another control-plane migration process currently holds the lock',
    })
    expect(client.calls).toHaveLength(1)
    expect(client.released).toBe(true)
  })

  it('refuses a database schema created by a newer migrator binary', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    client.applied.set(6, { version: 6, name: '006-future', checksum: 'a'.repeat(64) })

    await expect(runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)).rejects.toMatchObject({
      code: 'MIGRATION_FUTURE_VERSION',
    })
    expect(client.executedMigrationVersions).toEqual([])
  })

  it.each([
    {
      name: 'version zero',
      applied: [{ version: 0, name: '000-invalid', checksum: 'a'.repeat(64) }],
    },
    {
      name: 'a missing first migration',
      applied: [{ version: 2, name: '002-control-plane', checksum: 'a'.repeat(64) }],
    },
    {
      name: 'a gap inside the applied prefix',
      applied: [
        { version: 1, name: '001-control-plane-baseline', checksum: 'a'.repeat(64) },
        { version: 3, name: '003-result-event-store', checksum: 'a'.repeat(64) },
      ],
    },
  ])('refuses an applied ledger containing $name before running SQL', async ({ applied }) => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    for (const row of applied) client.applied.set(row.version, row)

    await expect(runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)).rejects.toMatchObject({
      code: 'MIGRATION_LEDGER_INVALID',
      message: 'Applied control-plane migrations must be a contiguous prefix beginning at 001',
    })
    expect(client.executedMigrationVersions).toEqual([])
    expect(client.calls.some((call) => call.text === 'BEGIN')).toBe(false)
  })

  it('rolls back a failed file and never exposes driver or credential details', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    client.failVersion = 2

    const error = await runPostgresControlPlaneMigrations(new MigrationPool(client), migrations)
      .catch((caught: unknown) => caught as PostgresMigrationError)

    expect(error).toMatchObject({ code: 'MIGRATION_FAILED' })
    expect(error.message).toContain('002')
    expect(error.message).not.toContain('postgresql://')
    expect(error.message).not.toContain('secret')
    expect(client.calls.some((call) => call.text === 'ROLLBACK')).toBe(true)
    expect(client.applied.has(1)).toBe(true)
    expect(client.applied.has(2)).toBe(false)
  })

  it('rejects missing, duplicate or modified migration definitions before connecting', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    const invalidSets = [
      [],
      [migrations[0], migrations[2], migrations[3]],
      [migrations[0], migrations[0], migrations[2], migrations[3]],
      [{ ...migrations[0], sql: `${migrations[0].sql}\n-- changed` }, ...migrations.slice(1)],
    ]
    for (const invalid of invalidSets) {
      await expect(runPostgresControlPlaneMigrations(new MigrationPool(client), invalid))
        .rejects.toMatchObject({ code: 'MIGRATION_DEFINITION_INVALID' })
    }
    expect(client.calls).toHaveLength(0)
  })

  it('accepts future contiguous definitions without hard-coding four migrations', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const sql = 'select 6 as future_migration'
    const migration6 = {
      version: 6,
      name: '006-future',
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    }
    const expanded = [...migrations, migration6]
    const client = new MigrationClient(expanded)

    await expect(runPostgresControlPlaneMigrations(new MigrationPool(client), expanded)).resolves.toMatchObject({
      appliedVersions: [1, 2, 3, 4, 5, 6],
      latestVersion: 6,
    })
  })
})

describe('control-plane migration CLI credential boundary', () => {
  it('resolves only an allowed server-side environment reference', () => {
    const dsn = 'postgresql://admin:secret@private-db/chatbi'
    expect(resolveControlPlaneMigrationCredential({
      CHATBI_CONTROL_PLANE_CREDENTIAL_REF: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
      CHATBI_CONTROL_PLANE_DATABASE_URL: dsn,
    })).toBe(dsn)
    expect(() => resolveControlPlaneMigrationCredential({
      CHATBI_CONTROL_PLANE_CREDENTIAL_REF: dsn,
    })).toThrow('allowed CHATBI_ environment variable')
    expect(() => resolveControlPlaneMigrationCredential({
      CHATBI_CONTROL_PLANE_CREDENTIAL_REF: 'env:DATABASE_URL',
      DATABASE_URL: dsn,
    })).toThrow('allowed CHATBI_ environment variable')
  })

  it('prints only migration metadata and never the DSN', async () => {
    const migrations = loadPostgresControlPlaneMigrations()
    const client = new MigrationClient(migrations)
    const pool = new MigrationPool(client)
    const output: string[] = []
    const errors: string[] = []
    const dsn = 'postgresql://admin:super-secret@private-db/chatbi'

    const exitCode = await runControlPlaneMigrationCli({
      CHATBI_CONTROL_PLANE_CREDENTIAL_REF: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
      CHATBI_CONTROL_PLANE_DATABASE_URL: dsn,
      CHATBI_CONTROL_PLANE_SSL_MODE: 'verify-full',
    }, {
      createPool(options) {
        expect(options).toEqual({ connectionString: dsn, ssl: { rejectUnauthorized: true } })
        return pool
      },
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(output.join(''))).toMatchObject({ ok: true, latestVersion: 5 })
    expect(errors).toEqual([])
    expect(`${output.join('')} ${errors.join('')}`).not.toContain(dsn)
    expect(pool.ended).toBe(true)
  })

  it('sanitizes unknown connection errors', async () => {
    const errors: string[] = []
    const dsn = 'postgresql://admin:super-secret@private-db/chatbi'
    const exitCode = await runControlPlaneMigrationCli({
      CHATBI_CONTROL_PLANE_CREDENTIAL_REF: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
      CHATBI_CONTROL_PLANE_DATABASE_URL: dsn,
    }, {
      createPool() {
        return {
          async connect() { throw new Error(`connect failed ${dsn}`) },
        }
      },
      stdout() {},
      stderr: (text) => errors.push(text),
    })

    expect(exitCode).toBe(1)
    expect(errors.join('')).toContain('MIGRATION_FAILED')
    expect(errors.join('')).not.toContain('postgresql://')
    expect(errors.join('')).not.toContain('super-secret')
  })
})
