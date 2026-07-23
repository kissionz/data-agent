import {
  CHART_VALIDATION_RULE_CODES,
  CHART_VALIDATION_REPORT_VERSION,
  type ResultChartSpec,
  type ResultChartType,
  type ResultChartValidationCheck,
  type ResultChartValidationReport,
  type ResultChartValidationRuleCode,
  type ResultColumn,
  type ResultRow,
} from '../domain'

export const CHART_ROW_HARD_LIMIT = 500

export interface ValidateChartPublicationInput {
  proposedSpec: ResultChartSpec
  columns: ResultColumn[]
  rows: ResultRow[]
}

export type ChartPublicationValidation =
  | {
      accepted: true
      chartSpec: ResultChartSpec
      report: ResultChartValidationReport
    }
  | {
      accepted: false
      report: ResultChartValidationReport
    }

const REJECTING_RULES = new Set<ResultChartValidationRuleCode>([
  'CHART_TYPE_ALLOWED',
  'COLUMN_IDS_UNIQUE',
  'NUMERIC_VALUES_FINITE',
])

export function validateChartPublication(input: ValidateChartPublicationInput): ChartPublicationValidation {
  const rowHardLimit = CHART_ROW_HARD_LIMIT
  const rawType = (input.proposedSpec as { type?: unknown }).type
  const requestedChartType = isChartType(rawType) ? rawType : 'unsupported'
  const columnIds = input.columns.map((column) => column.id)
  const columnsById = new Map(input.columns.map((column) => [column.id, column]))
  const xAxisColumnId = input.proposedSpec.xAxisColumnId
  const yAxisColumnIds = input.proposedSpec.yAxisColumnIds
  const isTable = requestedChartType === 'table'
  const axisFieldsExist = isTable
    ? xAxisColumnId === undefined && yAxisColumnIds.length === 0
    : Boolean(
        xAxisColumnId
        && columnsById.has(xAxisColumnId)
        && yAxisColumnIds.length > 0
        && yAxisColumnIds.every((columnId) => columnsById.has(columnId)),
      )
  const axisFieldsUnique = new Set(yAxisColumnIds).size === yAxisColumnIds.length
    && (!xAxisColumnId || !yAxisColumnIds.includes(xAxisColumnId))
  const axisTypesCompatible = evaluateAxisTypes(
    requestedChartType,
    xAxisColumnId,
    yAxisColumnIds,
    columnsById,
  )
  const timeAxisStrictlyAscending = evaluateTimeAxis(
    requestedChartType,
    xAxisColumnId,
    input.rows,
  )
  const numericValuesFinite = evaluateFiniteNumbers(yAxisColumnIds, columnsById, input.rows)
  const percentageValuesReasonable = evaluatePercentages(yAxisColumnIds, columnsById, input.rows)
  const yAxisUnitsCompatible = evaluateYAxisUnits(yAxisColumnIds, columnsById)

  const statuses = new Map<ResultChartValidationRuleCode, ResultChartValidationCheck['status']>([
    ['CHART_TYPE_ALLOWED', requestedChartType === 'unsupported' ? 'fail' : 'pass'],
    ['COLUMN_IDS_UNIQUE', new Set(columnIds).size === columnIds.length ? 'pass' : 'fail'],
    ['AXIS_FIELDS_EXIST', requestedChartType === 'unsupported' ? 'not_applicable' : axisFieldsExist ? 'pass' : 'fail'],
    ['AXIS_FIELDS_UNIQUE', requestedChartType === 'unsupported' ? 'not_applicable' : axisFieldsUnique ? 'pass' : 'fail'],
    ['ROW_COUNT_WITHIN_HARD_LIMIT', input.rows.length <= rowHardLimit ? 'pass' : 'fail'],
    ['RESULT_NON_EMPTY', input.rows.length > 0 ? 'pass' : 'fail'],
    ['AXIS_TYPES_COMPATIBLE', axisTypesCompatible],
    ['TIME_AXIS_STRICTLY_ASCENDING', timeAxisStrictlyAscending],
    ['NUMERIC_VALUES_FINITE', numericValuesFinite],
    ['PERCENTAGE_VALUES_REASONABLE', percentageValuesReasonable],
    ['Y_AXIS_UNITS_COMPATIBLE', yAxisUnitsCompatible],
  ])
  const checks = CHART_VALIDATION_RULE_CODES.map((code) => ({
    code,
    status: statuses.get(code) ?? 'not_applicable',
  }))
  const failedCodes = checks.filter((check) => check.status === 'fail').map((check) => check.code)
  const decision = failedCodes.some((code) => REJECTING_RULES.has(code))
    ? 'reject'
    : failedCodes.length > 0
      ? 'fallback_table'
      : 'allow'
  const report: ResultChartValidationReport = {
    schemaVersion: CHART_VALIDATION_REPORT_VERSION,
    decision,
    requestedChartType,
    publishedChartType: decision === 'reject'
      ? undefined
      : decision === 'fallback_table'
        ? 'table'
        : requestedChartType as ResultChartType,
    evaluatedRowCount: input.rows.length,
    rowHardLimit,
    checks,
  }

  if (decision === 'reject') return { accepted: false, report }
  if (decision === 'fallback_table') {
    return {
      accepted: true,
      report,
      chartSpec: createTableFallback(input.proposedSpec, report),
    }
  }
  return {
    accepted: true,
    report,
    chartSpec: {
      ...input.proposedSpec,
      safety: {
        grounded: true,
        warnings: [],
        validationReport: report,
      },
    },
  }
}

function isChartType(value: unknown): value is ResultChartType {
  return value === 'line' || value === 'bar' || value === 'table'
}

function evaluateAxisTypes(
  chartType: ResultChartType | 'unsupported',
  xAxisColumnId: string | undefined,
  yAxisColumnIds: string[],
  columnsById: Map<string, ResultColumn>,
): ResultChartValidationCheck['status'] {
  if (chartType === 'unsupported') return 'not_applicable'
  if (chartType === 'table') {
    return xAxisColumnId === undefined && yAxisColumnIds.length === 0 ? 'pass' : 'fail'
  }
  const xAxisColumn = xAxisColumnId ? columnsById.get(xAxisColumnId) : undefined
  const yAxisColumns = yAxisColumnIds.map((columnId) => columnsById.get(columnId))
  if (!xAxisColumn || yAxisColumns.length === 0 || yAxisColumns.some((column) => !column)) return 'fail'
  if (chartType === 'line' && xAxisColumn.type !== 'date') return 'fail'
  if (chartType === 'bar' && isNumericColumn(xAxisColumn)) return 'fail'
  return yAxisColumns.every((column) => column && isNumericColumn(column)) ? 'pass' : 'fail'
}

function evaluateTimeAxis(
  chartType: ResultChartType | 'unsupported',
  xAxisColumnId: string | undefined,
  rows: ResultRow[],
): ResultChartValidationCheck['status'] {
  if (chartType !== 'line') return 'not_applicable'
  if (!xAxisColumnId) return 'fail'
  let previous: number | undefined
  for (const row of rows) {
    const value = row.values[xAxisColumnId]
    if (typeof value !== 'string' || !value.trim()) return 'fail'
    const current = Date.parse(value)
    if (!Number.isFinite(current) || (previous !== undefined && current <= previous)) return 'fail'
    previous = current
  }
  return 'pass'
}

function evaluateFiniteNumbers(
  yAxisColumnIds: string[],
  columnsById: Map<string, ResultColumn>,
  rows: ResultRow[],
): ResultChartValidationCheck['status'] {
  const numericColumnIds = yAxisColumnIds.filter((columnId) => {
    const column = columnsById.get(columnId)
    return column ? isNumericColumn(column) : false
  })
  if (numericColumnIds.length === 0) return 'not_applicable'
  for (const row of rows) {
    for (const columnId of numericColumnIds) {
      const value = row.values[columnId]
      if (value === null) continue
      if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) return 'fail'
    }
  }
  return 'pass'
}

function evaluatePercentages(
  yAxisColumnIds: string[],
  columnsById: Map<string, ResultColumn>,
  rows: ResultRow[],
): ResultChartValidationCheck['status'] {
  const percentageColumnIds = yAxisColumnIds.filter((columnId) => columnsById.get(columnId)?.type === 'percentage')
  if (percentageColumnIds.length === 0) return 'not_applicable'
  for (const row of rows) {
    for (const columnId of percentageColumnIds) {
      const value = row.values[columnId]
      if (value === null) continue
      const numericValue = Number(value)
      if (!Number.isFinite(numericValue) || numericValue < -100 || numericValue > 100) return 'fail'
    }
  }
  return 'pass'
}

function evaluateYAxisUnits(
  yAxisColumnIds: string[],
  columnsById: Map<string, ResultColumn>,
): ResultChartValidationCheck['status'] {
  const columns = yAxisColumnIds
    .map((columnId) => columnsById.get(columnId))
    .filter((column): column is ResultColumn => Boolean(column))
  if (columns.length <= 1) return columns.length === 1 ? 'pass' : 'not_applicable'
  if (columns.some((column) => !isNumericColumn(column))) return 'fail'
  const dimensions = new Set(columns.map(unitDimension))
  return dimensions.size === 1 ? 'pass' : 'fail'
}

function unitDimension(column: ResultColumn) {
  if (column.type === 'currency') return `currency:${column.unit ?? 'CNY'}`
  if (column.type === 'percentage') return 'percentage'
  return `number:${column.unit ?? 'unitless'}`
}

function isNumericColumn(column: ResultColumn) {
  return column.type === 'number' || column.type === 'currency' || column.type === 'percentage'
}

function createTableFallback(
  proposedSpec: ResultChartSpec,
  report: ResultChartValidationReport,
): ResultChartSpec {
  return {
    id: proposedSpec.id,
    title: '查询结果',
    description: '图表未通过确定性安全门禁，已使用数据表展示。',
    type: 'table',
    yAxisColumnIds: [],
    source: 'validated_result_spec',
    safety: {
      grounded: true,
      warnings: ['图表未通过确定性安全门禁，已降级为数据表。'],
      validationReport: report,
    },
  }
}
