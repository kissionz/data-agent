import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_IR_VERSION,
  CONTRACT_VERSION,
  PUBLIC_ERROR_CATALOG,
  analysisIrJsonSchema,
  serializeSseEvents,
  validationError,
} from '@insightflow/contracts'

describe('@insightflow/contracts package entry', () => {
  it('exposes the shared contract constants, schemas and helpers through the package boundary', () => {
    expect(CONTRACT_VERSION).toBe('chatbi.contracts.v0.2')
    expect(ANALYSIS_IR_VERSION).toBe('analysis_ir.v1')
    expect(analysisIrJsonSchema.properties.schemaVersion).toEqual({ const: ANALYSIS_IR_VERSION })
    expect(PUBLIC_ERROR_CATALOG.PERMISSION_DENIED).toMatchObject({
      httpStatus: 403,
      safeForUser: true,
    })
    expect(validationError('契约测试')).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '契约测试',
    })

    expect(serializeSseEvents([{ id: 'evt_1', event: 'run.snapshot', data: { ok: true } }])).toContain('event: run.snapshot')
  })
})
