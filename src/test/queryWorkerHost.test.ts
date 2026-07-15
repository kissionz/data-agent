import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryWorkerHost } from '../../apps/api/src/queryWorkerHost'
import type { RunWorkerCycleResult } from '../application/runWorker'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('query worker host', () => {
  it('injects one unique worker id and never overlaps poll cycles', async () => {
    vi.useFakeTimers()
    const first = deferred<RunWorkerCycleResult>()
    let calls = 0
    const runOnce = vi.fn(async () => {
      calls += 1
      if (calls === 1) return await first.promise
      return { status: 'idle' as const }
    })
    const createRunner = vi.fn(() => ({ runOnce }))
    const host = createQueryWorkerHost({
      createRunner,
      workerIdFactory: () => 'query-worker:test:1',
      pollIntervalMs: 50,
    })

    expect(host.workerId).toBe('query-worker:test:1')
    expect(createRunner).toHaveBeenCalledWith('query-worker:test:1')
    host.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(host.readiness()).toMatchObject({ running: true, draining: false, active: true })

    await vi.advanceTimersByTimeAsync(500)
    expect(runOnce).toHaveBeenCalledTimes(1)

    first.resolve({ status: 'completed', runId: 'run_sensitive', attempt: 2 })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(50)
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(host.readiness().lastCycle).toMatchObject({ status: 'idle' })
    expect(JSON.stringify(host.readiness())).not.toContain('run_sensitive')
    await host.stop({ drainMs: 0 })
  })

  it('drains an active cycle before invoking the close hook', async () => {
    vi.useFakeTimers()
    const active = deferred<RunWorkerCycleResult>()
    const close = vi.fn(async () => undefined)
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce: () => active.promise }),
      workerId: 'worker_drain',
      close,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    const stopping = host.stop({ drainMs: 1_000 })
    expect(host.readiness()).toMatchObject({ running: false, draining: true, active: true })
    expect(close).not.toHaveBeenCalled()

    active.resolve({ status: 'idle' })
    await vi.advanceTimersByTimeAsync(0)
    await expect(stopping).resolves.toEqual({ drained: true, timedOut: false })
    expect(close).toHaveBeenCalledTimes(1)
    expect(host.readiness()).toMatchObject({ running: false, draining: false, active: false })
  })

  it('aborts on drain timeout and closes only after the active cycle settles', async () => {
    vi.useFakeTimers()
    const active = deferred<RunWorkerCycleResult>()
    const close = vi.fn(async () => undefined)
    const abortActive = vi.fn(async () => {
      active.resolve({ status: 'cancelled', runId: 'run_1', attempt: 1 })
    })
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce: () => active.promise }),
      workerId: 'worker_timeout',
      abortActive,
      close,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    const stopping = host.stop({ drainMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(stopping).resolves.toEqual({ drained: true, timedOut: true })
    expect(abortActive).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(host.readiness()).toMatchObject({ active: false, draining: false })
  })

  it('returns at the deadline and defers close when an active adapter ignores cancellation', async () => {
    vi.useFakeTimers()
    const active = deferred<RunWorkerCycleResult>()
    const close = vi.fn(async () => undefined)
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce: () => active.promise }),
      workerId: 'worker_uncooperative',
      close,
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    const stopping = host.stop({ drainMs: 100 })
    await vi.advanceTimersByTimeAsync(100)

    await expect(stopping).resolves.toEqual({ drained: false, timedOut: true })
    expect(close).not.toHaveBeenCalled()
    expect(host.readiness()).toMatchObject({ active: true, draining: true })

    active.resolve({ status: 'idle' })
    await vi.advanceTimersByTimeAsync(0)
    expect(close).toHaveBeenCalledTimes(1)
    expect(host.readiness()).toMatchObject({ active: false, draining: false })
    await expect(host.stop({ drainMs: 100 })).resolves.toEqual({ drained: true, timedOut: false })
  })

  it('recovers after a cycle error and exposes no error message or stack', async () => {
    vi.useFakeTimers()
    const runOnce = vi.fn()
      .mockRejectedValueOnce(new Error('password=super-secret'))
      .mockResolvedValue({ status: 'idle' })
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce }),
      workerId: 'worker_recovery',
      pollIntervalMs: 25,
      now: () => '2026-07-15T12:00:00.000Z',
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.readiness().lastError).toEqual({
      kind: 'cycle',
      name: 'Error',
      at: '2026-07-15T12:00:00.000Z',
    })
    expect(JSON.stringify(host.readiness())).not.toContain('super-secret')

    await vi.advanceTimersByTimeAsync(25)
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(host.readiness()).toMatchObject({ active: false, lastCycle: { status: 'idle' } })
    expect(host.readiness().lastError).toBeUndefined()
    await host.stop({ drainMs: 0 })
  })

  it('coalesces manual cycles with an active poll cycle instead of overlapping them', async () => {
    vi.useFakeTimers()
    const active = deferred<RunWorkerCycleResult>()
    const runOnce = vi.fn(() => active.promise)
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce }),
      workerId: 'worker_manual_single_flight',
    })

    host.start()
    await vi.advanceTimersByTimeAsync(0)
    const manualA = host.runOnce()
    const manualB = host.runOnce()
    expect(runOnce).toHaveBeenCalledTimes(1)

    active.resolve({ status: 'completed', runId: 'run_1', attempt: 1 })
    await expect(Promise.all([manualA, manualB])).resolves.toEqual([
      { status: 'completed', runId: 'run_1', attempt: 1 },
      { status: 'completed', runId: 'run_1', attempt: 1 },
    ])
    await host.stop({ drainMs: 0 })
  })

  it('drains a manual cycle before closing resources', async () => {
    vi.useFakeTimers()
    const active = deferred<RunWorkerCycleResult>()
    const close = vi.fn(async () => undefined)
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce: () => active.promise }),
      workerId: 'worker_manual_drain',
      close,
    })

    const cycle = host.runOnce()
    const stopping = host.stop({ drainMs: 1_000 })
    expect(close).not.toHaveBeenCalled()
    expect(host.readiness()).toMatchObject({ active: true, draining: true })

    active.resolve({ status: 'idle' })
    await vi.advanceTimersByTimeAsync(0)
    await expect(cycle).resolves.toEqual({ status: 'idle' })
    await expect(stopping).resolves.toEqual({ drained: true, timedOut: false })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('still closes resources when the cycle being drained rejects', async () => {
    vi.useFakeTimers()
    const active = deferred<RunWorkerCycleResult>()
    const close = vi.fn(async () => undefined)
    const host = createQueryWorkerHost({
      createRunner: () => ({ runOnce: () => active.promise }),
      workerId: 'worker_failed_drain',
      close,
    })

    const cycle = host.runOnce()
    const stopping = host.stop({ drainMs: 1_000 })
    active.reject(new Error('internal database secret'))
    await expect(cycle).rejects.toThrow('internal database secret')
    await vi.advanceTimersByTimeAsync(0)
    await expect(stopping).resolves.toEqual({ drained: true, timedOut: false })
    expect(close).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(host.readiness())).not.toContain('database secret')
  })
})
