import { assertResultIntegrity, type DeterministicFact, type ResultColumn, type ResultRow, type RunResult } from '../domain'
import type { MapQueryResultInput, QueryOutputColumn, QueryScalar } from './types'

export function mapQueryResultToRunResult(input: MapQueryResultInput): RunResult {
  assertMappingInput(input)
  const columns = input.plan.outputColumns.map(toPublicColumn)
  const rows = mapRows(input.execution.rows, input.plan.outputColumns)
  const chartSpec = createChartSpec(input.resultId, columns, rows)
  const facts = createFacts(input.resultId, input.plan.outputColumns, rows)
  const primaryMetric = input.plan.outputColumns.find((column) => column.role === 'metric')
  const result: RunResult = {
    id: input.resultId,
    columns,
    rows,
    chartSpec,
    completeness: input.execution.truncated ? 'partial' : 'full',
    incompleteSteps: input.execution.truncated ? ['row_budget_truncation'] : [],
    warnings: input.execution.truncated ? ['结果达到行数上限，仅展示预算内的部分数据。'] : [],
    answer: {
      headline: rows.length === 0
        ? '查询完成，未返回符合条件的数据'
        : `${primaryMetric?.label ?? '查询'}结果已生成`,
      summary: rows.length === 0
        ? '当前口径、筛选与时间范围内没有匹配记录。'
        : `基于 ${rows.length} 行授权查询结果生成，所有事实均可追溯到结果单元格。`,
      facts,
      semanticVersion: input.plan.ir.semanticVersion,
      generatedFrom: 'query_result',
    },
    freshnessAt: input.freshnessAt,
  }
  assertResultIntegrity(result)
  return result
}

function assertMappingInput(input: MapQueryResultInput) {
  if (!input.resultId.trim()) throw new Error('Query result requires a result id')
  if (!input.freshnessAt.trim()) throw new Error('Query result requires a freshness timestamp')
  if (input.execution.rowCount !== input.execution.rows.length) {
    throw new Error('Query adapter row count does not match returned rows')
  }

  const expected = input.plan.outputColumns.map((column) => column.id)
  if (expected.length === 0) throw new Error('Query result requires an output schema')
  if (new Set(expected).size !== expected.length) throw new Error('Query output schema contains duplicate columns')

  const actual = input.execution.fields.map((field) => field.name)
  if (new Set(actual).size !== actual.length) throw new Error('Query adapter returned duplicate fields')
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error('Query adapter fields do not match the compiled output schema')
  }
}

function toPublicColumn(column: QueryOutputColumn): ResultColumn {
  const { role: _role, ...resultColumn } = column
  return resultColumn
}

function mapRows(
  adapterRows: Array<Record<string, QueryScalar>>,
  columns: QueryOutputColumn[],
): ResultRow[] {
  const keyCounts = new Map<string, number>()
  return adapterRows.map((adapterRow, index) => {
    const actualKeys = Object.keys(adapterRow)
    const expectedKeys = columns.map((column) => column.id)
    if (actualKeys.length !== expectedKeys.length || expectedKeys.some((key) => !(key in adapterRow))) {
      throw new Error(`Query row ${index + 1} does not match the compiled output schema`)
    }
    const values = Object.fromEntries(columns.map((column) => {
      const value = adapterRow[column.id]
      assertScalar(value, column.id)
      assertColumnValue(value, column)
      return [column.id, value]
    })) as ResultRow['values']
    const baseKey = createBaseRowKey(values, columns, index)
    const duplicateIndex = (keyCounts.get(baseKey) ?? 0) + 1
    keyCounts.set(baseKey, duplicateIndex)
    return {
      key: duplicateIndex === 1 ? baseKey : `${baseKey}#${duplicateIndex}`,
      values,
    }
  })
}

function assertScalar(value: unknown, columnId: string): asserts value is QueryScalar {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  throw new Error(`Query column ${columnId} contains an unsupported value`)
}

function assertColumnValue(value: QueryScalar, column: QueryOutputColumn) {
  if (value === null) return
  if (column.type === 'boolean') {
    if (typeof value === 'boolean') return
    throw new Error(`Query column ${column.id} does not match its boolean output type`)
  }
  if (column.type === 'date') {
    if (typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value))) return
    throw new Error(`Query column ${column.id} does not match its date output type`)
  }
  if (column.type === 'number' || column.type === 'currency' || column.type === 'percentage') {
    if (typeof value === 'number') return
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())) return
    throw new Error(`Query column ${column.id} does not match its numeric output type`)
  }
  if (typeof value !== 'string') throw new Error(`Query column ${column.id} does not match its string output type`)
}

function createBaseRowKey(values: ResultRow['values'], columns: QueryOutputColumn[], index: number) {
  const dimensions = columns.filter((column) => column.role === 'dimension')
  const parts = dimensions.map((column) => `${column.id}:${String(values[column.id] ?? 'null')}`)
  return parts.length > 0 ? parts.join('|') : `row:${index + 1}`
}

function createChartSpec(resultId: string, columns: ResultColumn[], rows: ResultRow[]): RunResult['chartSpec'] {
  const dateColumn = columns.find((column) => column.type === 'date')
  const dimensionColumn = columns.find((column) => !isNumericColumn(column))
  const numericColumns = columns.filter(isNumericColumn)
  const canChart = rows.length > 0 && numericColumns.length > 0
  const type = !canChart ? 'table' : dateColumn ? 'line' : dimensionColumn ? 'bar' : 'table'
  return {
    id: `chart_${resultId}`,
    title: type === 'table' ? '查询结果' : `${numericColumns[0].label}${type === 'line' ? '趋势' : '对比'}`,
    description: type === 'table'
      ? '以表格展示经过授权与类型校验的查询结果。'
      : `使用 ${dimensionColumn?.label ?? dateColumn?.label ?? '维度'} 展示经过校验的${numericColumns[0].label}。`,
    type,
    xAxisColumnId: type === 'table' ? undefined : (dateColumn ?? dimensionColumn)?.id,
    yAxisColumnIds: type === 'table' ? [] : numericColumns.map((column) => column.id),
    source: 'validated_result_spec',
    safety: { grounded: true, warnings: [] },
  }
}

function createFacts(
  resultId: string,
  columns: QueryOutputColumn[],
  rows: ResultRow[],
): DeterministicFact[] {
  if (rows.length === 0) return []
  const row = rows[rows.length - 1]
  const metricColumns = columns.filter((column) => column.role === 'metric' && row.values[column.id] !== null)
  const selectedColumns = metricColumns.length > 0
    ? metricColumns
    : columns.filter((column) => row.values[column.id] !== null).slice(0, 1)
  return selectedColumns.map((column) => {
    const value = row.values[column.id]
    if (value === null) throw new Error('A deterministic fact cannot reference a null value')
    return {
      id: `fact_${column.id}`,
      label: column.label,
      value,
      formattedValue: formatValue(value, column),
      references: [{ resultId, rowKey: row.key, columnId: column.id }],
    }
  })
}

function isNumericColumn(column: ResultColumn) {
  return column.type === 'number' || column.type === 'currency' || column.type === 'percentage'
}

function formatValue(value: Exclude<QueryScalar, null>, column: ResultColumn) {
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') {
    if (column.type === 'currency') {
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: column.unit ?? 'CNY',
        maximumFractionDigits: 2,
      }).format(value)
    }
    if (column.type === 'percentage') return `${value}%`
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(value)
  }
  return column.unit && column.type === 'currency' ? `${value} ${column.unit}` : value
}
