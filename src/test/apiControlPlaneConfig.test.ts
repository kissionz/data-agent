import { describe, expect, it } from 'vitest'
import {
  createApiRuntimeConfig,
  parseApiEnvironment,
  parseApiQuerySslMode,
} from '../../apps/api/src/config'

const postgresCredentials = {
  queryMode: 'postgresql' as const,
  queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
  controlPlaneCredentialRef: 'vault://chatbi/production/control-plane',
  outboxMode: 'http' as const,
  outboxEndpointUrl: 'https://events.example.com/chatbi',
  outboxHmacSecretRef: 'env:CHATBI_OUTBOX_HMAC_SECRET',
}

describe('API PostgreSQL control-plane configuration', () => {
  it('fails closed for misspelled non-empty deployment environments', () => {
    expect(parseApiEnvironment(undefined)).toBe('local')
    expect(parseApiEnvironment('')).toBe('local')
    expect(parseApiEnvironment('local')).toBe('local')
    expect(parseApiEnvironment('production')).toBe('production')
    expect(() => parseApiEnvironment('prodution')).toThrow('CHATBI_API_ENV')
    expect(() => parseApiEnvironment(' production ')).toThrow('CHATBI_API_ENV')
  })

  it('defaults both production database boundaries to verified TLS and rejects SSL typos', () => {
    const production = createApiRuntimeConfig({
      ...postgresCredentials,
      environment: 'production',
    })
    expect(production.query.sslMode).toBe('verify-full')
    expect(production.controlPlane.sslMode).toBe('verify-full')
    expect(parseApiQuerySslMode(undefined)).toBeUndefined()
    expect(parseApiQuerySslMode('require')).toBe('require')
    expect(() => parseApiQuerySslMode('verify_full')).toThrow('CHATBI_QUERY_SSL_MODE')
  })

  it('keeps independent query and control-plane credentials behind references', () => {
    const config = createApiRuntimeConfig({
      ...postgresCredentials,
      controlPlanePoolMax: '6',
      controlPlaneConnectTimeoutMs: '4000',
      controlPlaneIdleTimeoutMs: '45000',
      controlPlaneCancellationPollMs: '75',
      controlPlaneWorkerDrainMs: '12000',
      controlPlaneReconcileIntervalMs: '45000',
      controlPlaneReconcileBatchSize: '80',
    })

    expect(config.controlPlane).toEqual({
      credentialRef: 'vault://chatbi/production/control-plane',
      sslMode: 'disable',
      poolMax: 6,
      connectTimeoutMs: 4_000,
      idleTimeoutMs: 45_000,
      cancellationPollMs: 75,
      workerDrainMs: 12_000,
      reconcileIntervalMs: 45_000,
      reconcileBatchSize: 80,
    })
    expect(config.query.credentialRef).toBe('env:CHATBI_QUERY_DATABASE_URL')
    expect(config.outbox).toEqual({
      mode: 'http',
      endpointUrl: 'https://events.example.com/chatbi',
      hmacSecretRef: 'env:CHATBI_OUTBOX_HMAC_SECRET',
      pollMs: 250,
      leaseMs: 30_000,
      httpTimeoutMs: 10_000,
      retryInitialMs: 1_000,
      retryMaxMs: 300_000,
      maxAttempts: 5,
    })
    expect(JSON.stringify(config)).not.toMatch(/postgres(?:ql)?:\/\//i)
  })

  it('requires both credential references in PostgreSQL mode', () => {
    expect(() => createApiRuntimeConfig({
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
    })).toThrow('control-plane credential reference')
    expect(() => createApiRuntimeConfig({
      queryMode: 'postgresql',
      controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    })).toThrow('server-side credential reference')
  })

  it('requires separate production role references for warehouse reads and control-plane writes', () => {
    expect(() => createApiRuntimeConfig({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'vault://chatbi/shared/database-role',
      controlPlaneCredentialRef: 'vault://chatbi/shared/database-role',
    })).toThrow('must be different')
    expect(createApiRuntimeConfig({
      environment: 'production',
      ...postgresCredentials,
    }).controlPlane.sslMode).toBe('verify-full')
  })

  it('forces signed HTTP outbox only for staging/production PostgreSQL deployments', () => {
    expect(createApiRuntimeConfig({ environment: 'production', queryMode: 'fixture' }).outbox.mode)
      .toBe('disabled')
    expect(createApiRuntimeConfig({
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    }).outbox.mode).toBe('disabled')
    expect(() => createApiRuntimeConfig({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
      outboxMode: 'disabled',
    })).toThrow('requires HTTP outbox delivery')
    expect(() => createApiRuntimeConfig({
      environment: 'production',
      queryMode: 'postgresql',
      queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
      controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    })).toThrow('endpoint URL')
    expect(() => createApiRuntimeConfig({
      environment: 'test',
      queryMode: 'fixture',
      outboxMode: 'http',
      outboxEndpointUrl: 'https://events.example.com/chatbi',
      outboxHmacSecretRef: 'env:CHATBI_OUTBOX_HMAC_SECRET',
    })).toThrow('requires PostgreSQL')
  })

  it('requires a credential-free HTTPS endpoint and env:CHATBI_* HMAC reference', () => {
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxEndpointUrl: 'http://events.example.com/chatbi',
    })).toThrow('HTTPS')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxEndpointUrl: 'https://user:password@events.example.com/chatbi',
    })).toThrow('userinfo')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxEndpointUrl: 'https://events.example.com/chatbi#secret',
    })).toThrow('fragment')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxEndpointUrl: 'https://events.example.com/chatbi?token=secret',
    })).toThrow('query parameters')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxHmacSecretRef: 'vault://chatbi/outbox-secret',
    })).toThrow('env:CHATBI_')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      queryCredentialRef: 'env:CHATBI_OUTBOX_HMAC_SECRET',
    })).toThrow('dedicated')
    expect(JSON.stringify(createApiRuntimeConfig(postgresCredentials).outbox)).not.toContain('change-me')
  })

  it('enforces bounded outbox polling, leases, HTTP timeouts, retry and attempts', () => {
    expect(createApiRuntimeConfig({
      ...postgresCredentials,
      outboxPollMs: 25,
      outboxLeaseMs: 120_001,
      outboxHttpTimeoutMs: 120_000,
      outboxRetryInitialMs: 100,
      outboxRetryMaxMs: 86_400_000,
      outboxMaxAttempts: 100,
    }).outbox).toMatchObject({
      pollMs: 25,
      leaseMs: 120_001,
      httpTimeoutMs: 120_000,
      retryInitialMs: 100,
      retryMaxMs: 86_400_000,
      maxAttempts: 100,
    })
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, outboxPollMs: 24 }))
      .toThrow('between 25 and 60000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, outboxHttpTimeoutMs: 99 }))
      .toThrow('between 100 and 120000')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxLeaseMs: 10_000,
      outboxHttpTimeoutMs: 10_000,
    })).toThrow('lease must be greater')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      outboxRetryInitialMs: 1_001,
      outboxRetryMaxMs: 1_000,
    })).toThrow('cannot be less')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, outboxMaxAttempts: 101 }))
      .toThrow('between 1 and 100')
  })

  it('rejects database URLs where opaque credential references are required', () => {
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      controlPlaneCredentialRef: 'postgresql://admin:secret@private-db/chatbi',
    })).toThrow('not a database URL')
    expect(() => createApiRuntimeConfig({
      ...postgresCredentials,
      queryCredentialRef: 'postgres://reader:secret@private-db/warehouse',
    })).toThrow('not a database URL')
  })

  it('reserves enough control-plane pool capacity for an API transaction and worker commit', () => {
    expect(createApiRuntimeConfig({ ...postgresCredentials, controlPlanePoolMax: 2 }).controlPlane.poolMax).toBe(2)
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlanePoolMax: 1 }))
      .toThrow('at least 2')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlanePoolMax: 101 }))
      .toThrow('between 1 and 100')
  })

  it('enforces cancellation polling, connection lifetime and drain boundaries', () => {
    expect(createApiRuntimeConfig({
      ...postgresCredentials,
      controlPlaneCancellationPollMs: 25,
      controlPlaneWorkerDrainMs: 0,
    }).controlPlane).toMatchObject({ cancellationPollMs: 25, workerDrainMs: 0 })

    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneCancellationPollMs: 24 }))
      .toThrow('between 25 and 60000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneCancellationPollMs: '25ms' }))
      .toThrow('between 25 and 60000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneWorkerDrainMs: -1 }))
      .toThrow('between 0 and 300000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneConnectTimeoutMs: 0 }))
      .toThrow('between 1 and 120000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneIdleTimeoutMs: 600_001 }))
      .toThrow('between 1 and 600000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneReconcileIntervalMs: 999 }))
      .toThrow('between 1000 and 3600000')
    expect(() => createApiRuntimeConfig({ ...postgresCredentials, controlPlaneReconcileBatchSize: 501 }))
      .toThrow('between 1 and 500')
  })

  it('provides safe local defaults without requiring production credentials', () => {
    const config = createApiRuntimeConfig({ queryMode: 'fixture' })
    expect(config.controlPlane).toEqual({
      credentialRef: undefined,
      sslMode: 'disable',
      poolMax: 4,
      connectTimeoutMs: 5_000,
      idleTimeoutMs: 30_000,
      cancellationPollMs: 250,
      workerDrainMs: 30_000,
      reconcileIntervalMs: 30_000,
      reconcileBatchSize: 100,
    })
    expect(config.outbox).toMatchObject({
      mode: 'disabled',
      pollMs: 250,
      leaseMs: 30_000,
      httpTimeoutMs: 10_000,
      retryInitialMs: 1_000,
      retryMaxMs: 300_000,
      maxAttempts: 5,
    })
  })
})
