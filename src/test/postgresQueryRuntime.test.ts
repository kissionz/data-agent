import { describe, expect, it, vi } from 'vitest'
import { createApiRuntimeConfig } from '../../apps/api/src/config'
import { createPostgresQueryRuntime } from '../../apps/api/src/postgresQueryRuntime'

function config() {
  return createApiRuntimeConfig({
    environment: 'production',
    queryMode: 'postgresql',
    queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
    controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    controlPlaneWorkerDrainMs: 0,
  })
}

describe('PostgreSQL production query runtime resources', () => {
  it('resolves independent warehouse and control-plane credentials and closes without opening a connection', async () => {
    const resolveCredential = vi.fn((reference: string) => reference.includes('CONTROL_PLANE')
      ? 'postgresql://control-plane.invalid/chatbi'
      : 'postgresql://warehouse.invalid/analytics')
    const runtime = createPostgresQueryRuntime({ config: config(), resolveCredential })

    expect(resolveCredential.mock.calls.map(([reference]) => reference)).toEqual([
      'env:CHATBI_QUERY_DATABASE_URL',
      'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    ])
    expect(runtime.readiness()).toMatchObject({
      ok: false,
      query: 'checking',
      controlPlane: 'checking',
      worker: { running: false, draining: false, active: false },
    })
    await expect(runtime.close()).resolves.toEqual({ drained: true, timedOut: false })
    await expect(runtime.close()).resolves.toEqual({ drained: true, timedOut: false })
  })

  it('fails before pool creation when a referenced credential resolves to an empty value', () => {
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential(reference) {
        return reference.includes('CONTROL_PLANE') ? '' : 'postgresql://warehouse.invalid/analytics'
      },
    })).toThrow('control-plane credential could not be resolved')
  })

  it('rejects one resolved production database role for both trust boundaries', () => {
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential: () => 'postgresql://shared-role.invalid/chatbi',
    })).toThrow('different database roles')
  })

  it('cannot be created for fixture mode', () => {
    expect(() => createPostgresQueryRuntime({
      config: createApiRuntimeConfig({ queryMode: 'fixture' }),
      resolveCredential: () => 'unused',
    })).toThrow('query.mode=postgresql')
  })
})
