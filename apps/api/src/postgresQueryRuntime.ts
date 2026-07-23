import type { ApiRuntimeConfig } from './config'
import { createPostgresPool, createPostgresQueryAdapter } from './adapters/postgresQueryAdapter'
import { createPostgresQueryControlPlane } from './adapters/postgresQueryControlPlane'
import { createPostgresOutboxStore } from './adapters/postgresOutboxStore'
import { createPostgresResultPageStore, createPostgresRunEventStore } from './adapters/postgresResultEventStore'
import { createPostgresRunJobQueue } from './adapters/postgresRunJobQueue'
import { createPostgresQueryReconciler } from './adapters/postgresQueryReconciler'
import { createS3ResultBlobStore } from './adapters/s3ResultBlobStore'
import { createBlobBackedResultPageResolver } from './adapters/blobBackedResultPageResolver'
import {
  createQueryWorkerHost,
  type QueryWorkerCycleSummary,
  type QueryWorkerErrorSummary,
  type QueryWorkerStopResult,
} from './queryWorkerHost'
import { createQueryReconcilerHost, type QueryReconcilerReadiness } from './queryReconcilerHost'
import { createDurableOutboxPublisher } from '../../../src/application/outboxPublisher'
import {
  createOutboxPublisherHost,
  type OutboxPublisherReadiness,
} from './outboxPublisherHost'
import { createOutboxHttpTransport } from './outboxHttpTransport'
import {
  createTransactionalQueryExecutionCoordinator,
  type TransactionalQueryExecutionControlPlane,
  type TransactionalQueryRunEvent,
  type TransactionalResultManifestMetadata,
  type TransactionalStoredResultPage,
} from './transactionalQueryExecutionCoordinator'
import type { QueryRunJobPayload, QueryRunJobPublication } from '../../../src/application/queryExecutionCoordinator'
import type {
  PublishedResultPageResolver,
  ResultPageStore,
  RunEventStore,
} from '../../../src/persistence/resultPorts'
import type { TransactionalResultPage } from './transactionalQueryExecutionCoordinator'

export interface PostgresQueryRuntimeOptions {
  config: ApiRuntimeConfig
  resolveCredential(reference: string): string
}

export interface PostgresQueryRuntimeReadiness {
  ok: boolean
  query: 'checking' | 'ok' | 'failed'
  controlPlane: 'checking' | 'ok' | 'failed'
  worker: {
    running: boolean
    draining: boolean
    active: boolean
    lastCycle?: QueryWorkerCycleSummary
    lastError?: QueryWorkerErrorSummary
  }
  reconciler: QueryReconcilerReadiness
  outbox: OutboxPublisherReadiness & {
    mode: ApiRuntimeConfig['outbox']['mode']
  }
  shutdown: {
    closing: boolean
    resourcesClosed: boolean
    lastError?: { name: string; at: string }
  }
}

export interface PostgresQueryRuntime {
  controlPlane: TransactionalQueryExecutionControlPlane
  resultPageStore: ResultPageStore<TransactionalStoredResultPage, TransactionalResultManifestMetadata>
  resultPageResolver?: PublishedResultPageResolver<
    TransactionalResultPage,
    TransactionalResultManifestMetadata
  >
  runEventStore: RunEventStore<TransactionalQueryRunEvent>
  start(): void
  runOnce(): Promise<{ status: string }>
  reconcileOnce(): Promise<{ scanned: number; repaired: number; alerted: number }>
  publishOutboxOnce(): Promise<{ status: string }>
  checkReadiness(): Promise<PostgresQueryRuntimeReadiness>
  readiness(): PostgresQueryRuntimeReadiness
  close(): Promise<QueryWorkerStopResult>
}

/**
 * Owns the production query execution resources. Warehouse SQL and mutable
 * control-plane state deliberately use separate pools and credential refs.
 */
export function createPostgresQueryRuntime(options: PostgresQueryRuntimeOptions): PostgresQueryRuntime {
  if (options.config.query.mode !== 'postgresql') {
    throw new Error('PostgreSQL query runtime requires query.mode=postgresql')
  }
  const queryReference = requiredReference(options.config.query.credentialRef, 'query')
  const controlPlaneReference = requiredReference(options.config.controlPlane.credentialRef, 'control-plane')
  const queryConnectionString = requiredConnectionString(options.resolveCredential(queryReference), 'query')
  const controlPlaneConnectionString = requiredConnectionString(
    options.resolveCredential(controlPlaneReference),
    'control-plane',
  )
  const outboxEndpoint = options.config.outbox.mode === 'http'
    ? requiredConfiguredValue(options.config.outbox.endpointUrl, 'outbox endpoint')
    : undefined
  const outboxHmacSecret = options.config.outbox.mode === 'http'
    ? requiredSecret(options.resolveCredential(
        requiredReference(options.config.outbox.hmacSecretRef, 'outbox HMAC secret'),
      ))
    : undefined
  const resultBlobStore = options.config.resultStorage.mode === 's3'
    ? createS3ResultBlobStore({
        endpoint: requiredConfiguredValue(options.config.resultStorage.endpoint, 'result storage endpoint'),
        region: requiredConfiguredValue(options.config.resultStorage.region, 'result storage region'),
        bucket: requiredConfiguredValue(options.config.resultStorage.bucket, 'result storage bucket'),
        credentialRef: requiredReference(
          options.config.resultStorage.credentialRef,
          'result storage credential',
        ),
        resolveCredentials(reference) {
          return parseResultStorageCredentials(options.resolveCredential(reference))
        },
        defaultTimeoutMs: options.config.resultStorage.timeoutMs,
        maxBlobBytes: options.config.resultStorage.maxBlobBytes,
      })
    : undefined
  if ((options.config.environment === 'staging' || options.config.environment === 'production')
    && queryConnectionString === controlPlaneConnectionString) {
    throw new Error('Production warehouse and control-plane credentials must resolve to different database roles')
  }
  if (
    outboxHmacSecret
    && (outboxHmacSecret === queryConnectionString || outboxHmacSecret === controlPlaneConnectionString)
  ) {
    throw new Error('Outbox HMAC secret must not reuse a database credential')
  }

  const querySsl = options.config.query.sslMode === 'disable'
    ? false
    : { rejectUnauthorized: options.config.query.sslMode === 'verify-full' }
  const controlPlaneSsl = options.config.controlPlane.sslMode === 'disable'
    ? false
    : { rejectUnauthorized: options.config.controlPlane.sslMode === 'verify-full' }
  const queryPool = createPostgresPool({
    connectionString: queryConnectionString,
    max: options.config.query.poolMax,
    connectionTimeoutMillis: options.config.query.connectTimeoutMs,
    idleTimeoutMillis: options.config.query.idleTimeoutMs,
    application_name: 'insightflow-query-readonly',
    ssl: querySsl,
  })
  const controlPlanePool = createPostgresPool({
    connectionString: controlPlaneConnectionString,
    max: options.config.controlPlane.poolMax,
    connectionTimeoutMillis: options.config.controlPlane.connectTimeoutMs,
    idleTimeoutMillis: options.config.controlPlane.idleTimeoutMs,
    application_name: 'insightflow-control-plane',
    ssl: controlPlaneSsl,
  })
  const controlPlaneCancellationPool = createPostgresPool({
    connectionString: controlPlaneConnectionString,
    max: Math.max(1, Math.min(2, options.config.controlPlane.poolMax)),
    connectionTimeoutMillis: options.config.controlPlane.connectTimeoutMs,
    idleTimeoutMillis: options.config.controlPlane.idleTimeoutMs,
    application_name: 'insightflow-control-plane-cancellation',
    ssl: controlPlaneSsl,
  })
  const adapter = createPostgresQueryAdapter({
    pool: queryPool,
    dataSourceId: 'warehouse_sales',
    maxStatementTimeoutMs: options.config.query.statementTimeoutMs,
  })
  const outboxStore = createPostgresOutboxStore({
    pool: controlPlanePool,
  })
  const controlPlane = createPostgresQueryControlPlane<
    QueryRunJobPayload,
    QueryRunJobPublication,
    TransactionalQueryRunEvent,
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >({
    pool: controlPlanePool,
    transactionalOutbox: {
      async enqueueWithClient(client, input) {
        return await outboxStore.enqueueWithClient(client, {
          ...input,
          maxAttempts: input.maxAttempts ?? options.config.outbox.maxAttempts,
        })
      },
    },
  })
  const queue = createPostgresRunJobQueue<QueryRunJobPayload, QueryRunJobPublication>({
    pool: controlPlanePool,
    cancellationPollMs: options.config.controlPlane.cancellationPollMs,
  })
  const resultPageStore = createPostgresResultPageStore<
    TransactionalStoredResultPage,
    TransactionalResultManifestMetadata
  >({ pool: controlPlanePool })
  const resultPageResolver = resultBlobStore
    ? createBlobBackedResultPageResolver({ resultPageStore, blobStore: resultBlobStore })
    : undefined
  const runEventStore = createPostgresRunEventStore<TransactionalQueryRunEvent>({
    pool: controlPlanePool,
    cancellationPool: controlPlaneCancellationPool,
  })
  const reconciler = createPostgresQueryReconciler({
    pool: controlPlanePool,
    maxBatchSize: options.config.controlPlane.reconcileBatchSize,
  })
  const outboxPublisher = options.config.outbox.mode === 'http'
    ? createDurableOutboxPublisher({
        outbox: outboxStore,
        transport: createOutboxHttpTransport({
          endpoint: outboxEndpoint!,
          hmacSecret: outboxHmacSecret!,
          timeoutMs: options.config.outbox.httpTimeoutMs,
        }),
        publisherId: `outbox-publisher:${globalThis.crypto.randomUUID()}`,
        leaseMs: options.config.outbox.leaseMs,
        retryPolicy: {
          initialDelayMs: options.config.outbox.retryInitialMs,
          maxDelayMs: options.config.outbox.retryMaxMs,
        },
      })
    : undefined
  const outboxHost = outboxPublisher
    ? createOutboxPublisherHost({
        publisher: outboxPublisher,
        pollIntervalMs: options.config.outbox.pollMs,
      })
    : undefined

  const closedResource = {
    outbox: false,
    queue: false,
    adapter: false,
    controlPlane: false,
    controlPlaneCancellation: false,
  }
  let resourcesClosed = false
  let closing = false
  let closeResourcesOperation: Promise<void> | undefined
  let closeOperation: Promise<QueryWorkerStopResult> | undefined
  let deferredCloseOperation: Promise<void> | undefined
  let lastCloseError: { name: string; at: string } | undefined
  let queryStatus: PostgresQueryRuntimeReadiness['query'] = 'checking'
  let controlPlaneStatus: PostgresQueryRuntimeReadiness['controlPlane'] = 'checking'
  let executionRunner: ReturnType<typeof createTransactionalQueryExecutionCoordinator> | undefined
  const worker = createQueryWorkerHost({
    pollIntervalMs: options.config.query.workerPollMs,
    createRunner(workerId) {
      executionRunner = createTransactionalQueryExecutionCoordinator({
        adapter,
        queue,
        controlPlane,
        workerId,
        leaseMs: options.config.query.leaseMs,
        resultBlobStore,
      })
      return executionRunner
    },
    abortActive: () => executionRunner?.abortActive(),
  })
  const reconcilerHost = createQueryReconcilerHost({
    reconciler,
    intervalMs: options.config.controlPlane.reconcileIntervalMs,
    batchLimit: options.config.controlPlane.reconcileBatchSize,
  })

  async function closeResources() {
    if (resourcesClosed) return
    if (closeResourcesOperation) return await closeResourcesOperation
    closeResourcesOperation = (async () => {
      const failures: unknown[] = []
      for (const resource of [
        { key: 'outbox' as const, close: () => outboxStore.close() },
        { key: 'queue' as const, close: () => queue.close() },
        { key: 'adapter' as const, close: () => adapter.close() },
        { key: 'controlPlane' as const, close: () => controlPlanePool.end() },
        { key: 'controlPlaneCancellation' as const, close: () => controlPlaneCancellationPool.end() },
      ]) {
        if (closedResource[resource.key]) continue
        try {
          await resource.close()
          closedResource[resource.key] = true
        } catch (error) {
          failures.push(error)
        }
      }
      resourcesClosed = Object.values(closedResource).every(Boolean)
      if (failures.length > 0) {
        const failure = new AggregateError(failures, 'PostgreSQL query runtime close failed')
        lastCloseError = safeShutdownError(failure)
        throw failure
      }
      lastCloseError = undefined
    })()
    try {
      await closeResourcesOperation
    } finally {
      closeResourcesOperation = undefined
    }
  }

  function readiness(): PostgresQueryRuntimeReadiness {
    const workerState = worker.readiness()
    const reconcilerState = reconcilerHost.readiness()
    const outboxState: PostgresQueryRuntimeReadiness['outbox'] = outboxHost
      ? { mode: 'http', ...outboxHost.readiness() }
      : {
          mode: 'disabled',
          running: false,
          draining: false,
          active: false,
          initialized: false,
          deliveryDegraded: false,
          consecutiveDeliveryFailures: 0,
          deadLetteredSinceStart: 0,
        }
    const publicWorkerState = {
      running: workerState.running,
      draining: workerState.draining,
      active: workerState.active,
      ...(workerState.lastCycle ? { lastCycle: workerState.lastCycle } : {}),
      ...(workerState.lastError ? { lastError: workerState.lastError } : {}),
    }
    return {
      ok: !resourcesClosed
        && !closing
        && queryStatus === 'ok'
        && controlPlaneStatus === 'ok'
        && workerState.running
        && !workerState.draining
        && !workerState.lastError
        && reconcilerState.running
        && reconcilerState.initialized
        && !reconcilerState.draining
        && !reconcilerState.lastError
        && (outboxState.mode === 'disabled'
          || (outboxState.running
            && outboxState.initialized
            && !outboxState.draining
            && !outboxState.deliveryDegraded
            && !outboxState.lastError)),
      query: queryStatus,
      controlPlane: controlPlaneStatus,
      worker: publicWorkerState,
      reconciler: reconcilerState,
      outbox: outboxState,
      shutdown: {
        closing,
        resourcesClosed,
        ...(lastCloseError ? { lastError: { ...lastCloseError } } : {}),
      },
    }
  }

  return {
    controlPlane,
    resultPageStore,
    resultPageResolver,
    runEventStore,
    start() {
      if (closing || resourcesClosed) throw new Error('PostgreSQL query runtime is closing or closed')
      worker.start()
      reconcilerHost.start()
      outboxHost?.start()
    },
    async runOnce() {
      if (closing || resourcesClosed) throw new Error('PostgreSQL query runtime is closing or closed')
      return await worker.runOnce()
    },
    async reconcileOnce() {
      if (closing || resourcesClosed) throw new Error('PostgreSQL query runtime is closing or closed')
      const report = await reconcilerHost.runOnce()
      return { scanned: report.scanned, repaired: report.repaired, alerted: report.alerted }
    },
    async publishOutboxOnce() {
      if (closing || resourcesClosed) throw new Error('PostgreSQL query runtime is closing or closed')
      return outboxHost ? await outboxHost.runOnce() : { status: 'idle' }
    },
    async checkReadiness() {
      if (closing || resourcesClosed) return readiness()
      const [queryCheck, controlPlaneCheck] = await Promise.allSettled([
        adapter.readiness(),
        controlPlane.readiness(),
      ])
      queryStatus = queryCheck.status === 'fulfilled' ? 'ok' : 'failed'
      controlPlaneStatus = controlPlaneCheck.status === 'fulfilled' ? 'ok' : 'failed'
      return readiness()
    },
    readiness,
    async close() {
      if (resourcesClosed) return { drained: true, timedOut: false }
      if (closeOperation) return await closeOperation
      closing = true
      const operation = (async () => {
        const [workerStop, reconcilerStop, outboxStop] = await Promise.all([
          worker.stop({ drainMs: options.config.controlPlane.workerDrainMs }),
          reconcilerHost.stop({ drainMs: options.config.controlPlane.workerDrainMs }),
          outboxHost?.stop({ drainMs: options.config.controlPlane.workerDrainMs })
            ?? Promise.resolve({ drained: true, timedOut: false }),
        ])
        const cyclesDrained = workerStop.drained && reconcilerStop.drained && outboxStop.drained
        const cyclesTimedOut = workerStop.timedOut || reconcilerStop.timedOut || outboxStop.timedOut
        if (!cyclesDrained) {
          scheduleDeferredClose()
          return { drained: false, timedOut: true }
        }

        const resourceClose = closeResources()
        const closedInTime = await waitForOperation(
          resourceClose,
          Math.max(1_000, options.config.controlPlane.workerDrainMs),
        )
        if (!closedInTime) {
          lastCloseError = { name: 'PostgresRuntimeCloseTimeout', at: new Date().toISOString() }
          void resourceClose
            .catch((error) => {
              lastCloseError = safeShutdownError(error)
            })
            .finally(() => {
              closing = false
            })
          return { drained: false, timedOut: true }
        }
        closing = false
        return { drained: true, timedOut: cyclesTimedOut }
      })()
      closeOperation = operation
      try {
        return await operation
      } catch (error) {
        lastCloseError = safeShutdownError(error)
        closing = false
        throw error
      } finally {
        if (closeOperation === operation) closeOperation = undefined
      }
    },
  }

  function scheduleDeferredClose() {
    if (deferredCloseOperation) return
    const operation = (async () => {
      const inactive = await waitUntilInactive(
        worker,
        reconcilerHost,
        outboxHost,
        Math.max(1_000, options.config.controlPlane.workerDrainMs),
      )
      if (!inactive) {
        lastCloseError = { name: 'PostgresRuntimeDrainTimeout', at: new Date().toISOString() }
        return
      }
      const closedInTime = await waitForOperation(
        closeResources(),
        Math.max(1_000, options.config.controlPlane.workerDrainMs),
      )
      if (!closedInTime) {
        lastCloseError = { name: 'PostgresRuntimeCloseTimeout', at: new Date().toISOString() }
      }
    })()
    deferredCloseOperation = operation
    void operation
      .catch((error) => {
        lastCloseError = safeShutdownError(error)
      })
      .finally(() => {
        if (deferredCloseOperation === operation) deferredCloseOperation = undefined
        closing = false
      })
  }
}

async function waitUntilInactive(
  worker: { readiness(): { active: boolean } },
  reconciler: { readiness(): { active: boolean } },
  outbox: { readiness(): { active: boolean } } | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = monotonicNow() + timeoutMs
  while (worker.readiness().active || reconciler.readiness().active || outbox?.readiness().active) {
    const remainingMs = deadline - monotonicNow()
    if (remainingMs <= 0) return false
    await unrefDelay(Math.min(25, remainingMs))
  }
  return true
}

async function waitForOperation(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  const completed = operation.then(() => true)
  try {
    return await Promise.race([completed, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}

function monotonicNow() {
  return globalThis.performance?.now?.() ?? Date.now()
}

function safeShutdownError(error: unknown) {
  return {
    name: error instanceof Error && error.name ? error.name : 'UnknownError',
    at: new Date().toISOString(),
  }
}

function requiredReference(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`PostgreSQL ${label} credential reference is missing`)
  return value
}

function requiredConnectionString(value: string, label: string) {
  if (!value?.trim()) throw new Error(`PostgreSQL ${label} credential could not be resolved`)
  return value.trim()
}

function requiredSecret(value: string) {
  if (!value?.trim() || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('PostgreSQL outbox HMAC secret must resolve to at least 32 bytes')
  }
  return value
}

function parseResultStorageCredentials(value: string) {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      !parsed
      || typeof parsed !== 'object'
      || Array.isArray(parsed)
      || typeof parsed.accessKeyId !== 'string'
      || typeof parsed.secretAccessKey !== 'string'
      || (parsed.sessionToken !== undefined && typeof parsed.sessionToken !== 'string')
    ) {
      throw new Error('invalid credential bundle')
    }
    return {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey,
      ...(typeof parsed.sessionToken === 'string' ? { sessionToken: parsed.sessionToken } : {}),
    }
  } catch {
    throw new Error('Result storage credential bundle could not be resolved')
  }
}

function requiredConfiguredValue(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`PostgreSQL ${label} is missing`)
  return value
}
