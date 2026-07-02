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
import {
  createDeveloperEndpointRequest,
  createDeveloperSdkRequest,
  createEmbedFrameConfig,
  createEmbedIframeSnippet,
  requiredScopesForEndpoint,
} from '@insightflow/contracts/sdk'

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
    expect(openApiDocument.components.schemas.PublicApiError).toMatchObject({
      additionalProperties: false,
      properties: {
        code: { enum: expect.arrayContaining(Object.keys(PUBLIC_ERROR_CATALOG)) },
      },
    })
    expect(openApiDocument.paths['/v1/questions'].post.responses[400]).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorEnvelope' },
        },
      },
    })
  })

  it('supports direct api, domain, events, openapi and sdk subpath imports without app-source imports', () => {
    const mode: RunMode = 'trusted'

    expect(API_CONTRACT_VERSION).toBe(CONTRACT_VERSION)
    expect(apiValidationError('子路径测试')).toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(RUN_DISPLAY_STATUSES).toContain('needs_clarification')
    expect(mode).toBe('trusted')
    expect(serializeEventsFromSubpath([{ id: 'evt_2', event: 'run.failed', data: { ok: false } }])).toContain('event: run.failed')
    expect(openApiDocumentFromSubpath.paths['/v1/questions']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/operations/slo']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/results/{runId}']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/data-sources/{dataSourceId}/lineage']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/data-sources/{dataSourceId}/schema-review']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/sharing/exports/{exportId}']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/assets/{assetId}/rename']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/assets/{assetId}/notification-plan']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/developer/api-keys/{keyId}/rotate']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.paths['/v1/developer/webhooks/{webhookId}/deliveries']).toEqual(expect.any(Object))
    expect(openApiDocumentFromSubpath.components.securitySchemes.bearerAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
    expect(openApiDocumentFromSubpath.components.schemas.WebhookDeliveryPlanView).toMatchObject({
      additionalProperties: false,
    })
    expect(openApiDocumentFromSubpath.components.schemas.QueryExecutionSummary).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['cancellation']),
      properties: {
        status: { enum: ['executed', 'blocked', 'cancelled'] },
        cancellation: expect.objectContaining({
          additionalProperties: false,
        }),
      },
    })
    expect(openApiDocumentFromSubpath.components.schemas.ResultPageView).toMatchObject({
      additionalProperties: false,
      properties: {
        rawSqlExposed: { const: false },
        rawDatabaseCredentialsExposed: { const: false },
      },
    })
    expect(openApiDocumentFromSubpath.components.schemas.PublicRunEnvelope).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            data: { $ref: '#/components/schemas/PublicRunView' },
          }),
        }),
      ]),
    })
    expect(openApiDocumentFromSubpath.components.schemas.ResultPageEnvelope).toMatchObject({
      oneOf: expect.arrayContaining([
        expect.objectContaining({
          properties: expect.objectContaining({
            data: { $ref: '#/components/schemas/ResultPageView' },
          }),
        }),
      ]),
    })
    expect(openApiDocumentFromSubpath.paths['/v1/results/{runId}'].get.responses[200]).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ResultPageEnvelope' },
        },
      },
    })
    expect(openApiDocumentFromSubpath.components.schemas.ExportJobView).toMatchObject({
      additionalProperties: false,
      properties: {
        status: { enum: ['completed', 'queued', 'blocked'] },
        delivery: expect.objectContaining({
          properties: expect.objectContaining({
            mode: { enum: ['online', 'async'] },
          }),
        }),
        artifact: expect.objectContaining({
          properties: expect.objectContaining({
            objectKey: expect.objectContaining({ type: 'string' }),
            watermarkApplied: expect.objectContaining({ type: 'boolean' }),
          }),
        }),
        notification: expect.objectContaining({
          properties: expect.objectContaining({
            payloadIncludesDownloadUrl: expect.objectContaining({ type: 'boolean' }),
          }),
        }),
      },
    })
    expect(openApiDocumentFromSubpath.paths['/v1/sharing/exports/{exportId}'].get.responses[200]).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ExportJobEnvelope' },
        },
      },
    })
    expect(openApiDocumentFromSubpath.paths['/v1/sharing/exports/{exportId}/process'].post.responses[200]).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ExportJobEnvelope' },
        },
      },
    })
    expect(requiredScopesForEndpoint('exports.status')).toEqual(['exports:read'])
    expect(requiredScopesForEndpoint('feedback.submit')).toEqual(['feedback:write'])
    expect(requiredScopesForEndpoint('results.page')).toEqual(['runs:read'])
    expect(requiredScopesForEndpoint('embed.issue')).toEqual(['embed:issue'])
  })

  it('builds safe developer SDK requests and embed snippets without database credentials', () => {
    const request = createDeveloperSdkRequest({
      baseUrl: 'https://api.example.com/',
      method: 'POST',
      path: '/v1/questions',
      apiKey: 'ifk_live_redacted',
      idempotencyKey: 'tenant_demo:question:001',
      headers: {
        authorization: 'Bearer attacker_override',
      },
      body: {
        conversation_id: 'conversation_sdk',
        question: '过去 12 个月净收入趋势',
        mode: 'trusted',
      },
    })

    expect(request).toEqual({
      url: 'https://api.example.com/v1/questions',
      method: 'POST',
      headers: expect.objectContaining({
        accept: 'application/json',
        authorization: 'Bearer ifk_live_redacted',
        'content-type': 'application/json',
        'idempotency-key': 'tenant_demo:question:001',
      }),
      body: expect.stringContaining('过去 12 个月净收入趋势'),
    })

    const frame = createEmbedFrameConfig({
      embedOrigin: 'https://embed.example.com',
      embedToken: 'embed_1234567890',
      source: { type: 'asset', assetId: 'asset_revenue_trend' },
      theme: 'light',
      height: 640,
      title: 'Revenue trend',
    })
    const iframe = createEmbedIframeSnippet(frame)

    expect(frame).toMatchObject({
      src: expect.stringContaining('/embed/assets/asset_revenue_trend?'),
      referrerPolicy: 'no-referrer',
      databaseCredentialsAccessible: false,
      style: { height: '640px' },
    })
    expect(frame.src).toContain('#embed_token=embed_1234567890')
    expect(iframe).toContain('<iframe')
    expect(iframe).toContain('sandbox=')

    expect(() => createDeveloperSdkRequest({
      baseUrl: 'https://api.example.com',
      method: 'POST',
      path: '/v1/developer/embed-tokens',
      apiKey: 'ifk_live_redacted',
      body: {
        source: { type: 'asset', assetId: 'asset_revenue_trend' },
        database_password: 'should-not-pass',
      },
    })).toThrow(/database credentials/)

    const pageRequest = createDeveloperEndpointRequest({
      baseUrl: 'https://api.example.com/',
      endpoint: 'results.page',
      apiKey: 'ifk_live_redacted',
      runId: 'run_001',
      conversationId: 'conversation_001',
      cursor: 'offset:50',
      limit: 50,
    })
    expect(pageRequest).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/v1/results/run_001?conversation_id=conversation_001&cursor=offset%3A50&limit=50',
      headers: expect.objectContaining({
        authorization: 'Bearer ifk_live_redacted',
      }),
    })

    const exportStatus = createDeveloperEndpointRequest({
      baseUrl: 'https://api.example.com',
      endpoint: 'exports.status',
      apiKey: 'ifk_live_redacted',
      exportId: 'export_001',
    })
    expect(exportStatus).toMatchObject({
      method: 'GET',
      url: 'https://api.example.com/v1/sharing/exports/export_001',
    })

    expect(() => createDeveloperEndpointRequest({
      baseUrl: 'https://api.example.com',
      endpoint: 'exports.create',
      apiKey: 'ifk_live_redacted',
      body: {
        source: { type: 'run', runId: 'run_001', conversationId: 'conversation_001' },
        database_connection_string: 'postgres://should-not-pass',
      },
    })).toThrow(/database credentials/)

    expect(() => createEmbedFrameConfig({
      embedOrigin: 'http://embed.example.com',
      embedToken: 'embed_1234567890',
      source: { type: 'asset', assetId: 'asset_revenue_trend' },
    })).toThrow(/HTTPS/)
  })
})
