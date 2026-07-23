import { describe, expect, it } from 'vitest'
import { createApiRuntimeConfig } from '../../apps/api/src/config'

const postgresCredentials = {
  queryMode: 'postgresql' as const,
  queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
  controlPlaneCredentialRef: 'vault://chatbi/production/control-plane',
}

describe('API PostgreSQL control-plane configuration', () => {
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
  })
})
