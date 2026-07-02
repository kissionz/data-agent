import { createNodeBffServer } from '../../../src/api/nodeServer'
import { createApiRuntime } from './app'
import { createApiRuntimeConfig } from './config'

interface RuntimeProcess {
  env?: Record<string, string | undefined>
  stdout?: { write(text: string): void }
}

declare const process: RuntimeProcess | undefined

const env = typeof process === 'undefined' ? {} : process.env ?? {}
const input = {
  environment: parseEnvironment(env.CHATBI_API_ENV),
  host: env.HOST,
  port: env.PORT,
  authMode: env.CHATBI_AUTH_MODE === 'required_header_actor' ? 'required_header_actor' : undefined,
  persistenceMode: env.CHATBI_PERSISTENCE_MODE === 'file' ? 'file' : 'memory',
  persistenceFilePath: env.CHATBI_PERSISTENCE_FILE,
  corsAllowOrigin: env.CORS_ALLOW_ORIGIN,
} as const
const config = createApiRuntimeConfig(input)
const runtime = createApiRuntime(input)
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

function parseEnvironment(value: string | undefined) {
  if (value === 'test' || value === 'staging' || value === 'production') return value
  return 'local'
}
