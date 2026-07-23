import { describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { createApiRuntimeConfig } from '../../apps/api/src/config'
import { createPostgresQueryRuntime } from '../../apps/api/src/postgresQueryRuntime'

function config() {
  return createApiRuntimeConfig({
    environment: 'production',
    queryMode: 'postgresql',
    queryCredentialRef: 'env:CHATBI_QUERY_DATABASE_URL',
    controlPlaneCredentialRef: 'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
    outboxMode: 'http',
    outboxEndpointUrl: 'https://events.example.com/chatbi',
    outboxHmacSecretRef: 'env:CHATBI_OUTBOX_HMAC_SECRET',
    controlPlaneWorkerDrainMs: 0,
  })
}

describe('PostgreSQL production query runtime resources', () => {
  it('resolves independent warehouse and control-plane credentials and closes without opening a connection', async () => {
    const resolveCredential = vi.fn((reference: string) => reference.includes('CONTROL_PLANE')
      ? 'postgresql://control-plane.invalid/chatbi'
      : reference.includes('OUTBOX')
        ? 'test-only-hmac-secret-with-32-bytes-minimum'
        : 'postgresql://warehouse.invalid/analytics')
    const runtime = createPostgresQueryRuntime({ config: config(), resolveCredential })

    expect(resolveCredential.mock.calls.map(([reference]) => reference)).toEqual([
      'env:CHATBI_QUERY_DATABASE_URL',
      'env:CHATBI_CONTROL_PLANE_DATABASE_URL',
      'env:CHATBI_OUTBOX_HMAC_SECRET',
    ])
    expect(runtime.readiness()).toMatchObject({
      ok: false,
      query: 'checking',
      controlPlane: 'checking',
      worker: { running: false, draining: false, active: false },
      reconciler: { running: false, draining: false, active: false },
      outbox: { mode: 'http', running: false, draining: false, active: false },
    })
    runtime.start()
    expect(runtime.readiness()).toMatchObject({
      ok: false,
      worker: { running: true },
      reconciler: { running: true, initialized: false },
      outbox: { mode: 'http', running: true, initialized: false },
      shutdown: { closing: false, resourcesClosed: false },
    })
    await expect(Promise.all([runtime.close(), runtime.close()])).resolves.toEqual([
      { drained: true, timedOut: false },
      { drained: true, timedOut: false },
    ])
    expect(runtime.readiness()).toMatchObject({
      ok: false,
      shutdown: { closing: false, resourcesClosed: true },
    })
    await expect(runtime.close()).resolves.toEqual({ drained: true, timedOut: false })
  })

  it('fails before pool creation when a referenced credential resolves to an empty value', () => {
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential(reference) {
        return reference.includes('CONTROL_PLANE') ? '' : 'postgresql://warehouse.invalid/analytics'
      },
    })).toThrow('control-plane credential could not be resolved')
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential(reference) {
        if (reference.includes('CONTROL_PLANE')) return 'postgresql://control-plane.invalid/chatbi'
        if (reference.includes('OUTBOX')) return ''
        return 'postgresql://warehouse.invalid/analytics'
      },
    })).toThrow('outbox HMAC secret must resolve to at least 32 bytes')
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential(reference) {
        if (reference.includes('CONTROL_PLANE')) return 'postgresql://control-plane.invalid/chatbi'
        if (reference.includes('OUTBOX')) return 'weak'
        return 'postgresql://warehouse.invalid/analytics'
      },
    })).toThrow('outbox HMAC secret must resolve to at least 32 bytes')
  })

  it('rejects one resolved production database role for both trust boundaries', () => {
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential: () => 'postgresql://shared-role.invalid/chatbi',
    })).toThrow('different database roles')
    expect(() => createPostgresQueryRuntime({
      config: config(),
      resolveCredential(reference) {
        if (reference.includes('CONTROL_PLANE')) return 'postgresql://control-plane.invalid/chatbi'
        return 'x'.repeat(40)
      },
    })).toThrow('must not reuse a database credential')
  })

  it('cannot be created for fixture mode', () => {
    expect(() => createPostgresQueryRuntime({
      config: createApiRuntimeConfig({ queryMode: 'fixture' }),
      resolveCredential: () => 'unused',
    })).toThrow('query.mode=postgresql')
  })

  it('retries only resource closes that failed during the previous close attempt', async () => {
    const end = vi.spyOn(Pool.prototype, 'end')
      .mockRejectedValueOnce(new Error('query pool close failed: secret'))
      .mockResolvedValue(undefined)
    const runtime = createPostgresQueryRuntime({
      config: config(),
      resolveCredential(reference) {
        if (reference.includes('CONTROL_PLANE')) return 'postgresql://control-plane.invalid/chatbi'
        if (reference.includes('OUTBOX')) return 'test-only-hmac-secret-with-32-bytes-minimum'
        return 'postgresql://warehouse.invalid/analytics'
      },
    })

    await expect(runtime.close()).rejects.toThrow('runtime close failed')
    expect(runtime.readiness()).toMatchObject({
      ok: false,
      shutdown: {
        closing: false,
        resourcesClosed: false,
        lastError: { name: 'AggregateError' },
      },
    })
    await expect(runtime.close()).resolves.toEqual({ drained: true, timedOut: false })
    expect(runtime.readiness()).toMatchObject({
      shutdown: { closing: false, resourcesClosed: true },
    })
    // Three pools are attempted once; only the failed query pool is retried.
    expect(end).toHaveBeenCalledTimes(4)
    end.mockRestore()
  })
})
