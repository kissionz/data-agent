import { join } from 'node:path'

export type ApiAuthMode = 'required_header_actor' | 'disabled_demo_actor'
export type ApiPersistenceMode = 'memory' | 'file'
export type ApiQueryMode = 'fixture' | 'postgresql'
export type ApiQuerySslMode = 'disable' | 'require' | 'verify-full'
export type ApiOutboxMode = 'disabled' | 'http'

export function parseApiEnvironment(
  value: string | undefined,
): ApiRuntimeConfig['environment'] {
  if (value === undefined || !value.trim()) return 'local'
  if (value === 'local' || value === 'test' || value === 'staging' || value === 'production') {
    return value
  }
  throw new Error('CHATBI_API_ENV must be local, test, staging, or production')
}

export function parseApiQuerySslMode(
  value: string | undefined,
  variableName = 'CHATBI_QUERY_SSL_MODE',
): ApiQuerySslMode | undefined {
  if (value === undefined || !value.trim()) return undefined
  if (value === 'disable' || value === 'require' || value === 'verify-full') return value
  throw new Error(`${variableName} must be disable, require, or verify-full`)
}

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
  controlPlane: {
    credentialRef?: string
    sslMode: ApiQuerySslMode
    poolMax: number
    connectTimeoutMs: number
    idleTimeoutMs: number
    cancellationPollMs: number
    workerDrainMs: number
    reconcileIntervalMs: number
    reconcileBatchSize: number
  }
  outbox: {
    mode: ApiOutboxMode
    endpointUrl?: string
    hmacSecretRef?: string
    pollMs: number
    leaseMs: number
    httpTimeoutMs: number
    retryInitialMs: number
    retryMaxMs: number
    maxAttempts: number
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
  controlPlaneCredentialRef?: string
  controlPlaneSslMode?: ApiQuerySslMode
  controlPlanePoolMax?: number | string
  controlPlaneConnectTimeoutMs?: number | string
  controlPlaneIdleTimeoutMs?: number | string
  controlPlaneCancellationPollMs?: number | string
  controlPlaneWorkerDrainMs?: number | string
  controlPlaneReconcileIntervalMs?: number | string
  controlPlaneReconcileBatchSize?: number | string
  outboxMode?: ApiOutboxMode
  outboxEndpointUrl?: string
  outboxHmacSecretRef?: string
  outboxPollMs?: number | string
  outboxLeaseMs?: number | string
  outboxHttpTimeoutMs?: number | string
  outboxRetryInitialMs?: number | string
  outboxRetryMaxMs?: number | string
  outboxMaxAttempts?: number | string
  corsAllowOrigin?: string
}

export function createApiRuntimeConfig(input: ApiRuntimeConfigInput = {}): ApiRuntimeConfig {
  const environment = parseApiEnvironment(input.environment)
  const persistenceMode = input.persistenceMode ?? 'memory'
  const port = typeof input.port === 'string' ? Number.parseInt(input.port, 10) : input.port
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error('API port must be an integer between 1 and 65535')
  }
  const queryMode = input.queryMode ?? 'fixture'
  const queryCredentialRef = credentialReference(input.queryCredentialRef, 'query credential reference')
  const controlPlaneCredentialRef = credentialReference(
    input.controlPlaneCredentialRef,
    'control-plane credential reference',
  )
  if (queryMode === 'postgresql' && !queryCredentialRef) {
    throw new Error('PostgreSQL query mode requires a server-side credential reference')
  }
  if (queryMode === 'postgresql' && !controlPlaneCredentialRef) {
    throw new Error('PostgreSQL query mode requires a server-side control-plane credential reference')
  }
  if (queryMode === 'postgresql'
    && (environment === 'staging' || environment === 'production')
    && queryCredentialRef === controlPlaneCredentialRef) {
    throw new Error('Production query and control-plane credential references must be different')
  }
  const poolMax = positiveInteger(input.queryPoolMax, 4, 'query pool max')
  if (queryMode === 'postgresql' && poolMax < 2) {
    throw new Error('PostgreSQL query pool max must be at least 2 so cancellation can use a separate connection')
  }
  const controlPlanePoolMax = boundedInteger(
    input.controlPlanePoolMax,
    4,
    'control-plane pool max',
    1,
    100,
  )
  if (queryMode === 'postgresql' && controlPlanePoolMax < 2) {
    throw new Error('PostgreSQL control-plane pool max must be at least 2 for concurrent API transactions and worker commits')
  }
  const productionPostgres = queryMode === 'postgresql'
    && (environment === 'staging' || environment === 'production')
  if (input.outboxMode !== undefined && input.outboxMode !== 'disabled' && input.outboxMode !== 'http') {
    throw new Error('outbox mode must be disabled or http')
  }
  const outboxMode = input.outboxMode ?? (productionPostgres ? 'http' : 'disabled')
  if (queryMode !== 'postgresql' && outboxMode !== 'disabled') {
    throw new Error('HTTP outbox mode requires PostgreSQL query mode')
  }
  if (productionPostgres && outboxMode !== 'http') {
    throw new Error('Staging and production PostgreSQL mode requires HTTP outbox delivery')
  }
  const outboxEndpointUrl = outboxMode === 'http'
    ? requiredHttpsEndpoint(input.outboxEndpointUrl)
    : undefined
  const outboxHmacSecretRef = outboxMode === 'http'
    ? requiredOutboxSecretReference(input.outboxHmacSecretRef)
    : undefined
  if (
    outboxHmacSecretRef
    && (outboxHmacSecretRef === queryCredentialRef || outboxHmacSecretRef === controlPlaneCredentialRef)
  ) {
    throw new Error('HTTP outbox HMAC secret reference must be dedicated and separate from database credentials')
  }
  const outboxHttpTimeoutMs = boundedInteger(
    input.outboxHttpTimeoutMs,
    10_000,
    'outbox HTTP timeout',
    100,
    120_000,
  )
  const outboxLeaseMs = boundedInteger(
    input.outboxLeaseMs,
    30_000,
    'outbox lease',
    1_000,
    600_000,
  )
  if (outboxMode === 'http' && outboxLeaseMs <= outboxHttpTimeoutMs) {
    throw new Error('outbox lease must be greater than outbox HTTP timeout')
  }
  const outboxRetryInitialMs = boundedInteger(
    input.outboxRetryInitialMs,
    1_000,
    'outbox retry initial delay',
    100,
    3_600_000,
  )
  const outboxRetryMaxMs = boundedInteger(
    input.outboxRetryMaxMs,
    300_000,
    'outbox retry maximum delay',
    100,
    86_400_000,
  )
  if (outboxRetryMaxMs < outboxRetryInitialMs) {
    throw new Error('outbox retry maximum delay cannot be less than initial delay')
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
      sslMode: input.querySslMode
        ?? (environment === 'staging' || environment === 'production' ? 'verify-full' : 'disable'),
      poolMax,
      connectTimeoutMs: positiveInteger(input.queryConnectTimeoutMs, 5_000, 'query connect timeout'),
      idleTimeoutMs: positiveInteger(input.queryIdleTimeoutMs, 30_000, 'query idle timeout'),
      statementTimeoutMs: positiveInteger(input.queryStatementTimeoutMs, 15_000, 'query statement timeout'),
      workerPollMs: positiveInteger(input.queryWorkerPollMs, 250, 'query worker poll interval'),
      leaseMs: positiveInteger(input.queryLeaseMs, 30_000, 'query worker lease'),
    },
    controlPlane: {
      credentialRef: controlPlaneCredentialRef,
      sslMode: input.controlPlaneSslMode
        ?? (environment === 'staging' || environment === 'production' ? 'verify-full' : input.querySslMode ?? 'disable'),
      poolMax: controlPlanePoolMax,
      connectTimeoutMs: boundedInteger(
        input.controlPlaneConnectTimeoutMs,
        5_000,
        'control-plane connect timeout',
        1,
        120_000,
      ),
      idleTimeoutMs: boundedInteger(
        input.controlPlaneIdleTimeoutMs,
        30_000,
        'control-plane idle timeout',
        1,
        600_000,
      ),
      cancellationPollMs: boundedInteger(
        input.controlPlaneCancellationPollMs,
        250,
        'control-plane cancellation poll interval',
        25,
        60_000,
      ),
      workerDrainMs: boundedInteger(
        input.controlPlaneWorkerDrainMs,
        30_000,
        'control-plane worker drain timeout',
        0,
        300_000,
      ),
      reconcileIntervalMs: boundedInteger(
        input.controlPlaneReconcileIntervalMs,
        30_000,
        'control-plane reconcile interval',
        1_000,
        3_600_000,
      ),
      reconcileBatchSize: boundedInteger(
        input.controlPlaneReconcileBatchSize,
        100,
        'control-plane reconcile batch size',
        1,
        500,
      ),
    },
    outbox: {
      mode: outboxMode,
      endpointUrl: outboxEndpointUrl,
      hmacSecretRef: outboxHmacSecretRef,
      pollMs: boundedInteger(input.outboxPollMs, 250, 'outbox poll interval', 25, 60_000),
      leaseMs: outboxLeaseMs,
      httpTimeoutMs: outboxHttpTimeoutMs,
      retryInitialMs: outboxRetryInitialMs,
      retryMaxMs: outboxRetryMaxMs,
      maxAttempts: boundedInteger(input.outboxMaxAttempts, 5, 'outbox max attempts', 1, 100),
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

function boundedInteger(
  value: number | string | undefined,
  fallback: number,
  label: string,
  minimum: number,
  maximum: number,
) {
  const parsed = typeof value === 'string' ? Number(value) : value ?? fallback
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function credentialReference(value: string | undefined, label: string) {
  const reference = value?.trim()
  if (!reference) return undefined
  if (/^(?:postgres|postgresql):\/\//i.test(reference)) {
    throw new Error(`${label} must be an opaque server-side reference, not a database URL`)
  }
  return reference
}

function requiredOutboxSecretReference(value: string | undefined) {
  const reference = value?.trim()
  if (!reference || !/^env:CHATBI_[A-Z0-9_]+$/.test(reference)) {
    throw new Error('HTTP outbox HMAC secret reference must use env:CHATBI_*')
  }
  return reference
}

function requiredHttpsEndpoint(value: string | undefined) {
  let endpoint: URL
  try {
    endpoint = new URL(value ?? '')
  } catch {
    throw new Error('HTTP outbox endpoint URL is required and must be valid')
  }
  if (endpoint.protocol !== 'https:') throw new Error('HTTP outbox endpoint URL must use HTTPS')
  if (endpoint.username || endpoint.password) throw new Error('HTTP outbox endpoint URL must not contain userinfo')
  if (endpoint.search) throw new Error('HTTP outbox endpoint URL must not contain query parameters')
  if (endpoint.hash) throw new Error('HTTP outbox endpoint URL must not contain a fragment')
  return endpoint.href
}
