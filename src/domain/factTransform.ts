export const FACT_TRANSFORM_SCHEMA_VERSION = 'chatbi_fact_transform.v1' as const
export const FACT_TRANSFORM_REGISTRY_VERSION = 'chatbi_fact_transform_registry.v1' as const

export const FACT_TRANSFORM_FUNCTIONS = [
  'sum',
  'difference',
  'ratio',
  'percent_change',
] as const

export type FactTransformFunction = (typeof FACT_TRANSFORM_FUNCTIONS)[number]
export type FactTransformRounding = 'half_away_from_zero'
export type FactTransformNullPolicy = 'reject' | 'skip' | 'zero'
export type FactTransformDivideByZeroPolicy = 'reject'

export interface ResultCellReference {
  resultId: string
  rowKey: string
  columnId: string
  /**
   * Legacy marker retained for wire compatibility only. It is never trusted:
   * transformed facts must use DeterministicFactTransform and this field is rejected.
   */
  transformId?: string
}

export interface DeterministicFactTransform {
  schemaVersion: typeof FACT_TRANSFORM_SCHEMA_VERSION
  registryVersion: typeof FACT_TRANSFORM_REGISTRY_VERSION
  function: FactTransformFunction
  inputs: ResultCellReference[]
  precision: number
  rounding: FactTransformRounding
  nullPolicy: FactTransformNullPolicy
  divideByZeroPolicy: FactTransformDivideByZeroPolicy
}

export type FactTransformFailureCode =
  | 'UNEXPECTED_FIELD'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNSUPPORTED_REGISTRY_VERSION'
  | 'UNKNOWN_TRANSFORM'
  | 'INVALID_PRECISION'
  | 'UNKNOWN_ROUNDING_POLICY'
  | 'UNKNOWN_NULL_POLICY'
  | 'UNKNOWN_DIVIDE_BY_ZERO_POLICY'
  | 'INPUT_ARITY_MISMATCH'
  | 'NULL_INPUT_REJECTED'
  | 'INPUT_NOT_NUMERIC'
  | 'NON_FINITE_INPUT'
  | 'DIVIDE_BY_ZERO'
  | 'NON_FINITE_RESULT'

export type FactTransformEvaluation =
  | { ok: true; value: number }
  | { ok: false; code: FactTransformFailureCode }

const MAX_TRANSFORM_PRECISION = 12
const TRANSFORM_FIELDS = new Set([
  'schemaVersion',
  'registryVersion',
  'function',
  'inputs',
  'precision',
  'rounding',
  'nullPolicy',
  'divideByZeroPolicy',
])

export function evaluateDeterministicFactTransform(
  transform: DeterministicFactTransform,
  inputValues: unknown[],
): FactTransformEvaluation {
  const raw = transform as unknown as Record<string, unknown>
  if (Object.keys(raw).some((key) => !TRANSFORM_FIELDS.has(key))) {
    return { ok: false, code: 'UNEXPECTED_FIELD' }
  }
  if (raw.schemaVersion !== FACT_TRANSFORM_SCHEMA_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_SCHEMA_VERSION' }
  }
  if (raw.registryVersion !== FACT_TRANSFORM_REGISTRY_VERSION) {
    return { ok: false, code: 'UNSUPPORTED_REGISTRY_VERSION' }
  }
  if (!isTransformFunction(raw.function)) return { ok: false, code: 'UNKNOWN_TRANSFORM' }
  if (!Number.isSafeInteger(raw.precision) || (raw.precision as number) < 0 || (raw.precision as number) > MAX_TRANSFORM_PRECISION) {
    return { ok: false, code: 'INVALID_PRECISION' }
  }
  if (raw.rounding !== 'half_away_from_zero') return { ok: false, code: 'UNKNOWN_ROUNDING_POLICY' }
  if (raw.nullPolicy !== 'reject' && raw.nullPolicy !== 'skip' && raw.nullPolicy !== 'zero') {
    return { ok: false, code: 'UNKNOWN_NULL_POLICY' }
  }
  if (raw.divideByZeroPolicy !== 'reject') {
    return { ok: false, code: 'UNKNOWN_DIVIDE_BY_ZERO_POLICY' }
  }

  const normalizedValues: number[] = []
  for (const value of inputValues) {
    if (value === null) {
      if (raw.nullPolicy === 'reject') return { ok: false, code: 'NULL_INPUT_REJECTED' }
      if (raw.nullPolicy === 'zero') normalizedValues.push(0)
      continue
    }
    if (typeof value !== 'number' && typeof value !== 'string') {
      return { ok: false, code: 'INPUT_NOT_NUMERIC' }
    }
    if (typeof value === 'string' && !isNumericString(value)) {
      return { ok: false, code: 'INPUT_NOT_NUMERIC' }
    }
    const numericValue = Number(value)
    if (!Number.isFinite(numericValue)) return { ok: false, code: 'NON_FINITE_INPUT' }
    normalizedValues.push(numericValue)
  }

  const functionName = raw.function
  if (!hasValidArity(functionName, normalizedValues.length)) {
    return { ok: false, code: 'INPUT_ARITY_MISMATCH' }
  }

  let result: number
  switch (functionName) {
    case 'sum':
      result = normalizedValues.reduce((total, value) => total + value, 0)
      break
    case 'difference':
      result = normalizedValues[0] - normalizedValues[1]
      break
    case 'ratio':
      if (normalizedValues[1] === 0) return { ok: false, code: 'DIVIDE_BY_ZERO' }
      result = normalizedValues[0] / normalizedValues[1]
      break
    case 'percent_change':
      if (normalizedValues[1] === 0) return { ok: false, code: 'DIVIDE_BY_ZERO' }
      result = ((normalizedValues[0] - normalizedValues[1]) / Math.abs(normalizedValues[1])) * 100
      break
  }

  if (!Number.isFinite(result)) return { ok: false, code: 'NON_FINITE_RESULT' }
  const rounded = roundHalfAwayFromZero(result, raw.precision as number)
  if (!Number.isFinite(rounded)) return { ok: false, code: 'NON_FINITE_RESULT' }
  return { ok: true, value: Object.is(rounded, -0) ? 0 : rounded }
}

function isTransformFunction(value: unknown): value is FactTransformFunction {
  return FACT_TRANSFORM_FUNCTIONS.some((functionName) => functionName === value)
}

function hasValidArity(functionName: FactTransformFunction, inputCount: number) {
  return functionName === 'sum' ? inputCount >= 1 : inputCount === 2
}

function isNumericString(value: string) {
  return /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())
}

function roundHalfAwayFromZero(value: number, precision: number) {
  const scaled = shiftDecimalExponent(value, precision)
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled))
  return shiftDecimalExponent(rounded, -precision)
}

function shiftDecimalExponent(value: number, places: number) {
  const [coefficient, exponent = '0'] = String(value).split('e')
  return Number(`${coefficient}e${Number(exponent) + places}`)
}
