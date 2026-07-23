import { Pool } from 'pg'
import {
  PostgresMigrationError,
  runPostgresControlPlaneMigrations,
  type PostgresMigrationPoolLike,
} from './postgresControlPlaneMigrationRunner'

export interface ControlPlaneMigrationEnvironment {
  CHATBI_CONTROL_PLANE_CREDENTIAL_REF?: string
  CHATBI_CONTROL_PLANE_SSL_MODE?: string
  [name: string]: string | undefined
}

export interface ControlPlaneMigrationCliDependencies {
  createPool(options: { connectionString: string; ssl: false | { rejectUnauthorized: boolean } }): PostgresMigrationPoolLike
  stdout(text: string): void
  stderr(text: string): void
}

export function resolveControlPlaneMigrationCredential(environment: ControlPlaneMigrationEnvironment) {
  const reference = environment.CHATBI_CONTROL_PLANE_CREDENTIAL_REF?.trim()
  const match = reference?.match(/^env:(CHATBI_[A-Z0-9_]+)$/)
  if (!match) {
    throw new PostgresMigrationError(
      'MIGRATION_DEFINITION_INVALID',
      'Control-plane migration credential reference must use an allowed CHATBI_ environment variable',
    )
  }
  const credential = environment[match[1]]?.trim()
  if (!credential) {
    throw new PostgresMigrationError(
      'MIGRATION_DEFINITION_INVALID',
      'Control-plane migration credential is unavailable',
    )
  }
  return credential
}

export async function runControlPlaneMigrationCli(
  environment: ControlPlaneMigrationEnvironment,
  dependencies: ControlPlaneMigrationCliDependencies = defaultDependencies,
) {
  let pool: PostgresMigrationPoolLike | undefined
  try {
    const connectionString = resolveControlPlaneMigrationCredential(environment)
    pool = dependencies.createPool({
      connectionString,
      ssl: resolveSsl(environment.CHATBI_CONTROL_PLANE_SSL_MODE),
    })
    const result = await runPostgresControlPlaneMigrations(pool)
    dependencies.stdout(`${JSON.stringify({
      ok: true,
      appliedVersions: result.appliedVersions,
      skippedVersions: result.skippedVersions,
      latestVersion: result.latestVersion,
    })}\n`)
    return 0
  } catch (error) {
    dependencies.stderr(`${safeMessage(error)}\n`)
    return 1
  } finally {
    if (pool) {
      try {
        await pool.end?.()
      } catch {
        // The process is already terminating; never expose driver connection details.
      }
    }
  }
}

const defaultDependencies: ControlPlaneMigrationCliDependencies = {
  createPool(options) {
    return new Pool({ ...options, max: 1, connectionTimeoutMillis: 5_000 })
  },
  stdout(text) {
    process.stdout.write(text)
  },
  stderr(text) {
    process.stderr.write(text)
  },
}

function resolveSsl(value: string | undefined): false | { rejectUnauthorized: boolean } {
  if (value === 'disable') return false
  if (value === 'require') return { rejectUnauthorized: false }
  return { rejectUnauthorized: true }
}

function safeMessage(error: unknown) {
  if (error instanceof PostgresMigrationError) return `${error.code}: ${error.message}`
  return 'MIGRATION_FAILED: Control-plane migration failed'
}
