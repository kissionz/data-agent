import { ANALYSIS_IR_VERSION, CONTRACT_VERSION, PUBLIC_ERROR_CATALOG, analysisIrJsonSchema } from './api'

const publicErrorCodeEnum = Object.keys(PUBLIC_ERROR_CATALOG)

function jsonResponse(description: string, schema: Record<string, unknown> = { $ref: '#/components/schemas/ApiEnvelope' }) {
  return {
    description,
    content: {
      'application/json': {
        schema,
      },
    },
  }
}

function errorResponse(description: string) {
  return jsonResponse(description, { $ref: '#/components/schemas/ErrorEnvelope' })
}

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'InsightFlow ChatBI Local BFF',
    version: CONTRACT_VERSION,
    description: '本地 deterministic BFF 契约草案。生产实现可替换为 Fastify/TypeBox，但路径、包络和安全语义保持兼容。',
  },
  security: [{ bearerAuth: [] }],
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
          200: jsonResponse('OpenAPI 3.1 document', { type: 'object', additionalProperties: true }),
        },
      },
    },
    '/v1/questions': {
      post: {
        summary: '提交自然语言问题',
        description: '返回 PublicRunView。当前本地实现同步返回最终 mock 状态，生产可改为 202 + SSE。',
        responses: {
          200: jsonResponse('问题已处理或进入澄清/失败状态', { $ref: '#/components/schemas/PublicRunEnvelope' }),
          400: errorResponse('请求契约无效'),
          409: errorResponse('会话已有活动 Run'),
        },
      },
    },
    '/v1/feedback': {
      post: {
        summary: '提交答案反馈或问题上报',
        description: '反馈关联 run/request/trace/语义版本并重新校验运行访问范围；备注和正确答案先脱敏，不携带生产结果明细。',
        responses: {
          200: jsonResponse('反馈已进入处理队列', { $ref: '#/components/schemas/FeedbackEnvelope' }),
          400: errorResponse('反馈缺少链路字段、原因标签或格式无效'),
          403: errorResponse('无权为该运行提交反馈'),
          404: errorResponse('运行不存在或不可见'),
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
    '/v1/developer/api-keys/{keyId}/rotate': {
      post: {
        summary: '轮换 API Key',
        description: '签发新的短期 API Key，并让旧 key 进入 rotating 状态；旧 key 仅在 grace window 内继续可验签，过期后自动拒绝。',
        parameters: [{ name: 'keyId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  expires_in_days: { type: 'integer', minimum: 1, maximum: 90, default: 30 },
                  grace_minutes: { type: 'integer', minimum: 5, maximum: 1440, default: 60 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'API Key 已轮换；响应只包含脱敏预览和 hash 指纹' },
          400: { description: '有效期或宽限期无效' },
          404: { description: 'API Key 不存在或不可轮换' },
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
    '/v1/developer/webhooks/{webhookId}/deliveries': {
      post: {
        summary: '规划一次 Webhook 签名投递',
        description: '生成 HMAC-SHA256 签名 headers、300 秒重放保护窗口、指数退避重试计划和死信结果；当前为 deterministic contract，生产由异步队列与 HTTP client 执行。',
        parameters: [{ name: 'webhookId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['event', 'payload'],
                properties: {
                  event: { enum: ['run.completed', 'run.failed', 'asset.updated'] },
                  payload: { type: 'object', additionalProperties: true, description: '投递载荷；响应中只返回 payloadRedacted=true，不回显敏感内容。' },
                  simulated_http_statuses: { type: 'array', items: { type: 'integer', minimum: 100, maximum: 599 } },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Webhook 投递计划，可能 queued、accepted 或 dead_lettered' },
          400: { description: '事件未订阅或请求契约无效' },
          404: { description: 'Webhook 不存在或未激活' },
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
        description: '导出前重新鉴权，检查分类策略、100k 行/50MB 在线限制；小文件返回短期下载链接，大文件进入受审计异步导出队列。',
        responses: {
          200: jsonResponse('导出任务，可能 completed、queued 或 blocked', { $ref: '#/components/schemas/ExportJobEnvelope' }),
          400: errorResponse('请求契约无效'),
        },
      },
    },
    '/v1/sharing/exports/{exportId}': {
      get: {
        summary: '查询导出任务状态',
        description: '返回导出任务当前状态、异步队列信息、水印/脱敏计划和审计事件；跨租户/工作区不可见。',
        parameters: [{ name: 'exportId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('导出任务状态', { $ref: '#/components/schemas/ExportJobEnvelope' }),
          404: errorResponse('导出任务不存在或不可见'),
        },
      },
    },
    '/v1/sharing/exports/{exportId}/process': {
      post: {
        summary: '异步导出 worker 完成任务',
        description: '由受信任 worker 将 queued 导出推进为 completed，返回对象存储制品清单、水印状态、短期下载预览和不含下载链接的通知计划。',
        parameters: [{ name: 'exportId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('异步导出已处理', { $ref: '#/components/schemas/ExportJobEnvelope' }),
          400: errorResponse('任务状态不可处理'),
          404: errorResponse('导出任务不存在或不可见'),
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
          200: jsonResponse('Run 快照', { $ref: '#/components/schemas/PublicRunEnvelope' }),
          403: errorResponse('租户/工作空间边界拒绝'),
          404: errorResponse('Run 不存在'),
        },
      },
    },
    '/v1/results/{runId}': {
      get: {
        summary: '分页读取 Run 结果集',
        description: '按 cursor/limit 返回 public-safe 结果页；服务端重新校验租户、工作空间和策略边界，只暴露 SQL 指纹/权限摘要，不暴露原始 SQL 或数据库凭据。',
        parameters: [
          { name: 'runId', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'conversation_id', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'cursor', in: 'query', required: false, schema: { type: 'string', pattern: '^offset:[0-9]+$' } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 50 } },
        ],
        responses: {
          200: jsonResponse('结果页，包含列定义、当前页行、下一页 cursor 和权限摘要', { $ref: '#/components/schemas/ResultPageEnvelope' }),
          400: errorResponse('cursor 或 limit 无效'),
          403: errorResponse('租户/工作空间边界拒绝'),
          404: errorResponse('Run 或结果不存在'),
        },
      },
    },
    '/v1/runs/{runId}/clarify': {
      post: {
        summary: '提交澄清候选',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('澄清完成并返回 Run 快照', { $ref: '#/components/schemas/PublicRunEnvelope' }),
          400: errorResponse('候选缺失、过期或版本不匹配'),
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
          403: errorResponse('租户/工作空间边界拒绝'),
          404: errorResponse('Run 不存在'),
        },
      },
    },
    '/v1/runs/{runId}/cancel': {
      post: {
        summary: '取消 Run',
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('取消完成并返回 Run 快照', { $ref: '#/components/schemas/PublicRunEnvelope' }),
          409: errorResponse('当前 Run 不可取消'),
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
    '/v1/evaluation/golden-samples': {
      get: {
        summary: '列出可见黄金集样本',
        description: '按当前租户和工作空间隔离，支持问题/ID、状态、业务域、语义版本和标签筛选。',
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { enum: ['all', 'candidate_dataset', 'golden_approved'] } },
          { name: 'domain', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'semantic_version', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'tag', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: jsonResponse('黄金集样本列表', { $ref: '#/components/schemas/GoldenSampleListEnvelope' }),
          400: errorResponse('筛选状态或身份上下文无效'),
          403: errorResponse('角色无权查看黄金集'),
        },
      },
      post: {
        summary: '接收黄金集候选样本',
        description: '线上样本必须先脱敏、去重并人工标注；通过后进入 candidate_dataset，不能直接进入 golden_approved。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/IngestGoldenSampleInput' },
            },
          },
        },
        responses: {
          200: jsonResponse('样本已进入黄金集候选集', { $ref: '#/components/schemas/GoldenSampleEnvelope' }),
          400: errorResponse('样本字段无效或未通过脱敏/去重/人工标注门禁'),
          403: errorResponse('角色无权管理黄金集'),
        },
      },
    },
    '/v1/evaluation/golden-samples/{sampleId}': {
      get: {
        summary: '获取黄金集样本详情',
        description: '返回脱敏问题、期望标注、质量门禁、生命周期、语义版本和审计；越工作空间与不存在使用相同 404。',
        parameters: [{ name: 'sampleId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('黄金集样本详情', { $ref: '#/components/schemas/GoldenSampleEnvelope' }),
          403: errorResponse('角色无权查看黄金集'),
          404: errorResponse('样本不存在或不可见'),
        },
      },
    },
    '/v1/evaluation/golden-samples/{sampleId}/approve': {
      post: {
        summary: '审批黄金集样本',
        description: '将 candidate_dataset 样本审批为 golden_approved，供批量回归和发布门禁使用。',
        parameters: [{ name: 'sampleId', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['note'],
                properties: { note: { type: 'string', minLength: 1, maxLength: 500 } },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('样本已审批进入黄金集', { $ref: '#/components/schemas/GoldenSampleEnvelope' }),
          400: errorResponse('审批说明无效或样本状态不可审批'),
          403: errorResponse('角色无权审批'),
        },
      },
    },
    '/v1/evaluation/regression-runs': {
      get: {
        summary: '列出可见批量回归计划',
        description: '按当前租户和工作空间隔离，支持状态和候选版本筛选；为后续 worker 轮询预留 queued/running/terminal 状态契约，当前治理切片只生成 queued 计划。',
        parameters: [
          { name: 'status', in: 'query', required: false, schema: { enum: ['all', 'queued', 'running', 'passed', 'failed', 'release_blocked'] } },
          { name: 'candidate_version', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          200: jsonResponse('批量回归计划列表', { $ref: '#/components/schemas/RegressionRunListEnvelope' }),
          400: errorResponse('筛选状态或身份上下文无效'),
          403: errorResponse('角色无权查看批量回归'),
        },
      },
      post: {
        summary: '调度候选版本批量回归',
        description: '对已审批黄金集样本调度 retrieval/planner/compiler/query/grounding 链路回归；回归计划不使用生产凭据，并联动发布门禁。',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['candidateVersion'],
                properties: {
                  candidateVersion: { type: 'string', minLength: 1, maxLength: 128 },
                  sampleIds: {
                    type: 'array',
                    uniqueItems: true,
                    items: { type: 'string', minLength: 1 },
                  },
                },
              },
            },
          },
        },
        responses: {
          200: jsonResponse('批量回归计划已排队', { $ref: '#/components/schemas/RegressionRunEnvelope' }),
          400: errorResponse('候选版本或样本范围无效，或缺少已审批黄金集样本'),
          403: errorResponse('角色无权调度回归'),
        },
      },
    },
    '/v1/evaluation/regression-runs/{regressionRunId}': {
      get: {
        summary: '获取批量回归计划详情',
        description: '返回样本范围、阶段、已完成阶段、安全边界和发布门关联；越工作空间与不存在使用相同 404。',
        parameters: [{ name: 'regressionRunId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: jsonResponse('批量回归计划详情', { $ref: '#/components/schemas/RegressionRunEnvelope' }),
          403: errorResponse('角色无权查看批量回归'),
          404: errorResponse('回归计划不存在或不可见'),
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
        description: '需要自动参考 SQL 对账通过或显式携带已对账证明，且 Join Graph 无高风险/未批准路径。',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '指标已认证发布' },
          400: { description: '对账或 Join Graph 门禁阻断' },
          403: { description: '角色无权认证' },
        },
      },
    },
    '/v1/semantic/metrics/{metricId}/reconcile-reference': {
      post: {
        summary: '执行参考 SQL 自动对账',
        description: '比较参考 SQL 与编译 SQL 的指纹、样本行数、最大偏差和容差；失败会阻断认证发布。',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '对账结果，包含 passed/failed 和是否阻断认证' },
          400: { description: '对账参数无效' },
          403: { description: '角色无权对账' },
        },
      },
    },
    '/v1/semantic/metrics/{metricId}/release-plan': {
      post: {
        summary: '规划语义指标灰度发布',
        description: '为 certified 指标生成 5/20/50/100 或自定义阶段的灰度计划，每阶段带自动回滚阈值和 runbook。',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '语义灰度发布计划' },
          400: { description: '指标状态或灰度比例无效' },
          403: { description: '角色无权规划发布' },
        },
      },
    },
    '/v1/semantic/metrics/{metricId}/rollback': {
      post: {
        summary: '回滚语义指标发布',
        description: '仅 metric_admin/platform_ops/security_admin 可调用；回滚后当前 certified 指标降为 deprecated，历史版本保留只读。',
        parameters: [{ name: 'metricId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '语义指标已回滚' },
          400: { description: '指标状态不可回滚' },
          403: { description: '角色无权回滚' },
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
    '/v1/data-sources/{dataSourceId}/lineage': {
      get: {
        summary: '获取数据源字段级血缘',
        description: '返回上游来源、下游认证指标/看板/验证案例影响、字段级引用和 Schema 变更审批摘要。',
        parameters: [{ name: 'dataSourceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '字段级血缘与下游影响' },
          404: { description: '数据源不存在或不可见' },
        },
      },
    },
    '/v1/data-sources/{dataSourceId}/schema-review': {
      post: {
        summary: '评审数据源 Schema 变更',
        description: '按字段血缘、认证指标、受限字段和下游资产影响返回 approved/blocked/requires_review 裁决。',
        parameters: [{ name: 'dataSourceId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Schema 变更评审结果' },
          403: { description: '角色无权评审' },
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
    '/v1/assets/{assetId}/rename': {
      post: {
        summary: '重命名协作资产',
        description: '仅分析师、指标管理员或平台运维可重命名活跃资产；审核中和归档资产不能重命名。',
        parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '资产已重命名' },
          400: { description: '名称长度无效或资产状态不允许重命名' },
          403: { description: '角色无权重命名' },
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
    '/v1/assets/{assetId}/notification-plan': {
      post: {
        summary: '生成协作资产订阅通知计划',
        description: '不会发送真实通知；返回接收者重新鉴权、水印、明细行排除和阻断原因。',
        parameters: [{ name: 'assetId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: '通知计划或阻断计划已生成' },
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
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API Key',
        description: 'Authorization: Bearer <api-key>；apps/api 会验签、校验 scope/配额/边界，并注入 service-account actor。',
      },
    },
    schemas: {
      PublicApiError: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message', 'retryable', 'debugReference'],
        properties: {
          code: {
            enum: publicErrorCodeEnum,
            description: '公共错误码；完整 HTTP 映射由 PUBLIC_ERROR_CATALOG 维护。',
          },
          message: { type: 'string', minLength: 1 },
          retryable: { type: 'boolean' },
          debugReference: {
            type: 'string',
            minLength: 1,
            description: '可给支持团队定位的安全引用，不包含 SQL、凭据或无权资源明细。',
          },
        },
      },
      ErrorEnvelope: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'error', 'requestId', 'traceId'],
        properties: {
          ok: { const: false },
          error: { $ref: '#/components/schemas/PublicApiError' },
          requestId: { type: 'string', minLength: 1 },
          traceId: { type: 'string', minLength: 1 },
        },
      },
      ApiEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { type: 'object', additionalProperties: true },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      PublicRunView: {
        type: 'object',
        additionalProperties: true,
        required: [
          'contractVersion',
          'requestId',
          'traceId',
          'runId',
          'conversationId',
          'question',
          'displayStatus',
          'mode',
          'semanticVersion',
          'version',
          'executedQuery',
          'audit',
          'updatedAt',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          requestId: { type: 'string', minLength: 1 },
          traceId: { type: 'string', minLength: 1 },
          runId: { type: 'string', minLength: 1 },
          conversationId: { type: 'string', minLength: 1 },
          question: { type: 'string', minLength: 1 },
          displayStatus: { enum: ['waiting_input', 'understanding', 'querying', 'completed', 'needs_clarification', 'failed'] },
          mode: { enum: ['trusted', 'exploration', 'expert'] },
          semanticVersion: { type: 'string', minLength: 1 },
          version: { type: 'integer', minimum: 1 },
          executedQuery: { type: 'boolean' },
          retrieval: {
            type: 'object',
            additionalProperties: true,
            required: ['strategyVersion', 'normalizedQuestion', 'permissionFilter', 'entityLinks', 'safeguards', 'qualityTargets'],
            properties: {
              strategyVersion: { type: 'string', minLength: 1 },
              normalizedQuestion: { type: 'string', minLength: 1 },
              permissionFilter: { type: 'object', additionalProperties: true },
              entityLinks: { type: 'array', items: { type: 'object', additionalProperties: true } },
              safeguards: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  permissionFilteredBeforeRanking: { type: 'boolean' },
                  exposesUnauthorizedCandidates: { const: false },
                  preservesOriginalConstraints: { type: 'boolean' },
                },
              },
              qualityTargets: { type: 'object', additionalProperties: true },
            },
          },
          planner: {
            type: 'object',
            additionalProperties: true,
            required: ['plannerVersion', 'schemaVersion', 'normalizedQuestion', 'steps', 'ambiguity', 'replay'],
            properties: {
              plannerVersion: { type: 'string', minLength: 1 },
              schemaVersion: { const: ANALYSIS_IR_VERSION },
              normalizedQuestion: { type: 'string', minLength: 1 },
              steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
              ambiguity: { type: 'object', additionalProperties: true },
              replay: { type: 'object', additionalProperties: true },
            },
          },
          analysisIr: { $ref: '#/components/schemas/AnalysisIR' },
          queryExecution: { $ref: '#/components/schemas/QueryExecutionSummary' },
          result: { type: 'object', additionalProperties: true },
          error: { $ref: '#/components/schemas/PublicApiError' },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
          updatedAt: { type: 'string', minLength: 1 },
        },
      },
      PublicRunEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { $ref: '#/components/schemas/PublicRunView' },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      ResultPageEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { $ref: '#/components/schemas/ResultPageView' },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      ExportJobEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { $ref: '#/components/schemas/ExportJobView' },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      IngestGoldenSampleInput: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sourceRunId',
          'sanitizedQuestion',
          'domain',
          'expectedIntent',
          'expectedMetricIds',
          'expectedDimensionIds',
          'semanticVersion',
          'tags',
          'desensitized',
          'deduplicated',
          'humanLabeled',
        ],
        properties: {
          sourceRunId: { type: 'string', minLength: 1 },
          sanitizedQuestion: { type: 'string', minLength: 1, maxLength: 500 },
          domain: { type: 'string', minLength: 1 },
          expectedIntent: { enum: ['trend', 'breakdown', 'ranking', 'lookup', 'clarification', 'empty_check'] },
          expectedMetricIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          expectedDimensionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          semanticVersion: { type: 'string', minLength: 1 },
          tags: { type: 'array', items: { type: 'string', minLength: 1 } },
          desensitized: { const: true },
          deduplicated: { const: true },
          humanLabeled: { const: true },
        },
      },
      GoldenSampleView: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractVersion',
          'id',
          'sourceRunId',
          'status',
          'domain',
          'sanitizedQuestion',
          'expectedIntent',
          'expectedMetricIds',
          'expectedDimensionIds',
          'semanticVersion',
          'tags',
          'createdAt',
          'qualityGates',
          'audit',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          id: { type: 'string', minLength: 1 },
          sourceRunId: { type: 'string', minLength: 1 },
          status: { enum: ['new', 'triaged', 'in_review', 'resolved', 'rejected', 'candidate_dataset', 'golden_approved'] },
          domain: { type: 'string', minLength: 1 },
          sanitizedQuestion: { type: 'string', minLength: 1, maxLength: 500 },
          expectedIntent: { enum: ['trend', 'breakdown', 'ranking', 'lookup', 'clarification', 'empty_check'] },
          expectedMetricIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          expectedDimensionIds: { type: 'array', items: { type: 'string', minLength: 1 } },
          semanticVersion: { type: 'string', minLength: 1 },
          tags: { type: 'array', items: { type: 'string', minLength: 1 } },
          createdAt: { type: 'string', format: 'date-time' },
          qualityGates: {
            type: 'object',
            additionalProperties: false,
            required: ['desensitized', 'deduplicated', 'humanLabeled', 'productionCredentialsRemoved'],
            properties: {
              desensitized: { type: 'boolean' },
              deduplicated: { type: 'boolean' },
              humanLabeled: { type: 'boolean' },
              productionCredentialsRemoved: { const: true },
            },
          },
          approvedBy: { type: 'string', minLength: 1 },
          approvedAt: { type: 'string', format: 'date-time' },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      RegressionRunPlanView: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractVersion',
          'id',
          'candidateVersion',
          'status',
          'createdAt',
          'requestedBy',
          'sampleIds',
          'sampleCount',
          'stages',
          'usesProductionCredentials',
          'releaseGateLinked',
          'completedStages',
          'audit',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          id: { type: 'string', minLength: 1 },
          candidateVersion: { type: 'string', minLength: 1, maxLength: 128 },
          status: { enum: ['queued', 'running', 'passed', 'failed', 'release_blocked'] },
          createdAt: { type: 'string', format: 'date-time' },
          requestedBy: { type: 'string', minLength: 1 },
          sampleIds: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
          sampleCount: { type: 'integer', minimum: 1 },
          stages: {
            type: 'array',
            items: { enum: ['retrieval', 'planner', 'compiler', 'query_gateway', 'answer_grounding'] },
          },
          usesProductionCredentials: { const: false },
          releaseGateLinked: { const: true },
          completedStages: {
            type: 'array',
            items: { enum: ['retrieval', 'planner', 'compiler', 'query_gateway', 'answer_grounding'] },
          },
          releaseGateDecision: { enum: ['pass', 'blocked'] },
          failureReason: { type: 'string' },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      GoldenSampleEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { $ref: '#/components/schemas/GoldenSampleView' },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      GoldenSampleListEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['items', 'total'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/GoldenSampleView' } },
                  total: { type: 'integer', minimum: 0 },
                },
              },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      RegressionRunEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { $ref: '#/components/schemas/RegressionRunPlanView' },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      RegressionRunListEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: {
                type: 'object',
                additionalProperties: false,
                required: ['items', 'total'],
                properties: {
                  items: { type: 'array', items: { $ref: '#/components/schemas/RegressionRunPlanView' } },
                  total: { type: 'integer', minimum: 0 },
                },
              },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      FeedbackView: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractVersion',
          'id',
          'status',
          'vote',
          'reasonTags',
          'sensitiveDataRedacted',
          'linkage',
          'accessReauthorized',
          'productionResultIncluded',
          'candidateDatasetEligible',
          'audit',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          id: { type: 'string', minLength: 1 },
          status: { const: 'new' },
          vote: { enum: ['helpful', 'unhelpful'] },
          reasonTags: {
            type: 'array',
            uniqueItems: true,
            items: {
              enum: [
                'wrong_number',
                'wrong_metric',
                'wrong_filter',
                'misleading_chart',
                'stale_data',
                'incomplete_answer',
                'permission_issue',
                'other',
              ],
            },
          },
          sanitizedNote: { type: 'string', maxLength: 1000 },
          sanitizedCorrectedAnswer: { type: 'string', maxLength: 1000 },
          sensitiveDataRedacted: { type: 'boolean' },
          linkage: {
            type: 'object',
            additionalProperties: false,
            required: ['runId', 'conversationId', 'requestId', 'traceId', 'semanticVersion', 'tenantId', 'workspaceId'],
            properties: {
              runId: { type: 'string' },
              conversationId: { type: 'string' },
              requestId: { type: 'string' },
              traceId: { type: 'string' },
              semanticVersion: { type: 'string' },
              tenantId: { type: 'string' },
              workspaceId: { type: 'string' },
            },
          },
          accessReauthorized: { const: true },
          productionResultIncluded: { const: false },
          candidateDatasetEligible: { type: 'boolean' },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      FeedbackEnvelope: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'data', 'requestId', 'traceId'],
            properties: {
              ok: { const: true },
              data: { $ref: '#/components/schemas/FeedbackView' },
              requestId: { type: 'string', minLength: 1 },
              traceId: { type: 'string', minLength: 1 },
            },
          },
          { $ref: '#/components/schemas/ErrorEnvelope' },
        ],
      },
      AnalysisIR: analysisIrJsonSchema,
      WebhookDeliveryPlanView: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractVersion',
          'id',
          'webhookId',
          'event',
          'url',
          'finalState',
          'signingAlgorithm',
          'headers',
          'replayProtectionExpiresAt',
          'attempts',
          'payloadRedacted',
          'deliversOnlyAuthorizedData',
          'audit',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          id: { type: 'string' },
          webhookId: { type: 'string' },
          event: { enum: ['run.completed', 'run.failed', 'asset.updated'] },
          url: { type: 'string', format: 'uri' },
          finalState: { enum: ['queued', 'accepted', 'dead_lettered'] },
          signingAlgorithm: { const: 'hmac-sha256' },
          headers: {
            type: 'object',
            additionalProperties: false,
            required: [
              'x-insightflow-event',
              'x-insightflow-delivery',
              'x-insightflow-timestamp',
              'x-insightflow-signature',
            ],
            properties: {
              'x-insightflow-event': { type: 'string' },
              'x-insightflow-delivery': { type: 'string' },
              'x-insightflow-timestamp': { type: 'string' },
              'x-insightflow-signature': { type: 'string' },
            },
          },
          replayProtectionExpiresAt: { type: 'string', format: 'date-time' },
          attempts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['attempt', 'scheduledAt', 'result'],
              properties: {
                attempt: { type: 'integer', minimum: 1 },
                scheduledAt: { type: 'string', format: 'date-time' },
                httpStatus: { type: 'integer', minimum: 100, maximum: 599 },
                result: { enum: ['pending', 'accepted', 'retry_scheduled', 'dead_lettered'] },
              },
            },
          },
          deadLetter: {
            type: 'object',
            additionalProperties: false,
            required: ['reason', 'afterAttempts'],
            properties: {
              reason: { type: 'string' },
              afterAttempts: { type: 'integer', minimum: 1 },
            },
          },
          payloadRedacted: { const: true },
          deliversOnlyAuthorizedData: { const: true },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      QueryExecutionSummary: {
        type: 'object',
        additionalProperties: false,
        required: [
          'dialect',
          'dialectCapability',
          'sqlFingerprint',
          'cacheKey',
          'cache',
          'permissionDigest',
          'dataVersion',
          'estimatedRows',
          'estimatedScanBytes',
          'explain',
          'timeoutMs',
          'maxRows',
          'appliedGuards',
          'cancellation',
          'status',
        ],
        properties: {
          dialect: { enum: ['postgresql', 'snowflake', 'mysql', 'clickhouse', 'starrocks', 'trino', 'bigquery'] },
          dialectCapability: {
            type: 'object',
            additionalProperties: false,
            required: ['dialect', 'status', 'parameterStyle', 'explainSupported', 'cancellationSupported', 'notes'],
            properties: {
              dialect: { enum: ['postgresql', 'snowflake', 'mysql', 'clickhouse', 'starrocks', 'trino', 'bigquery'] },
              status: { enum: ['local_supported', 'plugin_declared'] },
              parameterStyle: { enum: ['numbered', 'question_mark', 'named'] },
              explainSupported: { type: 'boolean' },
              cancellationSupported: { type: 'boolean' },
              notes: { type: 'array', items: { type: 'string' } },
            },
          },
          sqlFingerprint: { type: 'string', minLength: 1, description: '原始 SQL 不出现在 PublicRunView，仅暴露稳定指纹。' },
          cacheKey: { type: 'string', minLength: 1 },
          cache: {
            type: 'object',
            additionalProperties: false,
            required: ['ttlSeconds', 'keyIncludes', 'invalidation', 'stale'],
            properties: {
              ttlSeconds: { type: 'integer', minimum: 1 },
              keyIncludes: {
                type: 'array',
                items: { enum: ['tenant', 'workspace', 'business_domain', 'mode', 'semantic_version', 'sql_fingerprint', 'permission_digest', 'data_version', 'policy_version'] },
              },
              invalidation: {
                type: 'object',
                additionalProperties: false,
                required: ['dataVersion', 'semanticVersion', 'permissionDigest', 'reasons'],
                properties: {
                  dataVersion: { type: 'string' },
                  semanticVersion: { type: 'string' },
                  permissionDigest: { type: 'string' },
                  policyVersion: { type: 'string' },
                  reasons: {
                    type: 'array',
                    items: { enum: ['data_version_changed', 'semantic_version_changed', 'permission_changed', 'policy_changed', 'ttl_expired'] },
                  },
                },
              },
              stale: { const: false },
            },
          },
          permissionDigest: { type: 'string', minLength: 1 },
          dataVersion: { type: 'string', minLength: 1 },
          estimatedRows: { type: 'integer', minimum: 0 },
          estimatedScanBytes: { type: 'integer', minimum: 0 },
          explain: {
            type: 'object',
            additionalProperties: false,
            required: ['available', 'estimatedRows', 'estimatedScanBytes', 'costUnits', 'budgetStatus', 'checkedAt', 'redacted'],
            properties: {
              available: { type: 'boolean' },
              estimatedRows: { type: 'integer', minimum: 0 },
              estimatedScanBytes: { type: 'integer', minimum: 0 },
              costUnits: { type: 'number', minimum: 0 },
              budgetStatus: { enum: ['within_budget', 'blocked'] },
              checkedAt: { type: 'string' },
              redacted: { const: true },
            },
          },
          timeoutMs: { type: 'integer', minimum: 1 },
          maxRows: { type: 'integer', minimum: 1 },
          appliedGuards: { type: 'array', items: { type: 'string' } },
          cancellation: {
            type: 'object',
            additionalProperties: false,
            required: ['token', 'propagationTargets', 'deadlineMs', 'status'],
            properties: {
              token: { type: 'string', minLength: 1 },
              propagationTargets: {
                type: 'array',
                items: { enum: ['planner', 'compiler', 'query_adapter', 'result_writer'] },
              },
              deadlineMs: { type: 'integer', minimum: 1, maximum: 3000 },
              status: { enum: ['pending', 'propagated', 'not_required'] },
              propagatedAt: { type: 'string' },
            },
          },
          status: { enum: ['executed', 'blocked', 'cancelled'] },
        },
      },
      ResultPageView: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractVersion',
          'requestId',
          'traceId',
          'runId',
          'conversationId',
          'resultId',
          'semanticVersion',
          'columns',
          'rows',
          'page',
          'completeness',
          'warnings',
          'freshnessAt',
          'permissionDigest',
          'policyVersion',
          'rawSqlExposed',
          'rawDatabaseCredentialsExposed',
          'audit',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          requestId: { type: 'string', minLength: 1 },
          traceId: { type: 'string', minLength: 1 },
          runId: { type: 'string', minLength: 1 },
          conversationId: { type: 'string', minLength: 1 },
          resultId: { type: 'string', minLength: 1 },
          semanticVersion: { type: 'string', minLength: 1 },
          columns: { type: 'array', items: { type: 'object', additionalProperties: true } },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          page: {
            type: 'object',
            additionalProperties: false,
            required: ['limit', 'hasMore', 'totalRows'],
            properties: {
              limit: { type: 'integer', minimum: 1, maximum: 500 },
              cursor: { type: 'string' },
              nextCursor: { type: 'string' },
              hasMore: { type: 'boolean' },
              totalRows: { type: 'integer', minimum: 0 },
            },
          },
          completeness: { enum: ['full', 'partial'] },
          warnings: { type: 'array', items: { type: 'string' } },
          freshnessAt: { type: 'string', minLength: 1 },
          queryExecution: { $ref: '#/components/schemas/QueryExecutionSummary' },
          permissionDigest: { type: 'string', minLength: 1 },
          policyVersion: { type: 'string', minLength: 1 },
          rawSqlExposed: { const: false },
          rawDatabaseCredentialsExposed: { const: false },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      ExportJobView: {
        type: 'object',
        additionalProperties: false,
        required: [
          'contractVersion',
          'id',
          'status',
          'source',
          'format',
          'estimatedRows',
          'estimatedBytes',
          'limits',
          'policyVersion',
          'permissionDigest',
          'watermark',
          'desensitization',
          'download',
          'delivery',
          'blockingReasons',
          'asyncReasons',
          'audit',
        ],
        properties: {
          contractVersion: { const: CONTRACT_VERSION },
          id: { type: 'string', minLength: 1 },
          status: { enum: ['completed', 'queued', 'blocked'] },
          source: { type: 'object', additionalProperties: true },
          format: { enum: ['csv', 'xlsx', 'png', 'pdf'] },
          estimatedRows: { type: 'integer', minimum: 0 },
          estimatedBytes: { type: 'integer', minimum: 0 },
          limits: {
            type: 'object',
            additionalProperties: false,
            required: ['maxRows', 'maxBytes'],
            properties: {
              maxRows: { type: 'integer', minimum: 1 },
              maxBytes: { type: 'integer', minimum: 1 },
            },
          },
          policyVersion: { type: 'string', minLength: 1 },
          permissionDigest: { type: 'string', minLength: 1 },
          watermark: {
            type: 'object',
            additionalProperties: false,
            required: ['enabled', 'text'],
            properties: {
              enabled: { type: 'boolean' },
              text: { type: 'string' },
            },
          },
          desensitization: {
            type: 'object',
            additionalProperties: false,
            required: ['required', 'rules'],
            properties: {
              required: { type: 'boolean' },
              rules: { type: 'array', items: { type: 'string' } },
            },
          },
          download: {
            type: 'object',
            additionalProperties: false,
            required: ['available'],
            properties: {
              available: { type: 'boolean' },
              expiresAt: { type: 'string' },
              signedUrlPreview: { type: 'string' },
            },
          },
          artifact: {
            type: 'object',
            additionalProperties: false,
            required: ['objectKey', 'contentType', 'fileName', 'sizeBytes', 'checksumSha256', 'watermarkApplied', 'storageClass', 'expiresAt'],
            properties: {
              objectKey: { type: 'string', minLength: 1 },
              contentType: { type: 'string', minLength: 1 },
              fileName: { type: 'string', minLength: 1 },
              sizeBytes: { type: 'integer', minimum: 1 },
              checksumSha256: { type: 'string', minLength: 1 },
              watermarkApplied: { type: 'boolean' },
              storageClass: { enum: ['standard', 'governed-temporary'] },
              expiresAt: { type: 'string' },
            },
          },
          delivery: {
            type: 'object',
            additionalProperties: false,
            required: ['mode', 'requiresAuditApproval'],
            properties: {
              mode: { enum: ['online', 'async'] },
              requiresAuditApproval: { type: 'boolean' },
              queueName: { type: 'string' },
              statusUrl: { type: 'string' },
              estimatedReadyAt: { type: 'string' },
            },
          },
          notification: {
            type: 'object',
            additionalProperties: false,
            required: ['required', 'channel', 'recipientReauthRequired', 'payloadIncludesDownloadUrl'],
            properties: {
              required: { type: 'boolean' },
              channel: { enum: ['in_app', 'email_digest'] },
              recipientReauthRequired: { type: 'boolean' },
              payloadIncludesDownloadUrl: { type: 'boolean' },
              scheduledAt: { type: 'string' },
            },
          },
          blockingReasons: { type: 'array', items: { type: 'string' } },
          asyncReasons: { type: 'array', items: { type: 'string' } },
          audit: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
    },
  },
} as const
