import { createNodeBffServer } from '../../../src/api/nodeServer'
import { createApiRuntime } from './app'
import {
  createApiRuntimeConfig,
  parseApiEnvironment,
  parseApiQuerySslMode,
} from './config'
import { bindGracefulShutdown } from './gracefulShutdown'

interface RuntimeProcess {
  env?: Record<string, string | undefined>
  stdout?: { write(text: string): void }
  on?(event: 'SIGINT' | 'SIGTERM', listener: () => void): void
  removeListener?(event: 'SIGINT' | 'SIGTERM', listener: () => void): void
}

declare const process: RuntimeProcess | undefined

const env = typeof process === 'undefined' ? {} : process.env ?? {}
const environment = parseApiEnvironment(env.CHATBI_API_ENV)
const input = {
  environment,
  host: env.HOST,
  port: env.PORT,
  authMode: env.CHATBI_AUTH_MODE === 'required_header_actor' ? 'required_header_actor' : undefined,
  persistenceMode: env.CHATBI_PERSISTENCE_MODE === 'file' ? 'file' : 'memory',
  persistenceFilePath: env.CHATBI_PERSISTENCE_FILE,
  queryMode: parseQueryMode(env.CHATBI_QUERY_MODE, environment),
  queryCredentialRef: env.CHATBI_QUERY_CREDENTIAL_REF,
  querySslMode: parseApiQuerySslMode(env.CHATBI_QUERY_SSL_MODE),
  queryPoolMax: env.CHATBI_QUERY_POOL_MAX,
  queryConnectTimeoutMs: env.CHATBI_QUERY_CONNECT_TIMEOUT_MS,
  queryIdleTimeoutMs: env.CHATBI_QUERY_IDLE_TIMEOUT_MS,
  queryStatementTimeoutMs: env.CHATBI_QUERY_STATEMENT_TIMEOUT_MS,
  queryWorkerPollMs: env.CHATBI_QUERY_WORKER_POLL_MS,
  queryLeaseMs: env.CHATBI_QUERY_LEASE_MS,
  controlPlaneCredentialRef: env.CHATBI_CONTROL_PLANE_CREDENTIAL_REF,
  controlPlaneSslMode: parseApiQuerySslMode(
    env.CHATBI_CONTROL_PLANE_SSL_MODE,
    'CHATBI_CONTROL_PLANE_SSL_MODE',
  ),
  controlPlanePoolMax: env.CHATBI_CONTROL_PLANE_POOL_MAX,
  controlPlaneConnectTimeoutMs: env.CHATBI_CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  controlPlaneIdleTimeoutMs: env.CHATBI_CONTROL_PLANE_IDLE_TIMEOUT_MS,
  controlPlaneCancellationPollMs: env.CHATBI_CONTROL_PLANE_CANCELLATION_POLL_MS,
  controlPlaneWorkerDrainMs: env.CHATBI_CONTROL_PLANE_WORKER_DRAIN_MS,
  controlPlaneReconcileIntervalMs: env.CHATBI_CONTROL_PLANE_RECONCILE_INTERVAL_MS,
  controlPlaneReconcileBatchSize: env.CHATBI_CONTROL_PLANE_RECONCILE_BATCH_SIZE,
  outboxMode: parseOutboxMode(env.CHATBI_OUTBOX_MODE),
  outboxEndpointUrl: env.CHATBI_OUTBOX_HTTP_URL,
  outboxHmacSecretRef: env.CHATBI_OUTBOX_HMAC_SECRET_REF,
  outboxPollMs: env.CHATBI_OUTBOX_POLL_MS,
  outboxLeaseMs: env.CHATBI_OUTBOX_LEASE_MS,
  outboxHttpTimeoutMs: env.CHATBI_OUTBOX_HTTP_TIMEOUT_MS,
  outboxRetryInitialMs: env.CHATBI_OUTBOX_RETRY_INITIAL_MS,
  outboxRetryMaxMs: env.CHATBI_OUTBOX_RETRY_MAX_MS,
  outboxMaxAttempts: env.CHATBI_OUTBOX_MAX_ATTEMPTS,
  corsAllowOrigin: env.CORS_ALLOW_ORIGIN,
} as const
const config = createApiRuntimeConfig(input)
const runtime = createApiRuntime(input, {
  resolveQueryCredential: resolveServerCredential,
})
const server = createNodeBffServer({
  router: {
    service: runtime.router.service,
    assets: runtime.router.assets,
    dataSources: runtime.router.dataSources,
    developer: runtime.router.developer,
    evaluation: runtime.router.evaluation,
    feedback: runtime.router.feedback,
    identity: runtime.router.identity,
    modelOps: runtime.router.modelOps,
    semantic: runtime.router.semantic,
    sharing: runtime.router.sharing,
    slo: runtime.router.slo,
    handle: runtime.handleAsync,
  },
})
if (config.query.mode === 'postgresql') runtime.startQueryWorker()
server.listen(config.port, config.host, () => {
  process?.stdout?.write?.(`${config.serviceName} listening on http://${config.host}:${config.port}\n`)
})

if (process?.on) {
  bindGracefulShutdown({
    server,
    runtime,
    signalSource: {
      on: (signal, listener) => process.on?.(signal, listener),
      removeListener: (signal, listener) => process.removeListener?.(signal, listener),
    },
    onError(summary) {
      process.stdout?.write?.(`${config.serviceName} shutdown ${summary.phase} failed (${summary.name})\n`)
    },
  })
}

function parseQueryMode(value: string | undefined, environment: ReturnType<typeof parseApiEnvironment>) {
  if (value === 'fixture') return 'fixture' as const
  if (value === 'postgresql') return 'postgresql' as const
  return environment === 'staging' || environment === 'production' ? 'postgresql' as const : 'fixture' as const
}

function parseOutboxMode(value: string | undefined) {
  if (value === 'disabled' || value === 'http') return value
  if (value === undefined || !value.trim()) return undefined
  throw new Error('CHATBI_OUTBOX_MODE must be disabled or http')
}

function resolveServerCredential(credentialRef: string) {
  const match = credentialRef.match(/^env:(CHATBI_[A-Z0-9_]+)$/)
  if (!match) throw new Error('Server credential reference must use an allowed CHATBI_ environment variable')
  const value = env[match[1]]
  if (!value?.trim()) throw new Error(`Server credential environment variable is missing: ${match[1]}`)
  return value
}
