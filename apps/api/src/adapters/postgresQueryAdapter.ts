import { Pool, type PoolConfig } from 'pg'
import { assertReadOnlySql } from '../../../../src/query/compiler'
import type {
  QueryAdapter,
  QueryAdapterBlockedOutcome,
  QueryAdapterInput,
  QueryAdapterOutcome,
  QueryExplainEstimate,
  QueryScalar,
} from '../../../../src/query/types'

export type PostgresQueryAdapterErrorCode =
  | 'QUERY_BLOCKED'
  | 'QUERY_CANCELLED'
  | 'QUERY_TIMEOUT'
  | 'QUERY_UNAVAILABLE'
  | 'QUERY_EXECUTION_FAILED'

export class PostgresQueryAdapterError extends Error {
  readonly code: PostgresQueryAdapterErrorCode
  readonly retryable: boolean

  constructor(code: PostgresQueryAdapterErrorCode, message: string, retryable: boolean) {
    super(message)
    this.name = 'PostgresQueryAdapterError'
    this.code = code
    this.retryable = retryable
  }
}

interface PgQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[]
  rowCount: number | null
  fields?: Array<{ name: string; dataTypeID: number }>
}

export interface PostgresPoolClientLike {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>
  release(error?: Error | boolean): void
}

export interface PostgresPoolLike {
  connect(): Promise<PostgresPoolClientLike>
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>
  end?(): Promise<void>
}

export interface PostgresQueryAdapterOptions {
  pool: PostgresPoolLike
  cancellationPool?: PostgresPoolLike
  dataSourceId?: string
  maxStatementTimeoutMs?: number
  now?: () => Date
}

export interface PostgresPoolOptions extends PoolConfig {
  connectionString: string
}

export interface PostgresQueryAdapter extends QueryAdapter {
  readiness(): Promise<{ ok: true }>
  close(): Promise<void>
}

const DEFAULT_MAX_STATEMENT_TIMEOUT_MS = 60_000
const POSTGRES_QUERY_CANCELLED = '57014'

/**
 * Node-only PostgreSQL executor. Keep this module out of browser-safe package indexes.
 */
export function createPostgresQueryAdapter(options: PostgresQueryAdapterOptions): PostgresQueryAdapter {
  const cancellationPool = options.cancellationPool ?? options.pool
  const dataSourceId = options.dataSourceId ?? 'warehouse_sales'
  const maxStatementTimeoutMs = options.maxStatementTimeoutMs ?? DEFAULT_MAX_STATEMENT_TIMEOUT_MS
  const now = options.now ?? (() => new Date())

  if (!Number.isInteger(maxStatementTimeoutMs) || maxStatementTimeoutMs < 1) {
    throw blocked('查询超时上限配置无效。')
  }

  return {
    dialect: 'postgresql',

    async runReadOnly(input, signal) {
      assertExecutableInput(input, maxStatementTimeoutMs, dataSourceId)
      throwIfAborted(signal)

      let client: PostgresPoolClientLike
      try {
        client = await acquireClient(options.pool, signal)
      } catch (error) {
        if (error instanceof PostgresQueryAdapterError) throw error
        throw unavailable()
      }

      let transactionStarted = false
      let rollbackFailure: Error | undefined
      let cancellationRequest: Promise<void> | undefined
      let removeAbortListener: () => void = () => undefined

      try {
        throwIfAborted(signal)
        await client.query('BEGIN READ ONLY')
        transactionStarted = true

        await client.query("select set_config('statement_timeout', $1, true)", [`${input.budget.timeoutMs}ms`])
        await client.query("select set_config('idle_in_transaction_session_timeout', $1, true)", [
          `${Math.max(input.budget.timeoutMs + 1_000, 5_000)}ms`,
        ])

        const backend = await client.query<{ backend_pid: number }>('select pg_backend_pid() as backend_pid')
        const backendPid = Number(backend.rows[0]?.backend_pid)
        if (!Number.isInteger(backendPid) || backendPid <= 0) throw blocked('无法建立可取消的查询会话。')

        const requestCancellation = () => {
          cancellationRequest ??= cancelBackend(cancellationPool, backendPid)
        }
        signal.addEventListener('abort', requestCancellation, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', requestCancellation)
        if (signal.aborted) requestCancellation()
        throwIfAborted(signal)

        const explainSql = `EXPLAIN (FORMAT JSON, COSTS TRUE) ${input.sql}`
        const explainResult = await client.query(explainSql, input.parameters)
        const budgetDecision = parseExplainBudget(explainResult.rows[0], input, now().toISOString())
        throwIfAborted(signal)
        if (budgetDecision.status === 'blocked') {
          await client.query('ROLLBACK')
          transactionStarted = false
          removeAbortListener()
          if (cancellationRequest) await cancellationRequest
          throwIfAborted(signal)
          return budgetDecision
        }

        const result = await client.query(input.sql, input.parameters)
        throwIfAborted(signal)
        const rowCount = result.rowCount ?? result.rows.length
        if (!Number.isInteger(rowCount) || rowCount < 0 || rowCount > input.budget.maxRows) {
          throw blocked('查询结果超过允许的行数预算。')
        }
        const rows = result.rows.map(normalizeRow)

        await client.query('COMMIT')
        transactionStarted = false
        removeAbortListener()
        if (cancellationRequest) await cancellationRequest
        throwIfAborted(signal)

        return {
          status: 'executed',
          explain: budgetDecision.explain,
          fields: (result.fields ?? []).map((field) => ({
            name: field.name,
            databaseType: String(field.dataTypeID),
          })),
          rows,
          rowCount,
          truncated: false,
        }
      } catch (error) {
        removeAbortListener()
        if (cancellationRequest) await cancellationRequest.catch(() => undefined)
        if (transactionStarted) {
          try {
            await client.query('ROLLBACK')
          } catch (rollbackError) {
            rollbackFailure = rollbackError instanceof Error ? rollbackError : new Error('rollback failed')
          }
        }
        throw toSafeAdapterError(error, signal)
      } finally {
        client.release(rollbackFailure)
      }
    },

    async readiness() {
      try {
        await options.pool.query('select 1 as ready')
        return { ok: true as const }
      } catch {
        throw unavailable()
      }
    },

    async close() {
      await options.pool.end?.()
      if (cancellationPool !== options.pool) await cancellationPool.end?.()
    },
  }
}

export function createPostgresPool(options: PostgresPoolOptions): Pool {
  return new Pool({
    ...options,
    application_name: options.application_name ?? 'insightflow-query-adapter',
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
  })
}

function assertExecutableInput(input: QueryAdapterInput, maxStatementTimeoutMs: number, dataSourceId: string) {
  if (!input.executionId.trim() || !input.cancellationToken.trim() || !input.dataSourceId.trim() || !input.sqlFingerprint.trim()) {
    throw blocked('查询执行上下文不完整。')
  }
  if (input.dataSourceId !== dataSourceId) throw blocked('查询数据源与受信任连接池不匹配。')
  const parameterIndexes = [...input.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  const expectedIndexes = Array.from({ length: input.parameters.length }, (_, index) => index + 1)
  const actualIndexes = [...new Set(parameterIndexes)].sort((left, right) => left - right)
  if (actualIndexes.length !== expectedIndexes.length || actualIndexes.some((value, index) => value !== expectedIndexes[index])) {
    throw blocked('查询参数占位符与绑定值不匹配。')
  }
  if (
    !Number.isInteger(input.budget.timeoutMs)
    || input.budget.timeoutMs < 1
    || input.budget.timeoutMs > maxStatementTimeoutMs
    || !Number.isInteger(input.budget.maxRows)
    || input.budget.maxRows < 1
    || !Number.isFinite(input.budget.maxScanBytes)
    || input.budget.maxScanBytes < 1
    || (input.budget.maxCostUnits !== undefined && (
      !Number.isFinite(input.budget.maxCostUnits) || input.budget.maxCostUnits < 0
    ))
  ) {
    throw blocked('查询预算无效。')
  }
  if (/--|\/\*|\*\//.test(input.sql)) throw blocked('查询包含不允许的注释 token。')
  try {
    assertReadOnlySql(input.sql)
  } catch {
    throw blocked('查询未通过只读安全检查。')
  }
}

async function cancelBackend(pool: PostgresPoolLike, backendPid: number): Promise<void> {
  try {
    const result = await pool.query<{ cancelled: boolean }>(
      'select pg_cancel_backend($1) as cancelled',
      [backendPid],
    )
    if (result.rows[0]?.cancelled !== true) throw new Error('backend cancellation rejected')
  } catch {
    throw new PostgresQueryAdapterError('QUERY_CANCELLED', '查询取消未能传递到底层执行器。', true)
  }
}

function acquireClient(pool: PostgresPoolLike, signal: AbortSignal): Promise<PostgresPoolClientLike> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(new PostgresQueryAdapterError('QUERY_CANCELLED', '查询已取消。', false))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void pool.connect().then((client) => {
      if (settled) {
        client.release()
        return
      }
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(client)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      reject(error)
    })
  })
}

function parseExplainBudget(
  row: Record<string, unknown> | undefined,
  input: QueryAdapterInput,
  checkedAt: string,
): QueryAdapterOutcome {
  let payload = row?.['QUERY PLAN'] ?? row?.query_plan
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload)
    } catch {
      throw blocked('数据库未返回可验证的执行计划。')
    }
  }
  const document = Array.isArray(payload) ? payload[0] : payload
  if (!document || typeof document !== 'object') throw blocked('数据库未返回可验证的执行计划。')
  const root = (document as Record<string, unknown>).Plan
  if (!root || typeof root !== 'object') throw blocked('数据库未返回可验证的执行计划。')

  const rootPlan = root as Record<string, unknown>
  const estimatedRows = finiteNonNegative(rootPlan['Plan Rows'])
  const totalCost = finiteNonNegative(rootPlan['Total Cost'])
  const rootNodeType = typeof rootPlan['Node Type'] === 'string' ? rootPlan['Node Type'] : ''
  const estimatedScanBytes = estimateScanBytes(rootPlan)
  if (estimatedRows === null || totalCost === null || !rootNodeType || estimatedScanBytes === null) {
    throw blocked('执行计划缺少预算校验所需信息。')
  }
  const explain: QueryExplainEstimate = {
    estimatedRows,
    estimatedScanBytes,
    costUnits: totalCost,
    checkedAt,
  }
  if (estimatedRows > input.budget.maxRows) return budgetBlocked(explain, 'row_budget')
  if (estimatedScanBytes > input.budget.maxScanBytes) return budgetBlocked(explain, 'scan_budget')
  if (input.budget.maxCostUnits !== undefined && totalCost > input.budget.maxCostUnits) {
    return budgetBlocked(explain, 'cost_budget')
  }
  return {
    status: 'executed',
    explain,
    fields: [],
    rows: [],
    rowCount: 0,
    truncated: false,
  }
}

function estimateScanBytes(node: Record<string, unknown>): number | null {
  const children = Array.isArray(node.Plans)
    ? node.Plans.filter((child): child is Record<string, unknown> => Boolean(child) && typeof child === 'object')
    : []
  const childEstimates = children.map(estimateScanBytes)
  if (childEstimates.some((value) => value === null)) return null

  const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : ''
  const ownEstimate = /scan/i.test(nodeType)
    ? multiplyFinite(finiteNonNegative(node['Plan Rows']), finiteNonNegative(node['Plan Width']))
    : 0
  if (ownEstimate === null) return null
  const total = ownEstimate + childEstimates.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  return Number.isSafeInteger(total) || Number.isFinite(total) ? total : null
}

function finiteNonNegative(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function multiplyFinite(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null
  const product = left * right
  return Number.isFinite(product) && product >= 0 ? product : null
}

function normalizeRow(row: Record<string, unknown>): Record<string, QueryScalar> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]))
}

function normalizeValue(value: unknown): QueryScalar {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  throw new PostgresQueryAdapterError('QUERY_EXECUTION_FAILED', '查询结果包含不支持的数据类型。', false)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PostgresQueryAdapterError('QUERY_CANCELLED', '查询已取消。', false)
}

function toSafeAdapterError(error: unknown, signal: AbortSignal): PostgresQueryAdapterError {
  if (error instanceof PostgresQueryAdapterError) return error
  if (signal.aborted) return new PostgresQueryAdapterError('QUERY_CANCELLED', '查询已取消。', false)
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : ''
  if (code === POSTGRES_QUERY_CANCELLED) {
    return new PostgresQueryAdapterError('QUERY_TIMEOUT', '查询超过执行时限。', true)
  }
  if (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03') return unavailable()
  return new PostgresQueryAdapterError('QUERY_EXECUTION_FAILED', '数据库查询执行失败。', true)
}

function blocked(message: string) {
  return new PostgresQueryAdapterError('QUERY_BLOCKED', message, false)
}

function budgetBlocked(
  explain: QueryExplainEstimate,
  reason: QueryAdapterBlockedOutcome['reason'],
): QueryAdapterBlockedOutcome {
  return { status: 'blocked', explain, reason }
}

function unavailable() {
  return new PostgresQueryAdapterError('QUERY_UNAVAILABLE', '查询数据源当前不可用。', true)
}
