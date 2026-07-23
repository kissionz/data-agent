import { describe, expect, it } from 'vitest'
import {
  CHART_ROW_HARD_LIMIT,
  validateChartPublication,
} from '../query'
import type {
  ResultChartSpec,
  ResultChartValidationRuleCode,
  ResultColumn,
  ResultRow,
} from '../domain'

const columns: ResultColumn[] = [
  { id: 'day', label: '日期', type: 'date' },
  { id: 'region', label: '区域', type: 'string' },
  { id: 'revenue', label: '收入', type: 'currency', unit: 'CNY' },
]

const lineSpec: ResultChartSpec = {
  id: 'chart_result',
  title: '收入趋势',
  description: '按日展示收入。',
  type: 'line',
  xAxisColumnId: 'day',
  yAxisColumnIds: ['revenue'],
  source: 'validated_result_spec',
  safety: { grounded: true, warnings: [] },
}

function row(key: string, day: string, revenue: string | number): ResultRow {
  return {
    key,
    values: { day, region: '华东', revenue },
  }
}

function failedCodes(outcome: ReturnType<typeof validateChartPublication>) {
  return outcome.report.checks
    .filter((check) => check.status === 'fail')
    .map((check) => check.code)
}

function expectFallback(
  outcome: ReturnType<typeof validateChartPublication>,
  code: ResultChartValidationRuleCode,
) {
  expect(outcome.accepted).toBe(true)
  if (!outcome.accepted) throw new Error('Expected a safe table fallback')
  expect(outcome.chartSpec.type).toBe('table')
  expect(outcome.chartSpec.xAxisColumnId).toBeUndefined()
  expect(outcome.chartSpec.yAxisColumnIds).toEqual([])
  expect(outcome.report).toMatchObject({
    schemaVersion: 'chatbi_chart_validation.v1',
    decision: 'fallback_table',
    publishedChartType: 'table',
  })
  expect(failedCodes(outcome)).toContain(code)
}

describe('production deterministic chart publication validator', () => {
  it('allows a strictly ordered, finite, single-unit line chart with a versioned audit report', () => {
    const outcome = validateChartPublication({
      proposedSpec: lineSpec,
      columns,
      rows: [
        row('2026-07-14', '2026-07-14', 100),
        row('2026-07-15', '2026-07-15', '120.5'),
      ],
    })

    expect(outcome.accepted).toBe(true)
    if (!outcome.accepted) throw new Error('Expected chart publication to be accepted')
    expect(outcome.chartSpec.type).toBe('line')
    expect(outcome.chartSpec.safety.warnings).toEqual([])
    expect(outcome.report).toMatchObject({
      schemaVersion: 'chatbi_chart_validation.v1',
      decision: 'allow',
      requestedChartType: 'line',
      publishedChartType: 'line',
      evaluatedRowCount: 2,
      rowHardLimit: CHART_ROW_HARD_LIMIT,
    })
    expect(outcome.report.checks.some((check) => check.status === 'fail')).toBe(false)
  })

  it('rejects unsupported chart types and ambiguous duplicate result columns', () => {
    const unsupported = validateChartPublication({
      proposedSpec: { ...lineSpec, type: 'pie' } as unknown as ResultChartSpec,
      columns,
      rows: [row('2026-07-14', '2026-07-14', 100)],
    })
    expect(unsupported.accepted).toBe(false)
    expect(unsupported.report).toMatchObject({
      decision: 'reject',
      requestedChartType: 'unsupported',
      publishedChartType: undefined,
    })
    expect(failedCodes(unsupported)).toContain('CHART_TYPE_ALLOWED')

    const duplicateColumns = validateChartPublication({
      proposedSpec: lineSpec,
      columns: [...columns, { ...columns[2] }],
      rows: [row('2026-07-14', '2026-07-14', 100)],
    })
    expect(duplicateColumns.accepted).toBe(false)
    expect(failedCodes(duplicateColumns)).toContain('COLUMN_IDS_UNIQUE')
  })

  it('falls back to a table for missing, duplicate, or type-incompatible axes', () => {
    const cases: Array<[ResultChartSpec, ResultChartValidationRuleCode]> = [
      [{ ...lineSpec, xAxisColumnId: 'missing' }, 'AXIS_FIELDS_EXIST'],
      [{ ...lineSpec, yAxisColumnIds: ['revenue', 'revenue'] }, 'AXIS_FIELDS_UNIQUE'],
      [{ ...lineSpec, xAxisColumnId: 'region' }, 'AXIS_TYPES_COMPATIBLE'],
      [{
        ...lineSpec,
        type: 'bar',
        xAxisColumnId: 'revenue',
        yAxisColumnIds: ['revenue'],
      }, 'AXIS_FIELDS_UNIQUE'],
    ]

    for (const [proposedSpec, code] of cases) {
      expectFallback(validateChartPublication({
        proposedSpec,
        columns,
        rows: [row('2026-07-14', '2026-07-14', 100)],
      }), code)
    }
  })

  it('falls back for empty, oversized, unsorted, or duplicate time-series results', () => {
    expectFallback(validateChartPublication({
      proposedSpec: lineSpec,
      columns,
      rows: [],
    }), 'RESULT_NON_EMPTY')

    expectFallback(validateChartPublication({
      proposedSpec: lineSpec,
      columns,
      rows: Array.from(
        { length: CHART_ROW_HARD_LIMIT + 1 },
        (_, index) => row(String(index), new Date(Date.UTC(2024, 0, index + 1)).toISOString(), index),
      ),
    }), 'ROW_COUNT_WITHIN_HARD_LIMIT')

    for (const rows of [
      [row('later', '2026-07-15', 100), row('earlier', '2026-07-14', 90)],
      [row('first', '2026-07-14', 100), row('duplicate', '2026-07-14', 90)],
    ]) {
      expectFallback(validateChartPublication({
        proposedSpec: lineSpec,
        columns,
        rows,
      }), 'TIME_AXIS_STRICTLY_ASCENDING')
    }
  })

  it('rejects non-finite numeric values instead of publishing a chart or table', () => {
    const outcome = validateChartPublication({
      proposedSpec: lineSpec,
      columns,
      rows: [row('overflow', '2026-07-14', '1e309')],
    })

    expect(outcome.accepted).toBe(false)
    expect(outcome.report.decision).toBe('reject')
    expect(failedCodes(outcome)).toContain('NUMERIC_VALUES_FINITE')
  })

  it('falls back for unreasonable percentages and mixed y-axis units', () => {
    const percentageColumns: ResultColumn[] = [
      { id: 'region', label: '区域', type: 'string' },
      { id: 'share', label: '占比', type: 'percentage', unit: '%' },
    ]
    expectFallback(validateChartPublication({
      proposedSpec: {
        ...lineSpec,
        type: 'bar',
        xAxisColumnId: 'region',
        yAxisColumnIds: ['share'],
      },
      columns: percentageColumns,
      rows: [{ key: '华东', values: { region: '华东', share: 120 } }],
    }), 'PERCENTAGE_VALUES_REASONABLE')

    const mixedUnitColumns: ResultColumn[] = [
      { id: 'region', label: '区域', type: 'string' },
      { id: 'revenue_cny', label: '人民币收入', type: 'currency', unit: 'CNY' },
      { id: 'revenue_usd', label: '美元收入', type: 'currency', unit: 'USD' },
    ]
    expectFallback(validateChartPublication({
      proposedSpec: {
        ...lineSpec,
        type: 'bar',
        xAxisColumnId: 'region',
        yAxisColumnIds: ['revenue_cny', 'revenue_usd'],
      },
      columns: mixedUnitColumns,
      rows: [{
        key: '华东',
        values: { region: '华东', revenue_cny: 100, revenue_usd: 14 },
      }],
    }), 'Y_AXIS_UNITS_COMPATIBLE')
  })
})
