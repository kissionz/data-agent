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
    '/v1/identity/context': {
      get: {
        summary: '获取当前身份、租户、工作空间和策略上下文',
        description: '返回可访问工作空间、业务域、角色、策略版本、权限摘要和缓存失效窗口。',
        responses: {
          200: { description: '身份上下文' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/identity/policies/evaluate': {
      post: {
        summary: '评估 RBAC/ABAC 策略',
        description: '返回 allow/deny、策略版本、权限摘要和 cacheKeyScope；跨租户/跨工作空间/受限导出会拒绝。',
        responses: {
          200: { description: '策略裁决结果' },
          400: { description: '请求契约无效' },
        },
      },
    },
    '/v1/identity/policies/current': {
      post: {
        summary: '更新当前策略版本',
        description: '本地 deterministic 策略更新接口；仅 security_admin 可调用。更新后旧缓存必须按新 policyVersion 失效。',
        responses: {
          200: { description: '策略版本已更新' },
          403: { description: '非安全管理员不可更新策略' },
        },
      },
    },
    '/v1/model-ops/routes': {
      get: {
        summary: '列出模型路由、配额和降级链',
        description: '返回按租户覆盖后的模型能力、供应商、生产/候选版本、灰度流量、超时、温度、配额、降级链和审计事件。',
        parameters: [
          { name: 'capability', in: 'query', required: false, schema: { enum: ['all', 'planner', 'entity_linker', 'answer'] } },
        ],
        responses: {
          200: { description: '模型路由列表' },
          400: { description: '身份上下文无效' },
        },
      },
    },
    '/v1/model-ops/route': {
      post: {
        summary: '执行一次模型路由决策',
        description: '按能力、租户策略、配额、供应商可用性、发布门禁和灰度配置选择 active/candidate/fallback 模型。',
        responses: {
          200: { description: '模型路由决策，可能 routed、fallback 或 blocked' },
          400: { description: '请求契约或身份上下文无效' },
          404: { description: '模型能力没有对应路由' },
        },
      },
    },
    '/v1/model-ops/routes/{routeId}/rollback': {
      post: {
        summary: '回滚模型路由灰度版本',
        description: '仅 platform_ops/security_admin 可调用；回滚后流量切回 active=100%、candidate=0%。',
        parameters: [{ name: 'routeId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '模型路由已回滚' },
          403: { description: '角色无权回滚模型路由' },
          404: { description: '模型路由不存在' },
        },
      },
    },
    '/v1/operations/slo': {
      get: {
        summary: '获取运营 SLO 报告',
        description: '返回可用性、延迟、成本、取消传播等目标的当前窗口状态、错误预算、告警和审计事件。当前为本地 deterministic 控制面，生产需接入真实监控事件。',
        parameters: [
          { name: 'window', in: 'query', required: false, schema: { enum: ['7d', '30d', '90d'] } },
        ],
        responses: {
          200: { description: 'SLO 报告' },
          400: { description: '身份上下文或窗口无效' },
        },
      },
    },
    '/v1/operations/slo/budget-evaluations': {
      post: {
        summary: '评估单次 Run 的性能预算',
        description: '按完整答案延迟、单次成本、扫描量和可选取消传播时间返回 allow/warn/block 决策，并在预警或阻断时生成告警审计。',
        responses: {
          200: { description: '性能预算决策' },
          400: { description: '请求契约或身份上下文无效' },
        },
      },
    },
    '/v1/developer/service-accounts': {
      post: {
        summary: '创建服务账号',
        description: '仅 platform_ops/security_admin 可调用；服务账号绑定当前工作区、业务域、scope、过期时间和日请求配额。',
        responses: {
          200: { description: '服务账号已创建' },
          400: { description: 'scope、配额或过期时间无效' },
          403: { description: '角色无权管理开发者接入' },
        },
      },
    },
    '/v1/developer/api-keys': {
      post: {
        summary: '签发 API Key',
        description: '为服务账号签发短期 API Key；只返回前缀、脱敏预览和 hash 指纹，不返回可复用明文密钥。',
        responses: {
          200: { description: 'API Key 已签发' },
          404: { description: '服务账号不存在或已撤销' },
        },
      },
    },
    '/v1/developer/api-keys/{keyId}/revoke': {
      post: {
        summary: '撤销 API Key',
        parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'API Key 已撤销' },
          404: { description: 'API Key 不存在' },
        },
      },
    },
    '/v1/developer/webhooks': {
      post: {
        summary: '注册 Webhook',
        description: 'Webhook 必须使用 HTTPS，启用 HMAC-SHA256 签名、300 秒重放保护、指数退避和死信策略；事件载荷不得超出订阅者权限。',
        responses: {
          200: { description: 'Webhook 已注册' },
          400: { description: 'URL 或事件列表无效' },
        },
      },
    },
    '/v1/developer/webhooks/{webhookId}/test': {
      post: {
        summary: '发送 Webhook 测试事件',
        parameters: [{ name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Webhook 测试事件已接受' },
          404: { description: 'Webhook 不存在' },
        },
      },
    },
    '/v1/developer/embed-tokens': {
      post: {
        summary: '签发短期嵌入 token',
        description: 'Host 使用自身权限换取 5–120 分钟短期 embed token；组件不能接触数据库凭据，只能读授权 run 或 asset。',
        responses: {
          200: { description: '嵌入 token 已签发' },
          400: { description: 'Host Origin 或 TTL 无效' },
        },
      },
    },
    '/v1/sharing/exports': {
      post: {
        summary: '请求导出结果或资产',
        description: '导出前重新鉴权，检查分类策略、100k 行/50MB 在线限制，生成水印、脱敏计划和短期下载链接预览。',
        responses: {
          200: { description: '导出任务，可能 completed 或 blocked' },
          400: { description: '请求契约无效' },
        },
      },
    },
    '/v1/sharing/shares': {
      post: {
        summary: '创建分享引用',
        description: '分享只保存 run/asset 引用，不复制高权限结果；接收者打开时必须重新鉴权。',
        responses: {
          200: { description: '分享引用已创建' },
          400: { description: '接收者或有效期无效' },
        },
      },
    },
    '/v1/sharing/shares/{shareId}/reauthorize': {
      post: {
        summary: '分享接收者重新鉴权',
        description: '按接收者当前身份、工作空间、业务域和策略版本裁决，不复用分享者结果。',
        parameters: [{ name: 'shareId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '重新鉴权结果' },
          404: { description: '分享不存在或不可见' },
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
