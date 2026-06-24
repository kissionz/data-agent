import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_IR_VERSION,
  CONTRACT_VERSION,
  PUBLIC_ERROR_CATALOG,
  analysisIrJsonSchema,
  openApiDocument,
  serializeSseEvents,
  validationError,
} from '@insightflow/contracts'
import { CONTRACT_VERSION as API_CONTRACT_VERSION, validationError as apiValidationError } from '@insightflow/contracts/api'
import { RUN_DISPLAY_STATUSES, type RunMode } from '@insightflow/contracts/domain'
import { serializeSseEvents as serializeEventsFromSubpath } from '@insightflow/contracts/events'
import { openApiDocument as openApiDocumentFromSubpath } from '@insightflow/contracts/openapi'

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
    expect(openApiDocument.info.version).toBe(CONTRACT_VERSION)
    expect(openApiDocument.components.schemas.AnalysisIR).toBe(analysisIrJsonSchema)
  })

  it('supports direct api, domain and events subpath imports without app-source imports', () => {
    const mode: RunMode = 'trusted'

    expect(API_CONTRACT_VERSION).toBe(CONTRACT_VERSION)
    expect(apiValidationError('子路径测试')).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(RUN_DISPLAY_STATUSES).toContain('needs_clarification')
    expect(mode).toBe('trusted')
    expect(serializeEventsFromSubpath([{ id: 'evt_2', event: 'run.failed', data: { ok: false } }])).toContain('event: run.failed')
    expect(openApiDocumentFromSubpath.paths['/v1/questions']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/operations/slo']).toEqual(expect.any(Object))
  })
})
