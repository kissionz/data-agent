import { describe, expect, it } from 'vitest'
import { validateResultGrounding } from '../domain'
import {
  mapQueryResultToRunResult,
  type QueryAdapter,
  type QueryAdapterExecutedOutcome,
  type QueryAdapterInput,
  type QueryOutputColumn,
} from '../query'
import { ANALYSIS_IR_VERSION, type AnalysisIR } from '../contracts'

const analysisIr: AnalysisIR = {
  schemaVersion: ANALYSIS_IR_VERSION,
  irId: 'ir_real_result',
  revision: 1,
  mode: 'trusted',
  semanticVersion: 'sales-semantic-2026.06.1',
  intent: 'trend',
  metricIds: ['net_revenue', 'is_final'],
  dimensionIds: ['order_date', 'note'],
  filters: [],
  timeRange: {
    kind: 'relative',
    expression: 'last_30_complete_days',
    timezone: 'Asia/Shanghai',
    grain: 'day',
  },
  limit: 100,
  assumptions: [],
  safety: {
    requiresClarification: false,
    executedQuery: true,
    permissionChecked: true,
    budgetChecked: true,
  },
}

const outputColumns: QueryOutputColumn[] = [
  { id: 'order_date', label: '订单日期', type: 'date', role: 'dimension' },
  { id: 'note', label: '备注', type: 'string', role: 'dimension' },
  { id: 'net_revenue', label: '净收入', type: 'currency', unit: 'CNY', role: 'metric' },
  { id: 'is_final', label: '是否终值', type: 'boolean', role: 'metric' },
]

function execution(
  rows: QueryAdapterExecutedOutcome['rows'],
  patch: Partial<QueryAdapterExecutedOutcome> = {},
): QueryAdapterExecutedOutcome {
  return {
    status: 'executed',
    explain: {
      estimatedRows: rows.length,
      estimatedScanBytes: 1024,
      costUnits: 1.25,
      checkedAt: '2026-07-15T09:00:00.000Z',
    },
    fields: outputColumns.map((column) => ({ name: column.id, databaseType: 'text' })),
    rows,
    rowCount: rows.length,
    truncated: false,
    ...patch,
  }
}

function map(executed: QueryAdapterExecutedOutcome) {
  return mapQueryResultToRunResult({
    resultId: 'result_real_query',
    plan: { ir: analysisIr, outputColumns },
    execution: executed,
    freshnessAt: '2026-07-15T08:59:00.000Z',
  })
}

describe('browser-safe query adapter contract and result mapper', () => {
  it('maps decimal strings, dates, nulls and booleans without losing grounding', () => {
    const result = map(execution([
      {
        order_date: '2026-07-14',
        note: null,
        net_revenue: '9007199254740993.25',
        is_final: true,
      },
    ]))

    expect(result).toMatchObject({
      id: 'result_real_query',
      completeness: 'full',
      chartSpec: {
        type: 'line',
        xAxisColumnId: 'order_date',
        yAxisColumnIds: ['net_revenue'],
        safety: {
          validationReport: {
            schemaVersion: 'chatbi_chart_validation.v1',
            decision: 'allow',
            publishedChartType: 'line',
          },
        },
      },
      answer: {
        generatedFrom: 'query_result',
        semanticVersion: analysisIr.semanticVersion,
      },
    })
    expect(result.rows[0].values).toEqual({
      order_date: '2026-07-14',
      note: null,
      net_revenue: '9007199254740993.25',
      is_final: true,
    })
    expect(result.answer.facts).toEqual([
      expect.objectContaining({
        id: 'fact_net_revenue',
        value: '9007199254740993.25',
        references: [{ resultId: result.id, rowKey: result.rows[0].key, columnId: 'net_revenue' }],
      }),
      expect.objectContaining({ id: 'fact_is_final', value: true, formattedValue: '是' }),
    ])
    expect(result.answer.facts.every((fact) => fact.transform === undefined)).toBe(true)
    expect(validateResultGrounding(result)).toMatchObject({
      grounded: true,
      checkedFacts: 2,
      checkedReferences: 2,
      checkedTransforms: 0,
      transformRegistryVersion: 'chatbi_fact_transform_registry.v1',
    })
  })

  it('maps an empty result to a grounded table empty state', () => {
    const result = map(execution([]))

    expect(result.rows).toEqual([])
    expect(result.answer.facts).toEqual([])
    expect(result.answer.headline).toContain('未返回')
    expect(result.chartSpec).toMatchObject({
      type: 'table',
      yAxisColumnIds: [],
      safety: {
        validationReport: {
          decision: 'fallback_table',
          publishedChartType: 'table',
        },
      },
    })
    expect(validateResultGrounding(result)).toMatchObject({ grounded: true, checkedFacts: 0 })
  })

  it('deterministically downgrades an unsafe unsorted time series before publication', () => {
    const result = map(execution([
      {
        order_date: '2026-07-15',
        note: '较晚',
        net_revenue: 1250,
        is_final: false,
      },
      {
        order_date: '2026-07-14',
        note: '较早',
        net_revenue: 1200,
        is_final: true,
      },
    ]))

    expect(result.chartSpec).toMatchObject({
      type: 'table',
      yAxisColumnIds: [],
      safety: {
        grounded: true,
        warnings: [expect.stringContaining('降级')],
        validationReport: {
          schemaVersion: 'chatbi_chart_validation.v1',
          decision: 'fallback_table',
          requestedChartType: 'line',
          publishedChartType: 'table',
          checks: expect.arrayContaining([
            { code: 'TIME_AXIS_STRICTLY_ASCENDING', status: 'fail' },
          ]),
        },
      },
    })
    expect(result.chartSpec.xAxisColumnId).toBeUndefined()
  })

  it('marks adapter truncation as an explicit partial result', () => {
    const result = map(execution([{
      order_date: '2026-07-14',
      note: '预算截断',
      net_revenue: 1250.5,
      is_final: false,
    }], { truncated: true }))

    expect(result).toMatchObject({
      completeness: 'partial',
      incompleteSteps: ['row_budget_truncation'],
      warnings: [expect.stringContaining('行数上限')],
    })
  })

  it('creates stable unique row keys for duplicate dimension tuples', () => {
    const rows = [
      { order_date: '2026-07-14', note: null, net_revenue: 1, is_final: false },
      { order_date: '2026-07-14', note: null, net_revenue: 2, is_final: true },
    ]
    const result = map(execution(rows))

    expect(result.rows.map((row) => row.key)).toEqual([
      'order_date:2026-07-14|note:null',
      'order_date:2026-07-14|note:null#2',
    ])
    expect(result.answer.facts[0].references[0].rowKey).toBe(result.rows[1].key)
  })

  it('rejects field drift, inconsistent row counts and unsupported scalar values', () => {
    expect(() => map(execution([], {
      fields: [{ name: 'unexpected', databaseType: 'text' }],
    }))).toThrow('fields do not match')

    expect(() => map(execution([], { rowCount: 1 }))).toThrow('row count')

    expect(() => map(execution([{
      order_date: '2026-07-14',
      note: null,
      net_revenue: Number.NaN,
      is_final: true,
    }]))).toThrow('unsupported value')

    expect(() => map(execution([{
      order_date: 'not-a-date',
      note: null,
      net_revenue: 10,
      is_final: true,
    }]))).toThrow('date output type')

    expect(() => map(execution([{
      order_date: '2026-07-14',
      note: null,
      net_revenue: 'not-numeric',
      is_final: true,
    }]))).toThrow('numeric output type')

    expect(() => map(execution([{
      order_date: '2026-07-14',
      note: null,
      net_revenue: '1e309',
      is_final: true,
    }]))).toThrow('numeric output type')
  })

  it('exposes an async, AbortSignal-aware atomic adapter port without Node dependencies', async () => {
    let observedSignal: AbortSignal | undefined
    const adapter: QueryAdapter = {
      dialect: 'postgresql',
      async runReadOnly(_input, signal) {
        observedSignal = signal
        return execution([])
      },
    }
    const input: QueryAdapterInput = {
      executionId: 'query_execution_1',
      cancellationToken: 'qcancel_1',
      dataSourceId: 'warehouse_sales',
      sql: 'SELECT $1',
      parameters: ['tenant_demo'],
      sqlFingerprint: 'fingerprint_1',
      budget: { timeoutMs: 15_000, maxRows: 100, maxScanBytes: 10_000, maxCostUnits: 50 },
    }
    const controller = new AbortController()

    await expect(adapter.runReadOnly(input, controller.signal)).resolves.toMatchObject({ status: 'executed' })
    expect(observedSignal).toBe(controller.signal)
  })
})
