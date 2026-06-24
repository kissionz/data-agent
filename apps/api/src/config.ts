import { join } from 'node:path'

export type ApiAuthMode = 'required_header_actor' | 'disabled_demo_actor'
export type ApiPersistenceMode = 'memory' | 'file'

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
  corsAllowOrigin?: string
}

export function createApiRuntimeConfig(input: ApiRuntimeConfigInput = {}): ApiRuntimeConfig {
  const environment = input.environment ?? 'local'
  const persistenceMode = input.persistenceMode ?? 'memory'
  const port = typeof input.port === 'string' ? Number.parseInt(input.port, 10) : input.port
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error('API port must be an integer between 1 and 65535')
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
    cors: {
      allowOrigin: input.corsAllowOrigin ?? '*',
    },
  }
}

