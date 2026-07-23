import { describe, expect, it } from 'vitest'
import {
  FACT_TRANSFORM_REGISTRY_VERSION,
  FACT_TRANSFORM_SCHEMA_VERSION,
  assertResultIntegrity,
  validateResultGrounding,
  type DeterministicFact,
  type DeterministicFactTransform,
  type FactTransformFunction,
  type ResultCellReference,
  type RunResult,
} from '../domain'
import { trendResult } from '../mocks'

const previousReference: ResultCellReference = {
  resultId: trendResult.id,
  rowKey: 'previous',
  columnId: 'net_revenue',
}
const currentReference: ResultCellReference = {
  resultId: trendResult.id,
  rowKey: 'current',
  columnId: 'net_revenue',
}

function resultWithRows(previous: string | number | null = 100, current: string | number | null = 125): RunResult {
  return {
    ...trendResult,
    rows: [
      { key: 'previous', values: { month: '2026-04', net_revenue: previous } },
      { key: 'current', values: { month: '2026-05', net_revenue: current } },
    ],
    answer: {
      ...trendResult.answer,
      facts: [],
    },
  }
}

function transform(
  functionName: FactTransformFunction,
  inputs: ResultCellReference[] = [currentReference, previousReference],
  patch: Partial<DeterministicFactTransform> = {},
): DeterministicFactTransform {
  return {
    schemaVersion: FACT_TRANSFORM_SCHEMA_VERSION,
    registryVersion: FACT_TRANSFORM_REGISTRY_VERSION,
    function: functionName,
    inputs,
    precision: 4,
    rounding: 'half_away_from_zero',
    nullPolicy: 'reject',
    divideByZeroPolicy: 'reject',
    ...patch,
  }
}

function derivedFact(
  functionName: FactTransformFunction,
  value: number,
  patch: Partial<DeterministicFact> = {},
): DeterministicFact {
  const factTransform = transform(functionName)
  return {
    id: `fact_${functionName}`,
    label: functionName,
    value,
    formattedValue: String(value),
    references: factTransform.inputs,
    transform: factTransform,
    ...patch,
  }
}

function groundingFor(fact: DeterministicFact, result = resultWithRows()) {
  return validateResultGrounding({
    ...result,
    answer: {
      ...result.answer,
      facts: [fact],
    },
  })
}

describe('versioned deterministic fact transform registry', () => {
  it('recomputes every whitelisted pure transform before grounding succeeds', () => {
    const cases: Array<[FactTransformFunction, number]> = [
      ['sum', 225],
      ['difference', 25],
      ['ratio', 1.25],
      ['percent_change', 25],
    ]

    for (const [functionName, expectedValue] of cases) {
      const report = groundingFor(derivedFact(functionName, expectedValue))
      expect(report).toMatchObject({
        grounded: true,
        checkedFacts: 1,
        checkedReferences: 2,
        checkedTransforms: 1,
        transformRegistryVersion: FACT_TRANSFORM_REGISTRY_VERSION,
        mismatches: [],
      })
    }
  })

  it('applies explicit precision, rounding, null, and divide-by-zero policies deterministically', () => {
    const oneThird = resultWithRows(3, 1)
    const roundedRatio = derivedFact('ratio', 0.33, {
      references: [currentReference, previousReference],
      transform: transform('ratio', [currentReference, previousReference], { precision: 2 }),
    })
    expect(groundingFor(roundedRatio, oneThird).grounded).toBe(true)

    const halfAwayFromZero = resultWithRows(1, 1.005)
    const roundedHalf = derivedFact('ratio', 1.01, {
      references: [currentReference, previousReference],
      transform: transform('ratio', [currentReference, previousReference], { precision: 2 }),
    })
    expect(groundingFor(roundedHalf, halfAwayFromZero).grounded).toBe(true)

    const nullInput = resultWithRows(null, 125)
    const skippedSumTransform = transform('sum', [currentReference, previousReference], {
      precision: 0,
      nullPolicy: 'skip',
    })
    expect(groundingFor({
      ...derivedFact('sum', 125),
      references: skippedSumTransform.inputs,
      transform: skippedSumTransform,
    }, nullInput).grounded).toBe(true)

    const zeroedSumTransform = transform('sum', [currentReference, previousReference], {
      precision: 0,
      nullPolicy: 'zero',
    })
    expect(groundingFor({
      ...derivedFact('sum', 125),
      references: zeroedSumTransform.inputs,
      transform: zeroedSumTransform,
    }, nullInput).grounded).toBe(true)

    const rejectedNull = transform('sum', [currentReference, previousReference], { nullPolicy: 'reject' })
    expect(groundingFor({
      ...derivedFact('sum', 125),
      references: rejectedNull.inputs,
      transform: rejectedNull,
    }, nullInput).mismatches).toContain('Fact fact_sum transform rejected: NULL_INPUT_REJECTED')

    const zeroBaseline = resultWithRows(0, 125)
    expect(groundingFor(derivedFact('ratio', 0), zeroBaseline).mismatches)
      .toContain('Fact fact_ratio transform rejected: DIVIDE_BY_ZERO')
  })

  it('rejects unknown transforms, unsupported registry versions, and missing inputs', () => {
    const unknown = derivedFact('sum', 225)
    unknown.transform = {
      ...unknown.transform!,
      function: 'average',
    } as unknown as DeterministicFactTransform
    expect(groundingFor(unknown).mismatches).toContain('Fact fact_sum transform rejected: UNKNOWN_TRANSFORM')

    const staleRegistry = derivedFact('sum', 225)
    staleRegistry.transform = {
      ...staleRegistry.transform!,
      registryVersion: 'chatbi_fact_transform_registry.v0',
    } as unknown as DeterministicFactTransform
    expect(groundingFor(staleRegistry).mismatches)
      .toContain('Fact fact_sum transform rejected: UNSUPPORTED_REGISTRY_VERSION')

    const staleSchema = derivedFact('sum', 225)
    staleSchema.transform = {
      ...staleSchema.transform!,
      schemaVersion: 'chatbi_fact_transform.v0',
    } as unknown as DeterministicFactTransform
    expect(groundingFor(staleSchema).mismatches)
      .toContain('Fact fact_sum transform rejected: UNSUPPORTED_SCHEMA_VERSION')

    const invalidPrecision = derivedFact('sum', 225)
    invalidPrecision.transform = {
      ...invalidPrecision.transform!,
      precision: 13,
    }
    expect(groundingFor(invalidPrecision).mismatches)
      .toContain('Fact fact_sum transform rejected: INVALID_PRECISION')

    const oneInput = [currentReference]
    const missingInput = derivedFact('difference', 25, {
      references: oneInput,
      transform: transform('difference', oneInput),
    })
    expect(groundingFor(missingInput).mismatches)
      .toContain('Fact fact_difference transform rejected: INPUT_ARITY_MISMATCH')
  })

  it('rejects mismatched results, cross-result inputs, and non-finite values', () => {
    expect(groundingFor(derivedFact('difference', 999)).mismatches)
      .toContain('Fact fact_difference value does not match its recomputed transform result')

    const crossResultReference = { ...currentReference, resultId: 'another_result' }
    const crossResultTransform = transform('difference', [crossResultReference, previousReference])
    expect(groundingFor(derivedFact('difference', 25, {
      references: crossResultTransform.inputs,
      transform: crossResultTransform,
    })).mismatches).toContain('Fact fact_difference transform references another result')

    expect(groundingFor(derivedFact('sum', 0), resultWithRows(100, '1e309')).mismatches)
      .toContain('Fact fact_sum transform rejected: NON_FINITE_INPUT')

    expect(groundingFor(derivedFact('sum', 0), resultWithRows(1e308, 1e308)).mismatches)
      .toContain('Fact fact_sum transform rejected: NON_FINITE_RESULT')

    expect(groundingFor(derivedFact('sum', Number.POSITIVE_INFINITY)).mismatches)
      .toContain('Fact fact_sum value does not match its recomputed transform result')
  })

  it('requires declared transform inputs to exactly match public result references', () => {
    const fact = derivedFact('difference', 25, {
      references: [currentReference],
    })

    expect(groundingFor(fact).mismatches)
      .toContain('Fact fact_difference transform inputs do not match its result references')
  })

  it('keeps direct facts compatible while rejecting legacy bypass markers and SQL-shaped fields', () => {
    expect(validateResultGrounding(trendResult)).toMatchObject({
      grounded: true,
      checkedTransforms: 0,
      transformRegistryVersion: FACT_TRANSFORM_REGISTRY_VERSION,
    })

    const legacyBypass: DeterministicFact = {
      id: 'legacy_transform',
      label: '旧转换',
      value: 999,
      formattedValue: '999',
      references: [{ ...currentReference, transformId: 'unchecked_expression' }],
    }
    expect(groundingFor(legacyBypass).mismatches)
      .toContain('Fact legacy_transform uses an unsupported legacy transform marker')

    const sqlShapedFact = {
      ...derivedFact('difference', 25),
      sql: 'not-public',
    } as DeterministicFact
    expect(() => assertResultIntegrity({
      ...resultWithRows(),
      answer: { ...trendResult.answer, facts: [sqlShapedFact] },
    })).toThrow('forbidden public field')
  })
})
