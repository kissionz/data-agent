import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryReconcilerHost } from '../../apps/api/src/queryReconcilerHost'
import type { QueryReconciliationBatchReport } from '../persistence/queryReconcilerPorts'

const at = '2026-07-15T19:00:00.000Z'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function report(patch: Partial<QueryReconciliationBatchReport> = {}): QueryReconciliationBatchReport {
  return { scanned: 1, repaired: 1, alerted: 0, findings: [], ...patch }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('query reconciler host', () => {
  it('runs periodic batches without overlap and stores aggregate readiness only', async () => {
    vi.useFakeTimers()
    const first = deferred<QueryReconciliationBatchReport>()
    const reconcileBatch = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(report({ scanned: 0, repaired: 0 }))
    const host = createQueryReconcilerHost({
      reconciler: { reconcileBatch },
      intervalMs: 50,
      batchLimit: 25,
      now: () => at,
    })

    host.start()
    expect(host.readiness()).toMatchObject({ running: true, active: false, initialized: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness()).toMatchObject({ running: true, active: true, initialized: false })
    expect(reconcileBatch).toHaveBeenCalledTimes(1)
    expect(reconcileBatch).toHaveBeenCalledWith({ now: at, limit: 25 })
    await vi.advanceTimersByTimeAsync(500)
    expect(reconcileBatch).toHaveBeenCalledTimes(1)

    first.resolve(report({
      findings: [{
        tenantId: 'tenant_secret',
        workspaceId: 'workspace_secret',
        runId: 'run_secret',
        code: 'missing_conversation',
        severity: 'critical',
        findingId: 'finding_secret',
        disposition: 'alerted',
      }],
    }))
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness()).toMatchObject({
      running: true,
      active: false,
      initialized: true,
      lastBatch: { scanned: 1, repaired: 1, alerted: 0, at },
    })
    expect(JSON.stringify(host.readiness())).not.toContain('secret')

    await vi.advanceTimersByTimeAsync(50)
    expect(reconcileBatch).toHaveBeenCalledTimes(2)
    await host.stop({ drainMs: 0 })
  })

  it('coalesces manual and automatic triggers into one active batch', async () => {
    vi.useFakeTimers()
    const active = deferred<QueryReconciliationBatchReport>()
    const reconcileBatch = vi.fn(() => active.promise)
    const host = createQueryReconcilerHost({
      reconciler: { reconcileBatch },
      intervalMs: 100,
      now: () => at,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    const manualA = host.runOnce()
    const manualB = host.runOnce()
    expect(reconcileBatch).toHaveBeenCalledTimes(1)
    expect(manualA).toBe(manualB)

    const completed = report({ scanned: 2 })
    active.resolve(completed)
    await expect(Promise.all([manualA, manualB])).resolves.toEqual([completed, completed])
    await host.stop({ drainMs: 0 })
  })

  it('drains an active batch before stop resolves', async () => {
    vi.useFakeTimers()
    const active = deferred<QueryReconciliationBatchReport>()
    const host = createQueryReconcilerHost({
      reconciler: { reconcileBatch: () => active.promise },
      now: () => at,
    })

    const cycle = host.runOnce()
    const stopping = host.stop({ drainMs: 1_000 })
    expect(host.readiness()).toMatchObject({ running: false, draining: true, active: true })

    active.resolve(report())
    await vi.advanceTimersByTimeAsync(0)
    await expect(cycle).resolves.toMatchObject({ scanned: 1 })
    await expect(stopping).resolves.toEqual({ drained: true, timedOut: false })
    expect(host.readiness()).toMatchObject({ running: false, draining: false, active: false })
  })

  it('returns at the drain deadline while the batch remains single-flight', async () => {
    vi.useFakeTimers()
    const active = deferred<QueryReconciliationBatchReport>()
    const reconcileBatch = vi.fn(() => active.promise)
    const host = createQueryReconcilerHost({ reconciler: { reconcileBatch }, now: () => at })

    const cycle = host.runOnce()
    const stopping = host.stop({ drainMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(stopping).resolves.toEqual({ drained: false, timedOut: true })
    expect(host.readiness()).toMatchObject({ draining: true, active: true })
    expect(host.runOnce()).toBe(cycle)
    expect(reconcileBatch).toHaveBeenCalledTimes(1)

    active.resolve(report())
    await expect(cycle).resolves.toMatchObject({ scanned: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness()).toMatchObject({ draining: false, active: false })
  })

  it('sanitizes failures to name and time and recovers on the next automatic batch', async () => {
    vi.useFakeTimers()
    const unsafe = Object.assign(new Error('postgresql://admin:secret@db/chatbi'), {
      findings: [{ runId: 'run_secret', findingId: 'finding_secret' }],
    })
    unsafe.name = 'PostgresReconciliationError'
    const reconcileBatch = vi.fn()
      .mockRejectedValueOnce(unsafe)
      .mockResolvedValue(report({ scanned: 0, repaired: 0 }))
    const host = createQueryReconcilerHost({
      reconciler: { reconcileBatch },
      intervalMs: 25,
      now: () => at,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness().lastError).toEqual({ name: 'PostgresReconciliationError', at })
    expect(Object.keys(host.readiness().lastError ?? {})).toEqual(['name', 'at'])
    expect(JSON.stringify(host.readiness())).not.toContain('secret')
    expect(JSON.stringify(host.readiness())).not.toContain('postgresql')

    await vi.advanceTimersByTimeAsync(25)
    expect(reconcileBatch).toHaveBeenCalledTimes(2)
    expect(host.readiness()).toMatchObject({ lastBatch: { scanned: 0 } })
    expect(host.readiness().lastError).toBeUndefined()
    await host.stop({ drainMs: 0 })
  })

  it('rejects a manual failure with the same public-safe summary', async () => {
    const error = new Error('password=secret finding=run_private')
    error.name = 'DatabaseError'
    const host = createQueryReconcilerHost({
      reconciler: { async reconcileBatch() { throw error } },
      now: () => at,
    })

    await expect(host.runOnce()).rejects.toEqual({ name: 'DatabaseError', at })
    expect(JSON.stringify(host.readiness())).toBe(JSON.stringify({
      running: false,
      draining: false,
      active: false,
      initialized: false,
      lastError: { name: 'DatabaseError', at },
    }))
  })
})
