import { CONTRACT_VERSION, analysisIrJsonSchema } from '../contracts'

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'InsightFlow ChatBI Local BFF',
    version: CONTRACT_VERSION,
    description: '本地 deterministic BFF 契约草案。生产实现可替换为 Fastify/TypeBox，但路径、包络和安全语义保持兼容。',
  },
  paths: {
    '/healthz': {
      get: {
        summary: '健康检查',
        responses: {
          200: { description: 'BFF 可用' },
        },
      },
    },
    '/openapi.json': {
      get: {
        summary: 'OpenAPI 契约',
        responses: {
          200: { description: 'OpenAPI 3.1 document' },
        },
      },
    },
    '/v1/questions': {
      post: {
        summary: '提交自然语言问题',
        description: '返回 PublicRunView。当前本地实现同步返回最终 mock 状态，生产可改为 202 + SSE。',
        responses: {
          200: { description: '问题已处理或进入澄清/失败状态' },
          400: { description: '请求契约无效' },
          409: { description: '会话已有活动 Run' },
        },
      },
    },
    '/v1/runs/{runId}': {
      get: {
        summary: '获取 Run 快照',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Run 快照' },
          403: { description: '租户/工作空间边界拒绝' },
          404: { description: 'Run 不存在' },
        },
      },
    },
    '/v1/runs/{runId}/clarify': {
      post: {
        summary: '提交澄清候选',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '澄清完成并返回 Run 快照' },
          400: { description: '候选缺失、过期或版本不匹配' },
        },
      },
    },
    '/v1/runs/{runId}/events': {
      get: {
        summary: 'Run SSE 增量事件',
        description: '返回 text/event-stream。支持 Last-Event-ID 请求头或 last_event_id query 参数进行断点续传。',
        parameters: [
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Last-Event-ID', in: 'header', required: false, schema: { type: 'string' } },
          { name: 'conversation_id', in: 'query', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'SSE event stream' },
          403: { description: '租户/工作空间边界拒绝' },
          404: { description: 'Run 不存在' },
        },
      },
    },
    '/v1/runs/{runId}/cancel': {
      post: {
        summary: '取消 Run',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '取消完成并返回 Run 快照' },
          409: { description: '当前 Run 不可取消' },
        },
      },
    },
  },
  components: {
    schemas: {
      AnalysisIR: analysisIrJsonSchema,
      QueryExecutionSummary: {
        type: 'object',
        additionalProperties: false,
        required: [
          'dialect',
          'sqlFingerprint',
          'cacheKey',
          'permissionDigest',
          'dataVersion',
          'estimatedRows',
          'estimatedScanBytes',
          'timeoutMs',
          'maxRows',
          'appliedGuards',
          'status',
        ],
        properties: {
          dialect: { enum: ['postgresql', 'snowflake'] },
          sqlFingerprint: { type: 'string', minLength: 1, description: '原始 SQL 不出现在 PublicRunView，仅暴露稳定指纹。' },
          cacheKey: { type: 'string', minLength: 1 },
          permissionDigest: { type: 'string', minLength: 1 },
          dataVersion: { type: 'string', minLength: 1 },
          estimatedRows: { type: 'integer', minimum: 0 },
          estimatedScanBytes: { type: 'integer', minimum: 0 },
          timeoutMs: { type: 'integer', minimum: 1 },
          maxRows: { type: 'integer', minimum: 1 },
          appliedGuards: { type: 'array', items: { type: 'string' } },
          status: { enum: ['executed', 'blocked'] },
        },
      },
    },
  },
} as const
