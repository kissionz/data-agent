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
    '/v1/assets': {
      get: {
        summary: '列出协作资产',
        description: '返回当前 actor 可见的会话资产、验证案例、问题模板和订阅，已按分享范围与审核状态过滤。',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { enum: ['all', 'active', 'review', 'archived'] } },
        ],
        responses: {
          200: { description: '协作资产列表' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/data-sources': {
      get: {
        summary: '列出数据源',
        description: '返回当前 actor 可见的数据源、连接状态、质量门禁、安全摘要和元数据目录。',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { enum: ['all', 'healthy', 'degraded', 'failed', 'syncing', 'draft'] } },
        ],
        responses: {
          200: { description: '数据源列表' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/evaluation/gates/current': {
      get: {
        summary: '获取当前候选版本黄金集发布门禁',
        description: '返回 P0/P1 指标、发布裁决、阻断原因和评测审计事件；任一 P0 指标失败时 releaseAllowed=false。',
        parameters: [
          { name: 'candidate_version', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: '发布门禁报告' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/evaluation/replays': {
      get: {
        summary: '列出失败回放样本',
        description: '返回可见的失败、阻断和部分结果回放样本；阻断样本受角色限制。',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { enum: ['all', 'failed', 'partial', 'blocked'] } },
          { name: 'domain', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: '失败回放列表' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/evaluation/replays/{runId}': {
      get: {
        summary: '获取失败回放详情',
        description: '返回执行阶段、失败原因、SQL/执行摘要和候选版本重放计划；重放计划不会使用生产凭据。',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '失败回放详情' },
          404: { description: '回放不存在或不可见' },
        },
      },
    },
    '/v1/semantic/metrics': {
      get: {
        summary: '列出语义指标治理对象',
        description: '返回当前 actor 可见的语义指标、维度、Join Graph 风险和发布就绪状态。',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'lifecycle', in: 'query', required: false, schema: { enum: ['all', 'draft', 'review', 'certified', 'deprecated', 'offline'] } },
        ],
        responses: {
          200: { description: '语义指标列表' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/semantic/metrics/{metricId}': {
      get: {
        summary: '获取语义指标治理详情',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '语义指标详情、发布就绪状态和审计事件' },
          404: { description: '指标不存在或不可见' },
        },
      },
    },
    '/v1/semantic/metrics/{metricId}/submit-review': {
      post: {
        summary: '提交语义指标评审',
        description: '仅 metric_admin/data_admin/platform_ops 可提交；只有 draft 指标可进入 review。',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '指标已进入评审' },
          403: { description: '角色无权提交' },
          400: { description: '生命周期状态不允许提交' },
        },
      },
    },
    '/v1/semantic/metrics/{metricId}/certify': {
      post: {
        summary: '认证发布语义指标',
        description: '需要参考 SQL 对账通过，且 Join Graph 无高风险/未批准路径。',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '指标已认证发布' },
          400: { description: '对账或 Join Graph 门禁阻断' },
          403: { description: '角色无权认证' },
        },
      },
    },
    '/v1/data-sources/{dataSourceId}': {
      get: {
        summary: '获取数据源元数据目录',
        parameters: [{ name: 'dataSourceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '数据源详情、表、字段分类和质量门禁' },
          404: { description: '数据源不存在或不可见' },
        },
      },
    },
    '/v1/data-sources/{dataSourceId}/test-connection': {
      post: {
        summary: '测试数据源只读连接',
        description: '返回连接测试结果；只暴露 credential reference，不暴露真实凭据。',
        parameters: [{ name: 'dataSourceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '连接测试结果' },
          404: { description: '数据源不存在或不可见' },
        },
      },
    },
    '/v1/assets/{assetId}/favorite': {
      post: {
        summary: '更新协作资产收藏状态',
        parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '收藏状态已更新' },
          404: { description: '资产不存在或不可见' },
        },
      },
    },
    '/v1/assets/{assetId}/subscription': {
      post: {
        summary: '更新协作资产订阅',
        description: '审核中或已归档资产不能开启订阅；接收者读取时仍需重新鉴权。',
        parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '订阅状态已更新' },
          400: { description: '订阅频率无效或资产状态不允许订阅' },
          404: { description: '资产不存在或不可见' },
        },
      },
    },
    '/v1/assets/{assetId}/audit': {
      get: {
        summary: '获取协作资产审计链路',
        parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '资产审计事件' },
          404: { description: '资产不存在或不可见' },
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
