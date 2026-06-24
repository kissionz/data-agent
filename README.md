# InsightFlow ChatBI / Data Agent

面向企业经营分析的自然语言数据问答工作台。当前仓库交付的是第一阶段成果：按照 PRD 与 UI 规范完成的 React 前端工作台、数据源治理、语义治理、协作资产与运营中心页面，以及可测试的 TypeScript 领域 mock 基座。

当前阶段不伪装成生产后端。SSO、真实数据源连接、生产持久化、生产 Query Gateway、审计存储、模型网关和评测流水线仍需在后续阶段接入。

## 当前已实现

- 四栏 ChatBI 工作台：全局导航、会话列表、主时间线、右侧上下文面板、底部固定追问输入。
- 运行状态闭环：待输入、理解中、查询中、已完成、需澄清、失败；部分结果作为结果完整性标记处理。
- 可信答案视图：结论、KPI、趋势图、表格、口径、筛选条件、证据、SQL 摘要、反馈入口。
- 澄清流程 mock：低置信或多义问题不执行查询，展示最多 3 个结构化候选。
- 权限安全 mock：越权问题进入安全拒绝，不泄露无权资源是否存在。
- 数据源中心：数据源健康度、连接测试反馈、元数据目录、字段分类、样本策略、质量门禁和同步记录。
- 语义中心：指标列表、详情、编辑态、公式、维度、依赖、版本历史和审批信息。
- 本地语义 Catalog：认证指标、维度、语义版本、兼容维度和 Join Graph 风险门禁。
- 协作资产中心：资产库、收藏反馈、归档状态、分享范围、订阅频率、审核人与审计事件展示。
- 运营中心：SLO/KPI、发布门禁、失败分布、回放队列、模型版本、延迟趋势。
- 响应式布局：桌面四栏；窄屏抽屉/底部面板；移动端单栏与固定输入。
- 领域与测试基座：运行状态机、会话模型、语义版本、权限拒绝与安全场景测试。
- 共享契约：`AnalysisIR v1`、`PublicRunView`、API 包络、澄清、取消、审计事件与错误对象。
- 共享契约包入口：`@insightflow/contracts` workspace 包已暴露版本、schema、错误码和 SSE helper，供前端、API 与未来 SDK 统一 import。
- 开发者接入契约：`/v1/developer` 支持服务账号、API Key、Webhook 和短期 embed token 的本地治理契约，覆盖 scope、配额、过期、撤销、签名、重放保护和不暴露明文密钥/数据库凭据。
- 本地应用服务：deterministic `submitQuestion` / `clarifyRun` / `cancelRun` / `getRun`，前端工作台已通过该服务驱动 mock 流程。
- 本地 BFF router：`/healthz`、`/openapi.json`、`POST /v1/questions`、`GET /v1/runs/{id}`、`POST /v1/runs/{id}/clarify`、`POST /v1/runs/{id}/cancel` 的可测试 HTTP 契约。
- API 应用壳：`apps/api` 提供运行时配置、`/readyz`、生产式 header actor 校验、memory/file persistence 模式和 Node adapter 组合入口。
- 身份策略服务：`/v1/identity` 支持身份上下文、可见工作空间、策略裁决和策略版本更新，服务层覆盖 RBAC/ABAC、受限导出拒绝、权限摘要、缓存 scope 和策略变更 300 秒内生效语义。
- 运行事件流：`GET /v1/runs/{id}/events` 的 SSE 契约、事件序列化、`Last-Event-ID` 续传和工作空间边界检查。
- 数据源服务：`/v1/data-sources` 支持数据源列表、元数据详情和只读连接测试，服务层覆盖可见范围过滤、credential ref、不暴露真实凭据、质量门禁与受限字段样本策略。
- 语义治理服务：`/v1/semantic` 支持指标列表、详情、提交评审和认证发布，服务层覆盖角色权限、参考 SQL 对账门禁、不可变版本、Join Graph 风险暴露和 public audit event。
- 导出分享服务：`/v1/sharing` 支持导出请求、分享引用和接收者重新鉴权，服务层覆盖导出前重新鉴权、100k 行/50MB 限制、水印计划、脱敏规则和“不复制高权限结果”。
- 评测回放服务：`/v1/evaluation` 支持黄金集发布门禁、失败回放列表和回放详情，服务层覆盖 P0 门禁阻断、阻断样本角色可见性、脱敏重放计划和不使用生产凭据规则。
- 模型运营服务：`/v1/model-ops` 支持模型路由列表、单次路由决策和灰度回滚，服务层覆盖版本化 active/candidate、超时、温度、租户覆盖、配额、降级链、发布门禁阻断和 platform_ops/security_admin 回滚权限。
- SLO 与性能预算服务：`/v1/operations/slo` 支持 SLO 报告和单次 Run 性能预算评估，服务层覆盖可用性、P95 延迟、成本、取消传播、扫描量、告警 runbook 和 allow/warn/block 决策。
- 协作资产服务：`/v1/assets` 支持资产列表、收藏、订阅和审计链路，服务层覆盖可见范围过滤、审核中不可订阅、接收者重新鉴权摘要和 public audit event。
- 本地编译执行边界：Analysis IR 经语义 Catalog / Join Graph 校验后生成只读 SQL 计划，注入租户/工作区/业务域守卫，并产出 SQL 指纹、缓存键、预算阻断和 public-safe 执行摘要。
- 错误码目录：所有 public error code 都有 HTTP 状态、默认可重试性和用户安全性标记。
- 持久化端口：conversation、run、idempotency 和 audit events 已抽象为 repository interface，并提供内存 adapter 与本地 JSON 文件 adapter。

## 技术栈

- Vite 7
- React 19
- TypeScript 5.8
- Vitest + Testing Library
- Recharts
- Tabler Icons

## 本地运行

项目使用 pnpm lockfile。若本机没有 pnpm，可先启用 Corepack：

```bash
corepack enable
```

```bash
pnpm install
pnpm dev
```

默认 Vite 地址为 `http://localhost:5173`。如果端口被占用，可使用：

```bash
pnpm dev -- --host 127.0.0.1 --port 4173
```

## 验证命令

```bash
pnpm test
pnpm build
```

构建脚本会先执行 TypeScript 项目检查，再执行 Vite 生产构建。

## 本地 API 契约

当前 API 处于本地 BFF/router 阶段，核心代码位于：

- [apps/api/src/app.ts](/Users/kissionz/Documents/data-agent/apps/api/src/app.ts)
- [apps/api/src/config.ts](/Users/kissionz/Documents/data-agent/apps/api/src/config.ts)
- [src/api/router.ts](/Users/kissionz/Documents/data-agent/src/api/router.ts)
- [src/api/openapi.ts](/Users/kissionz/Documents/data-agent/src/api/openapi.ts)
- [src/api/nodeServer.ts](/Users/kissionz/Documents/data-agent/src/api/nodeServer.ts)
- [packages/contracts/src/index.ts](/Users/kissionz/Documents/data-agent/packages/contracts/src/index.ts)
- [src/application/identityPolicy.ts](/Users/kissionz/Documents/data-agent/src/application/identityPolicy.ts)
- [src/application/dataSources.ts](/Users/kissionz/Documents/data-agent/src/application/dataSources.ts)
- [src/application/developerAccess.ts](/Users/kissionz/Documents/data-agent/src/application/developerAccess.ts)
- [src/application/semanticGovernance.ts](/Users/kissionz/Documents/data-agent/src/application/semanticGovernance.ts)
- [src/application/sharingExports.ts](/Users/kissionz/Documents/data-agent/src/application/sharingExports.ts)
- [src/application/evaluation.ts](/Users/kissionz/Documents/data-agent/src/application/evaluation.ts)
- [src/application/modelOps.ts](/Users/kissionz/Documents/data-agent/src/application/modelOps.ts)
- [src/application/slo.ts](/Users/kissionz/Documents/data-agent/src/application/slo.ts)
- [src/application/collaborationAssets.ts](/Users/kissionz/Documents/data-agent/src/application/collaborationAssets.ts)
- [src/persistence/ports.ts](/Users/kissionz/Documents/data-agent/src/persistence/ports.ts)
- [src/persistence/memory.ts](/Users/kissionz/Documents/data-agent/src/persistence/memory.ts)
- [src/persistence/file.ts](/Users/kissionz/Documents/data-agent/src/persistence/file.ts)

已覆盖的本地 HTTP 契约：

- `GET /healthz`
- `GET /openapi.json`
- `GET /v1/identity/context`
- `POST /v1/identity/policies/evaluate`
- `POST /v1/identity/policies/current`
- `POST /v1/developer/service-accounts`
- `POST /v1/developer/api-keys`
- `POST /v1/developer/api-keys/{keyId}/revoke`
- `POST /v1/developer/webhooks`
- `POST /v1/developer/webhooks/{webhookId}/test`
- `POST /v1/developer/embed-tokens`
- `POST /v1/questions`
- `GET /v1/runs/{runId}?conversation_id=...`
- `GET /v1/runs/{runId}/events?conversation_id=...`
- `POST /v1/runs/{runId}/clarify`
- `POST /v1/runs/{runId}/cancel`
- `GET /v1/data-sources`
- `GET /v1/data-sources/{dataSourceId}`
- `POST /v1/data-sources/{dataSourceId}/test-connection`
- `GET /v1/semantic/metrics`
- `GET /v1/semantic/metrics/{metricId}`
- `POST /v1/semantic/metrics/{metricId}/submit-review`
- `POST /v1/semantic/metrics/{metricId}/certify`
- `POST /v1/sharing/exports`
- `POST /v1/sharing/shares`
- `POST /v1/sharing/shares/{shareId}/reauthorize`
- `GET /v1/evaluation/gates/current`
- `GET /v1/evaluation/replays`
- `GET /v1/evaluation/replays/{runId}`
- `GET /v1/model-ops/routes`
- `POST /v1/model-ops/route`
- `POST /v1/model-ops/routes/{routeId}/rollback`
- `GET /v1/operations/slo`
- `POST /v1/operations/slo/budget-evaluations`
- `GET /v1/assets`
- `POST /v1/assets/{assetId}/favorite`
- `POST /v1/assets/{assetId}/subscription`
- `GET /v1/assets/{assetId}/audit`

本地 router 已验证状态码映射、幂等键、CORS、身份策略裁决、跨工作空间拒绝、开发者接入治理、澄清候选版本绑定、SSE 事件流、数据源安全摘要、语义评审/发布门禁、导出分享重新鉴权、评测发布阻断、回放脱敏计划、模型路由/降级/回滚、SLO 报告/性能预算决策、协作资产门禁和 OpenAPI 草案。持久化目前有内存 adapter 和本地 JSON 文件 adapter；文件 adapter 使用临时文件 + rename 做原子替换，适合本地开发和验收样例，不是生产数据库。生产阶段仍需接入 Fastify/TypeBox、真实认证上下文、长连接运行时、PostgreSQL/Redis adapter 和网关部署。

## 浏览器验收建议

当前阶段已经做过桌面与移动主流程核验；后续进入 API 阶段前，建议把这些场景固化为 Playwright：

- 桌面 1440px：四栏布局、结果 tab、澄清选择、权限拒绝、语义中心、运营中心。
- 平板 1280px / 1024px：会话列表和上下文面板抽屉。
- 移动 390px：单栏工作台、底部输入、上下文底部面板。
- 可访问性：全键盘 Tab 顺序、Esc 关闭浮层、焦点归还、`prefers-reduced-motion`、图表数据表替代。
- 浏览器：Chrome 与 Safari 至少各跑一次人工验收。

## 文档索引

- [PRD 分析与补全](/Users/kissionz/Documents/data-agent/docs/PRD_ANALYSIS.md)
- [系统架构](/Users/kissionz/Documents/data-agent/docs/ARCHITECTURE.md)
- [UI 规范](/Users/kissionz/Documents/data-agent/docs/UI_SPEC.md)
- [验收覆盖矩阵](/Users/kissionz/Documents/data-agent/docs/ACCEPTANCE_COVERAGE.md)
- [产品上下文](/Users/kissionz/Documents/data-agent/PRODUCT.md)
- [设计系统](/Users/kissionz/Documents/data-agent/DESIGN.md)

## 当前阶段边界

已完成的是“可运行、可审查、可继续开发”的产品基座，不是完整生产系统。当前 `src/application` 是本地 deterministic service，不是网络 API。生产化仍至少需要：

- Fastify/TypeBox API BFF 替换当前 Node adapter、生产 SSE 长连接、PostgreSQL/Redis 持久化、租户/组织/工作空间模型、真实 API Key 验签和 Webhook 投递队列。
- OIDC/SAML/SCIM、外部 Policy Engine、服务账号短期令牌、策略审批和审计落库。
- 真实数据源连接器、元数据扫描任务、数据质量门禁执行器、语义对象持久化与 Join Graph 编辑审批。
- Analysis IR 契约包、Planner、生产方言 Compiler、真实 Query Gateway 执行器、成本模型和取消传播。
- 真实协作资产持久化、通知发送、真实导出文件生成、水印写入、分享链接服务、缓存权限失效。
- 真实 Model Gateway、成本采集、模型调用审计、真实黄金集回归调度、线上灰度发布控制面、真实监控告警与自动回滚。
- Playwright E2E、真实压测/SLO 证明、安全与多租户隔离测试。

语义中心和运营中心的筛选、刷新、审批、回放等交互当前均为 fixture/mock 交互，不代表已连接真实审批流、监控平台或评测流水线。

## 建议下一阶段

1. 将 `@insightflow/contracts` 从当前过渡入口迁移为真正源码包，并把 `openApiDocument` 改为从 schema 自动生成。
2. 为 `src/persistence` 增加 SQLite/PostgreSQL adapter，并把审计事件单独落表；本地 JSON adapter 只作为开发替代。
3. 增加 `apps/api`，用 Fastify/TypeBox 包装当前 deterministic service、router 和 SSE 契约。
4. 将前端 service adapter 切到真实 BFF，同时保留 fixtures 作为黄金问题回归样本。
5. 补齐 Playwright E2E：标准查询、澄清、越权拒绝、部分结果、语义编辑、协作分享、运营回放。
