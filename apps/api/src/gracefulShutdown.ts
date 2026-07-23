export type GracefulShutdownSignal = 'SIGINT' | 'SIGTERM'

export interface GracefulShutdownSignalSource {
  on(signal: GracefulShutdownSignal, listener: () => void): unknown
  removeListener?(signal: GracefulShutdownSignal, listener: () => void): unknown
}

export interface GracefulShutdownServer {
  close(callback: (error?: Error) => void): unknown
  closeAllConnections(): void
}

export interface GracefulShutdownRuntime {
  close(): unknown | Promise<unknown>
}

export interface GracefulShutdownErrorSummary {
  phase: 'server_close' | 'runtime_close' | 'connection_close'
  name: string
}

export interface GracefulShutdownBinding {
  shutdown(): Promise<void>
  dispose(): void
}

export interface GracefulShutdownOptions {
  server: GracefulShutdownServer
  runtime: GracefulShutdownRuntime
  signalSource: GracefulShutdownSignalSource
  onError?(summary: GracefulShutdownErrorSummary): void
}

/**
 * Coordinates process shutdown without owning process termination. The first
 * signal stops admission and starts runtime drain in the same turn. Once the
 * runtime settles, residual HTTP connections are closed so server.close can
 * finish even when a client never cooperates.
 */
export function bindGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdownBinding {
  let shutdownOperation: Promise<void> | undefined
  let disposed = false

  const report = (phase: GracefulShutdownErrorSummary['phase'], error: unknown) => {
    try {
      options.onError?.({
        phase,
        name: error instanceof Error && error.name ? error.name : 'UnknownError',
      })
    } catch {
      // Reporting must never turn a handled shutdown failure into a rejection.
    }
  }

  const shutdown = () => {
    if (shutdownOperation) return shutdownOperation

    let settleServer!: () => void
    const serverSettled = new Promise<void>((resolve) => {
      settleServer = resolve
    })
    try {
      options.server.close((error) => {
        if (error) report('server_close', error)
        settleServer()
      })
    } catch (error) {
      report('server_close', error)
      settleServer()
    }

    let runtimeClose: Promise<unknown>
    try {
      runtimeClose = Promise.resolve(options.runtime.close())
    } catch (error) {
      runtimeClose = Promise.reject(error)
    }

    const runtimeSettled = runtimeClose.then(
      () => undefined,
      (error) => {
        report('runtime_close', error)
      },
    ).then(() => {
      try {
        options.server.closeAllConnections()
      } catch (error) {
        report('connection_close', error)
      }
    })

    // Both branches consume their own errors, so signal listeners can safely
    // fire-and-forget this operation without an unhandled rejection.
    shutdownOperation = Promise.all([serverSettled, runtimeSettled]).then(() => undefined)
    return shutdownOperation
  }

  const onSignal = () => {
    void shutdown()
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) options.signalSource.on(signal, onSignal)

  return {
    shutdown,
    dispose() {
      if (disposed) return
      disposed = true
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        options.signalSource.removeListener?.(signal, onSignal)
      }
    },
  }
}
