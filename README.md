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
- 共享契约：`AnalysisIR v1`、`PublicRunView`、`ResultPageView`、API 包络、澄清、取消、审计事件与错误对象。
- 共享契约包：`@insightflow/contracts` workspace 包已拥有独立的 `api`、`domain`、`events`、`openapi`、`sdk` 契约源码，暴露版本、schema、错误码、公共 DTO、SSE helper、OpenAPI 草案、公共错误包络、Run/Result envelope、开发者 endpoint 请求 helper 和嵌入式 iframe 配置 helper。
- 开发者接入契约：`/v1/developer` 支持服务账号、API Key、Webhook 和短期 embed token 的本地治理契约，覆盖 scope、配额、过期、撤销、轮换宽限期、API Key 验签为服务端可信 actor、Webhook 签名/重放保护/退避重试/死信计划和不暴露明文密钥/数据库凭据。
- 本地应用服务：deterministic `submitQuestion` / `clarifyRun` / `cancelRun` / `getRun` / `getResultPage`，前端工作台已通过该服务驱动 mock 流程。
- 本地 BFF router：`/healthz`、`/openapi.json`、`POST /v1/questions`、`GET /v1/runs/{id}`、`GET /v1/results/{id}`、`POST /v1/runs/{id}/clarify`、`POST /v1/runs/{id}/cancel` 的可测试 HTTP 契约。
- API 应用壳：`apps/api` 提供运行时配置、`/readyz`、生产式 header actor 校验、memory/file persistence 模式和 Node adapter 组合入口。
- 身份策略服务：`/v1/identity` 支持身份上下文、可见工作空间、策略裁决和策略版本更新，服务层覆盖 RBAC/ABAC、受限导出拒绝、权限摘要、缓存 scope 和策略变更 300 秒内生效语义。
- 运行事件流：`GET /v1/runs/{id}/events` 的 SSE 契约、事件序列化、`Last-Event-ID` 续传和工作空间边界检查。
- 数据源服务：`/v1/data-sources` 支持数据源列表、元数据详情、只读连接测试、字段级血缘和 Schema 变更审批，服务层覆盖可见范围过滤、credential ref、不暴露真实凭据、质量门禁、受限字段样本策略、下游影响分析和 P0 认证指标变更阻断。
- 语义治理服务：`/v1/semantic` 支持指标列表、详情、提交评审和认证发布，服务层覆盖角色权限、参考 SQL 对账门禁、不可变版本、Join Graph 风险暴露和 public audit event。
- 导出分享服务：`/v1/sharing` 支持导出请求、异步大文件导出任务、分享引用和接收者重新鉴权，服务层覆盖导出前重新鉴权、100k 行/50MB 在线限制、超阈值进入受审计异步队列、水印计划、脱敏规则和“不复制高权限结果”。
- 评测回放服务：`/v1/evaluation` 支持黄金集发布门禁、失败回放列表和回放详情，服务层覆盖 P0 门禁阻断、阻断样本角色可见性、脱敏重放计划和不使用生产凭据规则。
- 模型运营服务：`/v1/model-ops` 支持模型路由列表、单次路由决策和灰度回滚，服务层覆盖版本化 active/candidate、超时、温度、租户覆盖、配额、降级链、发布门禁阻断和 platform_ops/security_admin 回滚权限。
- SLO 与性能预算服务：`/v1/operations/slo` 支持 SLO 报告和单次 Run 性能预算评估，服务层覆盖可用性、P95 延迟、成本、取消传播、扫描量、告警 runbook 和 allow/warn/block 决策。
- 查询取消契约：`QueryExecutionSummary` 暴露 public-safe 取消 token、传播目标、3 秒 deadline 和传播状态，`cancelRun` 会把已有执行摘要标记为 `cancelled` 且不暴露结果。
- 协作资产服务：`/v1/assets` 支持资产列表、收藏、重命名、订阅、通知计划和审计链路，服务层覆盖可见范围过滤、重命名权限、审核中不可订阅、接收者重新鉴权摘要、通知不携带明细行、水印要求和 public audit event。
- 本地编译执行边界：Analysis IR 经语义 Catalog / Join Graph 校验后生成只读 SQL 计划，注入租户/工作区/业务域守卫，并产出 SQL 指纹、缓存键、预算阻断和 public-safe 执行摘要。
- 错误码目录：所有 public error code 都有 HTTP 状态、默认可重试性和用户安全性标记。
- 持久化端口：conversation、run、idempotency 和 audit events 已抽象为 repository interface，并提供内存 adapter、本地 JSON 文件 adapter、SQL migration、versioned migration runner、可替换 SQL adapter 与 retention cleanup planner/executor；审计事件在 SQL adapter 中单独落表并拥有 run/scope 索引，默认留存策略覆盖问题/IR/SQL 指纹 180 天、结果摘要 30 天、原始结果 7 天、敏感样本 3 天、审计 365 天。

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
pnpm test:e2e
pnpm build
```

构建脚本会先执行 TypeScript 项目检查，再执行 Vite 生产构建。`test:e2e` 使用 Playwright 启动本地 Vite 服务，并通过本机 Google Chrome 跑桌面和移动关键路径验收。

PostgreSQL 真实查询纵向链路使用独立集成门禁，不让默认单测依赖外部数据库：

```bash
docker compose -f docker-compose.postgres.yml up -d --wait
npm run test:integration:postgres
docker compose -f docker-compose.postgres.yml down
```

该门禁覆盖真实参数绑定、租户/工作区/业务域隔离、JSON EXPLAIN 预算阻断、数据库只读角色、statement timeout 和三秒内取消传播。

`docker-compose.postgres.yml` 会先按生产顺序装载纯 control-plane 001–005，再单独装载编号 900 的集成测试数据和 `chatbi_reader` 角色。生产部署只运行 `npm run migrate:control-plane`；`scripts/postgres/init.sql` 含本地 fixture、测试角色和测试数据库授权，禁止作为生产迁移执行。

## 本地 API 契约

当前 API 处于本地 BFF/router 阶段，核心代码位于：

- [apps/api/src/app.ts](/Users/kissionz/Documents/data-agent/apps/api/src/app.ts)
- [apps/api/src/config.ts](/Users/kissionz/Documents/data-agent/apps/api/src/config.ts)
- [src/api/router.ts](/Users/kissionz/Documents/data-agent/src/api/router.ts)
- [src/api/nodeServer.ts](/Users/kissionz/Documents/data-agent/src/api/nodeServer.ts)
- [packages/contracts/src/index.ts](/Users/kissionz/Documents/data-agent/packages/contracts/src/index.ts)
- [packages/contracts/src/openapi.ts](/Users/kissionz/Documents/data-agent/packages/contracts/src/openapi.ts)
- [src/application/identityPolicy.ts](/Users/kissionz/Documents/data-agent/src/application/identityPolicy.ts)
- [src/application/dataSources.ts](/Users/kissionz/Documents/data-agent/src/application/dataSources.ts)
- [src/application/developerAccess.ts](/Users/kissionz/Documents/data-agent/src/application/developerAccess.ts)
- [src/application/webhookDispatcher.ts](/Users/kissionz/Documents/data-agent/src/application/webhookDispatcher.ts)
- [src/application/semanticGovernance.ts](/Users/kissionz/Documents/data-agent/src/application/semanticGovernance.ts)
- [src/application/sharingExports.ts](/Users/kissionz/Documents/data-agent/src/application/sharingExports.ts)
- [src/application/evaluation.ts](/Users/kissionz/Documents/data-agent/src/application/evaluation.ts)
- [src/application/modelOps.ts](/Users/kissionz/Documents/data-agent/src/application/modelOps.ts)
- [src/application/slo.ts](/Users/kissionz/Documents/data-agent/src/application/slo.ts)
- [src/application/collaborationAssets.ts](/Users/kissionz/Documents/data-agent/src/application/collaborationAssets.ts)
- [src/persistence/ports.ts](/Users/kissionz/Documents/data-agent/src/persistence/ports.ts)
- [src/persistence/memory.ts](/Users/kissionz/Documents/data-agent/src/persistence/memory.ts)
- [src/persistence/file.ts](/Users/kissionz/Documents/data-agent/src/persistence/file.ts)
- [src/persistence/retention.ts](/Users/kissionz/Documents/data-agent/src/persistence/retention.ts)

已覆盖的本地 HTTP 契约：

- `GET /healthz`
- `GET /openapi.json`
- `GET /v1/identity/context`
- `POST /v1/identity/policies/evaluate`
- `POST /v1/identity/policies/current`
- `POST /v1/developer/service-accounts`
- `POST /v1/developer/api-keys`
- `POST /v1/developer/api-keys/{keyId}/revoke`
- `POST /v1/developer/api-keys/{keyId}/rotate`
- `POST /v1/developer/webhooks`
- `POST /v1/developer/webhooks/{webhookId}/test`
- `POST /v1/developer/webhooks/{webhookId}/deliveries`
- `POST /v1/developer/embed-tokens`
- `POST /v1/questions`
- `GET /v1/runs/{runId}?conversation_id=...`
- `GET /v1/results/{runId}?conversation_id=...&limit=...&cursor=...`
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
- `GET /v1/sharing/exports/{exportId}`
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
- `POST /v1/assets/{assetId}/rename`
- `POST /v1/assets/{assetId}/subscription`
- `POST /v1/assets/{assetId}/notification-plan`
- `GET /v1/assets/{assetId}/audit`

本地 router 已验证状态码映射、幂等键、CORS、身份策略裁决、跨工作空间拒绝、结果 cursor 分页、开发者接入治理、澄清候选版本绑定、SSE 事件流、数据源安全摘要、语义评审/发布门禁、导出分享重新鉴权、异步大文件导出任务、评测发布阻断、回放脱敏计划、模型路由/降级/回滚、SLO 报告/性能预算决策、协作资产门禁和由 `@insightflow/contracts/openapi` 导出的 OpenAPI 草案；OpenAPI 已包含公共错误包络与 Run/Result 响应 envelope。持久化目前有内存 adapter、本地 JSON 文件 adapter、SQL migration、versioned migration runner、retention cleanup executor 与可替换 SQL adapter；文件 adapter 使用临时文件 + rename 做原子替换，SQL adapter 将 conversation、run、idempotency 和 audit events 拆表，适合作为 SQLite/PostgreSQL driver 接入点。生产阶段仍需接入 Fastify/TypeBox、真实认证上下文、长连接运行时、具体 PostgreSQL/Redis driver 和网关部署。

## 浏览器验收建议

当前阶段已经用 Playwright 固化了桌面与移动关键路径，见 [tests/e2e](/Users/kissionz/Documents/data-agent/tests/e2e)：

- 桌面：标准查询结果、结果 tab、表格替代、口径证据、澄清选择、权限拒绝、运营回放详情。
- 工作台运行闭环：运行中停止、部分结果显式提示、刷新后恢复上次分析结果。
- 导出：CSV 下载文件经过本地导出治理服务重新鉴权，并在文件中写入水印、策略版本、权限摘要、脱敏规则和审计事件。
- 治理：语义指标评审/认证、数据源降级质量门禁、受限字段样本策略、协作资产重新鉴权、水印策略和审核中不可订阅。
- 移动：会话列表抽屉和分析上下文面板可达。
- 可访问性：全键盘 Tab 顺序、Esc 关闭浮层、焦点归还、`prefers-reduced-motion`、图表数据表替代。
- 后续仍建议补 Safari/WebKit、真实 XLSX/PDF/PNG 文件生成和异步大文件导出的浏览器轮询路径。

## 文档索引

- [PRD 分析与补全](/Users/kissionz/Documents/data-agent/docs/PRD_ANALYSIS.md)
- [系统架构](/Users/kissionz/Documents/data-agent/docs/ARCHITECTURE.md)
- [UI 规范](/Users/kissionz/Documents/data-agent/docs/UI_SPEC.md)
- [验收覆盖矩阵](/Users/kissionz/Documents/data-agent/docs/ACCEPTANCE_COVERAGE.md)
- [产品上下文](/Users/kissionz/Documents/data-agent/PRODUCT.md)
- [设计系统](/Users/kissionz/Documents/data-agent/DESIGN.md)

## 当前阶段边界

已完成的是“可运行、可审查、可继续开发”的产品基座，不是完整生产系统。当前 `src/application` 是本地 deterministic service，不是网络 API。生产化仍至少需要：

- Fastify/TypeBox API BFF 替换当前 Node adapter、生产 SSE 长连接、具体 PostgreSQL/Redis driver、租户/组织/工作空间模型、OIDC/SAML 与 API Key 轮换/存储加固、真实 Webhook 队列/HTTP client adapter；当前仅有可替换端口与本地 deterministic dispatcher。
- OIDC/SAML/SCIM、外部 Policy Engine、服务账号短期令牌、策略审批和审计落库。
- 真实数据源连接器、元数据扫描任务、数据质量门禁执行器、语义对象持久化与 Join Graph 编辑审批。
- Analysis IR 契约包、Planner、生产方言 Compiler、真实 Query Gateway 执行器、成本模型和取消传播。
- 真实协作资产持久化、通知发送、XLSX/PDF/PNG 生成、异步导出 worker/对象存储、生产水印写入、分享链接服务、缓存权限失效。
- 真实 Model Gateway、成本采集、模型调用审计、真实黄金集回归调度、线上灰度发布控制面、真实监控告警与自动回滚。
- 真实压测/SLO 证明、安全与多租户隔离测试；Playwright 仍需扩展到 WebKit/Safari、XLSX/PDF/PNG 和异步大文件导出轮询。

语义中心和运营中心的筛选、刷新、审批、回放等交互当前均为 fixture/mock 交互，不代表已连接真实审批流、监控平台或评测流水线。

## 建议下一阶段

1. 将 `@insightflow/contracts/openapi` 从当前草案升级为 schema 生成产物，并把当前 `@insightflow/contracts/sdk` endpoint helper 手写基线升级为代码生成/发布流程。
2. 将 `src/persistence/sql.ts` 接入具体 SQLite/PostgreSQL driver，补连接池配置、迁移执行 CLI 和生产审计查询 API；本地 JSON adapter 只作为开发替代。
3. 增加 `apps/api`，用 Fastify/TypeBox 包装当前 deterministic service、router 和 SSE 契约。
4. 将前端 service adapter 切到真实 BFF，同时保留 fixtures 作为黄金问题回归样本。
5. 扩展 Playwright E2E：WebKit/Safari、XLSX/PDF/PNG 和异步大文件导出验收。
