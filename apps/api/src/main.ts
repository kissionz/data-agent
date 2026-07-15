import { createNodeBffServer } from '../../../src/api/nodeServer'
import { createApiRuntime } from './app'
import { createApiRuntimeConfig } from './config'

interface RuntimeProcess {
  env?: Record<string, string | undefined>
  stdout?: { write(text: string): void }
  on?(event: 'SIGINT' | 'SIGTERM', listener: () => void): void
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
    handle: runtime.handle,
  },
})
server.listen(config.port, config.host, () => {
  process?.stdout?.write?.(`${config.serviceName} listening on http://${config.host}:${config.port}\n`)
})

let workerRunning = false
const workerTimer = config.query.mode === 'postgresql'
  ? setInterval(() => {
      if (workerRunning) return
      workerRunning = true
      void runtime.runQueryWorkerOnce().finally(() => {
        workerRunning = false
      })
    }, config.query.workerPollMs)
  : undefined

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process?.on?.(signal, () => {
    if (workerTimer !== undefined) clearInterval(workerTimer)
    server.close(() => {
      void runtime.close()
    })
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
