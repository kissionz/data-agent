import { join } from 'node:path'

export type ApiAuthMode = 'required_header_actor' | 'disabled_demo_actor'
export type ApiPersistenceMode = 'memory' | 'file'
export type ApiQueryMode = 'fixture' | 'postgresql'
export type ApiQuerySslMode = 'disable' | 'require' | 'verify-full'

export interface ApiRuntimeConfig {
  serviceName: 'insightflow-chatbi-api'
  environment: 'local' | 'test' | 'staging' | 'production'
  host: string
  port: number
  authMode: ApiAuthMode
  persistence: {
    mode: ApiPersistenceMode
    filePath?: string
  }
  query: {
    mode: ApiQueryMode
    credentialRef?: string
    sslMode: ApiQuerySslMode
    poolMax: number
    connectTimeoutMs: number
    idleTimeoutMs: number
    statementTimeoutMs: number
    workerPollMs: number
    leaseMs: number
  }
  cors: {
    allowOrigin: string
  }
}

export interface ApiRuntimeConfigInput {
  environment?: ApiRuntimeConfig['environment']
  host?: string
  port?: number | string
  authMode?: ApiAuthMode
  persistenceMode?: ApiPersistenceMode
  persistenceFilePath?: string
  queryMode?: ApiQueryMode
  queryCredentialRef?: string
  querySslMode?: ApiQuerySslMode
  queryPoolMax?: number | string
  queryConnectTimeoutMs?: number | string
  queryIdleTimeoutMs?: number | string
  queryStatementTimeoutMs?: number | string
  queryWorkerPollMs?: number | string
  queryLeaseMs?: number | string
  corsAllowOrigin?: string
}

export function createApiRuntimeConfig(input: ApiRuntimeConfigInput = {}): ApiRuntimeConfig {
  const environment = input.environment ?? 'local'
  const persistenceMode = input.persistenceMode ?? 'memory'
  const port = typeof input.port === 'string' ? Number.parseInt(input.port, 10) : input.port
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error('API port must be an integer between 1 and 65535')
  }
  const queryMode = input.queryMode ?? 'fixture'
  const queryCredentialRef = input.queryCredentialRef?.trim()
  if (queryMode === 'postgresql' && !queryCredentialRef) {
    throw new Error('PostgreSQL query mode requires a server-side credential reference')
  }
  const poolMax = positiveInteger(input.queryPoolMax, 4, 'query pool max')
  if (queryMode === 'postgresql' && poolMax < 2) {
    throw new Error('PostgreSQL query pool max must be at least 2 so cancellation can use a separate connection')
  }
  return {
    serviceName: 'insightflow-chatbi-api',
    environment,
    host: input.host ?? '127.0.0.1',
    port: port ?? 8787,
    authMode: input.authMode ?? (environment === 'local' ? 'disabled_demo_actor' : 'required_header_actor'),
    persistence: {
      mode: persistenceMode,
      filePath: persistenceMode === 'file'
        ? input.persistenceFilePath ?? join('/private/tmp', 'chatbi-api-runtime.json')
        : undefined,
    },
    query: {
      mode: queryMode,
      credentialRef: queryCredentialRef,
      sslMode: input.querySslMode ?? 'disable',
      poolMax,
      connectTimeoutMs: positiveInteger(input.queryConnectTimeoutMs, 5_000, 'query connect timeout'),
      idleTimeoutMs: positiveInteger(input.queryIdleTimeoutMs, 30_000, 'query idle timeout'),
      statementTimeoutMs: positiveInteger(input.queryStatementTimeoutMs, 15_000, 'query statement timeout'),
      workerPollMs: positiveInteger(input.queryWorkerPollMs, 250, 'query worker poll interval'),
      leaseMs: positiveInteger(input.queryLeaseMs, 30_000, 'query worker lease'),
    },
    cors: {
      allowOrigin: input.corsAllowOrigin ?? '*',
    },
  }
}

function positiveInteger(value: number | string | undefined, fallback: number, label: string) {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value ?? fallback
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}
