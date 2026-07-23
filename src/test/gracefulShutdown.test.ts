import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  bindGracefulShutdown,
  type GracefulShutdownSignal,
} from '../../apps/api/src/gracefulShutdown'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function signalSource() {
  const emitter = new EventEmitter()
  return {
    emitter,
    source: {
      on(signal: GracefulShutdownSignal, listener: () => void) {
        emitter.on(signal, listener)
      },
      removeListener(signal: GracefulShutdownSignal, listener: () => void) {
        emitter.removeListener(signal, listener)
      },
    },
  }
}

describe('graceful shutdown binding', () => {
  it('stops HTTP admission and starts runtime drain immediately and only once', async () => {
    const signals = signalSource()
    const runtimeClose = deferred<void>()
    let serverCallback: ((error?: Error) => void) | undefined
    const close = vi.fn((callback: (error?: Error) => void) => {
      serverCallback = callback
    })
    const closeAllConnections = vi.fn(() => {
      serverCallback?.()
    })
    const runtime = { close: vi.fn(() => runtimeClose.promise) }
    const binding = bindGracefulShutdown({
      server: { close, closeAllConnections },
      runtime,
      signalSource: signals.source,
    })

    signals.emitter.emit('SIGTERM')

    expect(close).toHaveBeenCalledTimes(1)
    expect(runtime.close).toHaveBeenCalledTimes(1)
    expect(closeAllConnections).not.toHaveBeenCalled()
    signals.emitter.emit('SIGINT')
    expect(close).toHaveBeenCalledTimes(1)
    expect(runtime.close).toHaveBeenCalledTimes(1)

    runtimeClose.resolve()
    const completion = binding.shutdown()
    await completion

    expect(closeAllConnections).toHaveBeenCalledTimes(1)
  })

  it('consumes runtime failures, closes residual connections and reports only a safe summary', async () => {
    const signals = signalSource()
    const unsafe = new Error('postgresql://user:secret@host/database')
    unsafe.name = 'RuntimeCloseError'
    const onError = vi.fn(() => {
      throw new Error('telemetry unavailable')
    })
    let serverCallback: ((error?: Error) => void) | undefined
    const closeAllConnections = vi.fn(() => serverCallback?.())
    const binding = bindGracefulShutdown({
      server: {
        close(callback) {
          serverCallback = callback
        },
        closeAllConnections,
      },
      runtime: { close: () => Promise.reject(unsafe) },
      signalSource: signals.source,
      onError,
    })

    await expect(binding.shutdown()).resolves.toBeUndefined()

    expect(closeAllConnections).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith({ phase: 'runtime_close', name: 'RuntimeCloseError' })
    expect(JSON.stringify(onError.mock.calls)).not.toContain('secret')
  })

  it('handles synchronous server/runtime failures and can dispose signal listeners', async () => {
    const signals = signalSource()
    const onError = vi.fn()
    const binding = bindGracefulShutdown({
      server: {
        close() {
          throw Object.assign(new Error('server detail'), { name: 'ServerCloseError' })
        },
        closeAllConnections() {
          throw Object.assign(new Error('socket detail'), { name: 'ConnectionCloseError' })
        },
      },
      runtime: {
        close() {
          throw Object.assign(new Error('runtime detail'), { name: 'RuntimeCloseError' })
        },
      },
      signalSource: signals.source,
      onError,
    })

    await expect(binding.shutdown()).resolves.toBeUndefined()
    expect(onError.mock.calls.map(([summary]) => summary)).toEqual([
      { phase: 'server_close', name: 'ServerCloseError' },
      { phase: 'runtime_close', name: 'RuntimeCloseError' },
      { phase: 'connection_close', name: 'ConnectionCloseError' },
    ])

    binding.dispose()
    expect(signals.emitter.listenerCount('SIGINT')).toBe(0)
    expect(signals.emitter.listenerCount('SIGTERM')).toBe(0)
  })
})
