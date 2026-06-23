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
    },
  },
} as const
