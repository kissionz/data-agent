import { createNodeBffServer } from '../../../src/api/nodeServer'
import { createApiRuntime } from './app'
import { createApiRuntimeConfig } from './config'
import { bindGracefulShutdown } from './gracefulShutdown'

interface RuntimeProcess {
  env?: Record<string, string | undefined>
  stdout?: { write(text: string): void }
  on?(event: 'SIGINT' | 'SIGTERM', listener: () => void): void
  removeListener?(event: 'SIGINT' | 'SIGTERM', listener: () => void): void
}

declare const process: RuntimeProcess | undefined

const env = typeof process === 'undefined' ? {} : process.env ?? {}
const environment = parseEnvironment(env.CHATBI_API_ENV)
const input = {
  environment,
  host: env.HOST,
  port: env.PORT,
  authMode: env.CHATBI_AUTH_MODE === 'required_header_actor' ? 'required_header_actor' : undefined,
  persistenceMode: env.CHATBI_PERSISTENCE_MODE === 'file' ? 'file' : 'memory',
  persistenceFilePath: env.CHATBI_PERSISTENCE_FILE,
  queryMode: parseQueryMode(env.CHATBI_QUERY_MODE, environment),
  queryCredentialRef: env.CHATBI_QUERY_CREDENTIAL_REF,
  querySslMode: parseQuerySslMode(env.CHATBI_QUERY_SSL_MODE),
  queryPoolMax: env.CHATBI_QUERY_POOL_MAX,
  queryConnectTimeoutMs: env.CHATBI_QUERY_CONNECT_TIMEOUT_MS,
  queryIdleTimeoutMs: env.CHATBI_QUERY_IDLE_TIMEOUT_MS,
  queryStatementTimeoutMs: env.CHATBI_QUERY_STATEMENT_TIMEOUT_MS,
  queryWorkerPollMs: env.CHATBI_QUERY_WORKER_POLL_MS,
  queryLeaseMs: env.CHATBI_QUERY_LEASE_MS,
  controlPlaneCredentialRef: env.CHATBI_CONTROL_PLANE_CREDENTIAL_REF,
  controlPlaneSslMode: parseOptionalQuerySslMode(env.CHATBI_CONTROL_PLANE_SSL_MODE),
  controlPlanePoolMax: env.CHATBI_CONTROL_PLANE_POOL_MAX,
  controlPlaneConnectTimeoutMs: env.CHATBI_CONTROL_PLANE_CONNECT_TIMEOUT_MS,
  controlPlaneIdleTimeoutMs: env.CHATBI_CONTROL_PLANE_IDLE_TIMEOUT_MS,
  controlPlaneCancellationPollMs: env.CHATBI_CONTROL_PLANE_CANCELLATION_POLL_MS,
  controlPlaneWorkerDrainMs: env.CHATBI_CONTROL_PLANE_WORKER_DRAIN_MS,
  controlPlaneReconcileIntervalMs: env.CHATBI_CONTROL_PLANE_RECONCILE_INTERVAL_MS,
  controlPlaneReconcileBatchSize: env.CHATBI_CONTROL_PLANE_RECONCILE_BATCH_SIZE,
  corsAllowOrigin: env.CORS_ALLOW_ORIGIN,
} as const
const config = createApiRuntimeConfig(input)
const runtime = createApiRuntime(input, {
  resolveQueryCredential(credentialRef) {
    const match = credentialRef.match(/^env:(CHATBI_[A-Z0-9_]+)$/)
    if (!match) throw new Error('Query credential reference must use an allowed CHATBI_ environment variable')
    const value = env[match[1]]
    if (!value?.trim()) throw new Error(`Query credential environment variable is missing: ${match[1]}`)
    return value
  },
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

function parseEnvironment(value: string | undefined) {
  if (value === 'test' || value === 'staging' || value === 'production') return value
  return 'local'
}

function parseQueryMode(value: string | undefined, environment: ReturnType<typeof parseEnvironment>) {
  if (value === 'fixture') return 'fixture' as const
  if (value === 'postgresql') return 'postgresql' as const
  return environment === 'staging' || environment === 'production' ? 'postgresql' as const : 'fixture' as const
}

function parseQuerySslMode(value: string | undefined) {
  if (value === 'require' || value === 'verify-full') return value
  return 'disable'
}

function parseOptionalQuerySslMode(value: string | undefined) {
  if (value === 'disable' || value === 'require' || value === 'verify-full') return value
  return undefined
}
