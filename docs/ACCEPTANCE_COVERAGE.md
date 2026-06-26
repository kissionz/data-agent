# PRD 验收覆盖矩阵

> 阶段：前端、领域 mock、本地契约、API app 壳、身份策略/数据源/语义/导出分享/协作资产/评测回放/模型运营/SLO 预算/开发者接入服务与 BFF router 基座  
> 日期：2026-06-24  
> 口径：只把已经在仓库中可运行、可检查、可测试的内容标为“已覆盖”。需要真实后端、权限系统、数据源、模型或评测平台的要求标为“部分覆盖”或“未覆盖”。

## 总体结论

当前阶段已经完成 ChatBI 核心体验的可视化、身份/工作空间/策略服务契约、数据源治理入口与服务契约、语义治理入口与服务契约、导出分享治理契约、协作资产入口与服务契约、评测回放入口与门禁契约、模型运营路由契约、SLO 报告与性能预算契约、开发者接入治理契约、领域状态机、共享契约包源码、本地编译执行边界、API app 壳和本地 BFF router 基座，足以作为产品评审、前后端契约拆分和后续 API 开发的起点。完整 PRD 的生产验收尚未完成，尤其是真实 OIDC/SAML/SCIM、真实数据源、审计存储、线上评测流水线、真实模型网关和真实 SLO 证明仍需后续阶段实现。

## 功能覆盖

| PRD 功能域 | 当前状态 | 已覆盖内容 | 仍需补齐 |
|---|---|---|---|
| F01 身份、租户与工作空间 | 部分覆盖 | UI 展示工作空间、业务域、用户角色与上下文；领域 mock 保留权限输入；本地 BFF 通过请求头模拟 actor 并测试跨 workspace 拒绝；`apps/api` 在非 local 环境默认要求 header actor 上下文；新增 `IdentityPolicyApplicationService` 与 `/v1/identity/*` API，覆盖身份上下文、可见工作空间、RBAC/ABAC 策略裁决、受限导出拒绝、策略版本、权限摘要、缓存 scope 和策略更新后 300 秒内生效/旧缓存失效；conversation/run 持久化端口、内存 adapter、本地 JSON 文件 adapter、SQL migration 与可替换 SQL adapter 已覆盖。 | 真实 OIDC/SAML、SCIM、API key/短期服务账号令牌、生产租户/组织/工作空间持久化、外部 Policy Engine、策略审批和具体数据库 driver 接入。 |
| F02 数据源与元数据 | 部分覆盖 | 数据源中心页面；数据源健康度、搜索/状态筛选、连接测试反馈、元数据目录、字段分类、样本策略、质量门禁和同步记录；新增 `DataSourceApplicationService` 与 `/v1/data-sources` API，覆盖 actor 可见范围过滤、只读 credential ref、不暴露真实凭据、连接测试、质量门禁状态、元数据目录和受限字段样本策略；组件测试和服务/API 测试覆盖关键规则。 | 真实数据源连接器、凭据校验、元数据扫描任务、血缘、枚举采样执行器、质量门禁执行器、Schema 变更审批和数据源持久化。 |
| F03 语义层与指标治理 | 部分覆盖 | 语义中心页面；指标列表、公式、维度、依赖、版本历史、审批状态；语义版本领域模型；本地 Semantic Catalog 覆盖认证指标、草稿指标、维度、兼容维度、语义版本边界和 Join Graph 风险门禁；新增 `SemanticGovernanceApplicationService` 与 `/v1/semantic/metrics` API，覆盖指标列表/详情、提交评审、认证发布、参考 SQL 对账门禁、角色权限、不可变版本、Join Graph 风险暴露和 public audit event。 | 真实语义对象持久化、Join Graph 编辑审批、参考 SQL 自动对账执行器、灰度发布、回滚和认证口径 100% 生产证明。 |
| F04 理解、检索与规划 | 部分覆盖 | mock 场景覆盖标准查询、澄清、失败、越权和部分结果；领域状态机限制展示状态；新增 `AnalysisIR v1` 契约和 deterministic service。 | 真实检索服务、实体链接、Planner、黄金问题准确率评测。 |
| F05 澄清与多轮会话 | 部分覆盖 | 澄清 UI 与候选选择流程；本地 application service 和 BFF router 绑定原 run、candidate id 和 candidate version；会话 active run 阻断已测试；SSE 事件流契约和 Last-Event-ID 续传已测试。 | 生产 SSE 长连接、候选失效刷新、真实多轮状态持久化。 |
| F06 编译、查询与安全执行 | 部分覆盖 | 本地确定性 Compiler 先通过 Semantic Catalog / Join Graph 校验 metric/dimension ID、版本、认证状态、粒度、兼容维度和 Join 风险，再将 Analysis IR 编译为只读 SQL AST/SQL；Query Gateway 注入租户、工作区、业务域守卫，校验只读、多语句、危险 token、预算、SQL 指纹、权限摘要和缓存键；应用服务返回 public-safe 执行摘要并写入 `compiler.plan_created` 审计事件；`QueryExecutionSummary` 已包含取消令牌、planner/compiler/query_adapter/result_writer 传播目标、≤3s deadline 和 `pending/propagated` 状态，`cancelRun` 会把已有执行摘要标记为 `cancelled` 且不暴露结果；`getResultPage` / `/v1/results/{runId}` 已覆盖 cursor 分页、1-500 page size guard、权限复核、跨工作区拒绝、不暴露原始 SQL/数据库凭据和 OpenAPI `ResultPageView` 契约；测试覆盖参数化、SQL 注入、只读拒绝、预算阻断、取消传播摘要、分页和不暴露原始 SQL。 | 真实数据源执行、方言插件矩阵、EXPLAIN 成本模型、真实 AbortController/数据库连接取消、连接池隔离、生产对象存储/缓存结果页和生产缓存失效。 |
| F07 答案、图表与证据 | 部分覆盖 | 结论、KPI、趋势图、表格、证据、默认条件、口径、来源、新鲜度、语义版本；结果页契约返回列定义、当前页行、总行数、`nextCursor`、`hasMore`、完整性状态和 freshness，支持 UI 表格大结果逐页读取；领域层 `validateResultGrounding` 会在 completed run 前自动校验 deterministic fact 的引用结果、行、列存在且无 transform 的事实值必须与至少一个引用单元格一致，并返回趋势/分组/空结果的图表安全建议；`RunResult.chartSpec` 已表达 validated chart spec，领域层校验轴字段存在、折线图 x 轴为日期、y 轴为数值，工作台图表只消费 chartSpec + result rows，不再猜测数据语义。 | 真实查询结果到引用协议的生产映射、生产级图表误导性校验 schema/worker、真实大结果后端分页和 derived/transform fact 的可审计计算链。 |
| F08 导出、分享与嵌入 | 部分覆盖 | UI 上预留导出/分享动作和上下文约束展示；工作台 CSV 下载接入本地导出治理服务，文件写入水印、策略版本、权限摘要、脱敏规则和审计事件；协作资产中心展示分享范围、导出水印/脱敏审计策略和重新鉴权提示；新增 `SharingExportApplicationService` 与 `/v1/sharing/*` API，覆盖导出前重新鉴权、100k 行/50MB 在线限制、受限分类阻断、水印计划、脱敏规则、短期下载链接预览、超阈值导出进入受审计异步队列、`GET /v1/sharing/exports/{id}` 状态查询、分享只保存引用不复制结果、接收者重新鉴权和 public audit event。 | XLSX/PDF/PNG 真实文件生成、异步导出 worker/对象存储、生产水印写入、嵌入式 SDK、短期 embed token 和通知。 |
| F09 运营、模型与监控 | 部分覆盖 | 运营中心页面；SLO、门禁、失败分布、回放队列、模型版本、延迟趋势；`EvaluationApplicationService` 暴露当前候选版本黄金集门禁和失败回放列表，支持按状态/业务域/关键词过滤；新增 `ModelOpsApplicationService` 与 `/v1/model-ops/*` API，覆盖模型能力路由、active/candidate 版本、超时、温度、租户覆盖、配额检查、供应商不可用/配额不足/策略阻断降级链、灰度候选选择、发布门禁阻断和运维/安全管理员回滚；新增 `SloApplicationService` 与 `/v1/operations/slo*` API，覆盖 SLO 报告、P95 延迟、成本、取消传播、扫描量预算、错误预算、告警 runbook、public audit 和 allow/warn/block 性能预算决策。 | 真实监控事件、真实 Model Gateway 调用、成本采集、调用审计落库、自动回滚阈值执行、告警投递、真实压测证明与按租户/业务域/模型版本的线上指标下钻。 |
| F10 评测、审计与回放 | 部分覆盖 | 领域测试覆盖状态、安全、语义版本；PublicRunView 携带审计事件；审计事件可通过 persistence 端口列出，可由本地 JSON 文件 adapter 落盘，并在 SQL adapter 中单独落入 `chatbi_audit_events` 表，且 migration 包含 run/scope 审计查询索引；retention cleanup planner/executor 已覆盖租户/工作区级默认留存：问题/IR/SQL 指纹 180 天、结果摘要 30 天、原始结果 7 天、敏感样本 3 天、审计 365 天，并执行 tenant/workspace scoped SQL 清理语句；新增评测服务与 `/v1/evaluation/*` API，覆盖黄金集 P0 门禁阻断、失败回放详情、阻断样本角色可见性、脱敏重放计划和“不使用生产凭据”规则。 | 黄金集管理、批量回归调度、真实审计数据库 driver、真实失败链路回放执行、灰度发布联动、发布阻断落库和生产清理调度。 |
| F11 开放 API / SDK | 部分覆盖 | `apps/api` 提供 API app 壳、运行时配置、`/readyz`、header actor guard、Bearer API Key 验签注入 service-account actor、memory/file persistence mode；`@insightflow/contracts` workspace 包已拥有独立 `api`、`domain`、`events`、`openapi`、`sdk` 源码与子路径导出，应用可通过包名消费共享契约、OpenAPI 草案、endpoint scope 映射、Bearer 请求构造 helper、typed endpoint 请求 helper、embed iframe 配置/snippet helper 和数据库凭据扫描护栏，`src/contracts`/`src/api/openapi.ts` 仅保留兼容层；SDK helper 已覆盖问题提交、Run 读取、SSE、结果分页、导出创建、导出状态查询，`exports.status` 使用独立 `exports:read` 最小权限 scope；OpenAPI 已包含 `PublicApiError`、`ErrorEnvelope`、通用 `ApiEnvelope`、`PublicRunEnvelope`、`ResultPageEnvelope` 和关键 Run/Result/Question 路径的统一 JSON/error response 引用；新增 `DeveloperAccessApplicationService` 与 `/v1/developer/*` API，覆盖服务账号、API Key 签发/撤销/轮换/验签、scope、配额递增、过期、轮换宽限期、workspace/domain 边界、服务端可信 actor 生成、密钥 hash/脱敏预览、Webhook HTTPS/HMAC 签名/重放保护/完整退避计划/重试/死信计划、Webhook delivery BFF 路由与 OpenAPI schema、Webhook delivery queue/http client 端口与本地 dispatcher、短期 embed token 和“组件不能接触数据库凭据”；本地 BFF router 覆盖 `/healthz`、`/openapi.json`、身份上下文/策略裁决、开发者接入治理、问题提交、Run 查询、结果分页、SSE 事件、澄清、取消、数据源列表/详情/连接测试、语义指标列表/评审/认证、导出/分享治理、评测门禁/回放、模型运营路由/决策/回滚、SLO 报告/性能预算评估、协作资产列表/收藏/订阅/审计；错误码目录已覆盖全部 public code。 | 服务账号令牌轮换任务、Fastify/TypeBox 生产 OpenAPI 生成、SDK 代码生成与包发布、真实 Webhook 队列/HTTP client adapter、调用审计落库、API Key 生产级存储加固；OpenAPI 仍需从 schema 生成产物升级为生产级规范，并继续补齐全部业务 DTO/事件 payload schema。 |
| F12 协作资产与订阅 | 部分覆盖 | 协作资产中心页面；资产库、搜索/状态筛选、收藏反馈、归档状态、订阅反馈、分享范围、审核人、版本快照、审计事件；新增 `CollaborationAssetApplicationService` 与 `/v1/assets` API，覆盖 actor 可见范围过滤、收藏更新、审核中/归档不可订阅、订阅更新、接收者重新鉴权摘要和 public audit event；短期 embed token 已通过开发者接入服务覆盖嵌入式读取边界；组件测试和服务/API 测试覆盖关键规则。 | 真实资产持久化、重命名、权限分享链接、通知发送、订阅调度、协作权限策略落库、真实嵌入式 SDK 包和导出水印文件生成。 |

## UI 验收覆盖

| 项目 | 当前状态 | 证据 |
|---|---|---|
| 桌面四栏布局 | 已覆盖 | `src/App.tsx` 与 `src/styles.css` 实现 68px / 260px / main / 235px 布局。 |
| 固定底部输入 | 已覆盖 | 工作台主区固定 composer，移动端保持底部可用。 |
| 状态无歧义 | 已覆盖 | 领域状态与 UI 标签只使用六种展示状态；部分结果不作为第七状态。 |
| 约束可见 | 已覆盖 | 结果和右侧上下文显示业务域、时间、过滤、指标、来源、语义版本。 |
| 澄清候选 | 已覆盖 | 澄清卡片展示候选口径和选择动作。 |
| 权限拒绝 | 已覆盖 | 越权场景返回安全拒绝，不展示候选值或无权资源名称。 |
| 图表替代表格 | 已覆盖 | 结果支持图表、表格、证据三种 tab。 |
| 响应式 | 已覆盖 | CSS 覆盖桌面、平板抽屉、移动单栏与底部面板。 |
| 可访问性基础 | 部分覆盖 | 表单、按钮、状态文本、图表替代表格、tablist、dialog、焦点可见样式和 reduced-motion 已处理；`src/test/accessibility.test.tsx` 已覆盖关键导航、键盘提交、焦点可达、状态非颜色依赖、图表表格替代和命名 dialog。仍需真实浏览器屏幕阅读器与跨断点键盘 E2E。 |

## 自动化验证覆盖

| 验证项 | 当前状态 |
|---|---|
| TypeScript 项目检查 | 已覆盖，使用 `pnpm build` 中的 `tsc -b`。 |
| 领域状态机测试 | 已覆盖，`src/test/run.test.ts`。 |
| 权限与安全拒绝测试 | 已覆盖，`src/test/security.test.ts`。 |
| 语义与模型测试 | 已覆盖，`src/test/models.test.ts` 验证语义指标、Semantic Catalog、版本边界和 Join Graph 风险门禁。 |
| 契约测试 | 已覆盖，`src/test/contracts.test.ts` 验证未知字段拒绝、IR schema 与安全护栏；`src/test/contractsPackage.test.ts` 验证 `@insightflow/contracts` 包入口和 `api`/`domain`/`events`/`openapi`/`sdk` 子路径导出版本、schema、错误码、公共状态词表、SSE helper、Bearer security scheme、Webhook delivery schema、公共错误包络 schema、Run/Result envelope schema、SDK endpoint helper、数据库凭据扫描护栏和 OpenAPI 路径。 |
| 应用服务测试 | 已覆盖，`src/test/application.test.ts` 验证提交、幂等、澄清、越权、跨工作空间拒绝。 |
| 本地编译/网关测试 | 已覆盖，`src/test/query.test.ts` 验证确定性 SQL 指纹、语义 Catalog 校验、Join Graph 拒绝、权限守卫注入、参数化过滤、只读拒绝、预算阻断和 public-safe 执行摘要。 |
| 本地 BFF/API 测试 | 已覆盖，`src/test/api.test.ts` 验证健康检查、OpenAPI、HTTP 状态码、CORS、幂等、澄清和取消；`src/test/apiRuntime.test.ts` 验证 `apps/api` readiness、header actor guard、Bearer API Key auth、scope 拒绝和 file persistence runtime；`src/test/identityPolicyService.test.ts` 验证身份策略服务与 `/v1/identity/*` API；`src/test/developerAccessService.test.ts` 验证服务账号、API Key 签发/撤销/轮换/验签、轮换宽限期、scope、配额、边界、Webhook 签名投递计划/完整 queued 退避计划/dispatcher 重试/死信/不泄漏 payload、embed token 和 `/v1/developer/*` API；`src/test/dataSourceService.test.ts` 验证数据源服务与 `/v1/data-sources` API；`src/test/semanticGovernanceService.test.ts` 验证语义治理服务与 `/v1/semantic/*` API；`src/test/sharingExportService.test.ts` 验证导出分享服务与 `/v1/sharing/*` API；`src/test/evaluationService.test.ts` 验证评测门禁、失败回放和 `/v1/evaluation/*` API；`src/test/modelOpsService.test.ts` 验证模型运营路由、配额、降级、门禁、回滚和 `/v1/model-ops/*` API；`src/test/sloService.test.ts` 验证 SLO 报告、告警 runbook、性能预算 allow/warn/block 和 `/v1/operations/slo*` API；`src/test/collaborationService.test.ts` 验证协作资产服务与 `/v1/assets` API。 |
| SSE/错误码契约测试 | 已覆盖，`src/test/events.test.ts` 验证 public error catalog、Run 事件序列和 Last-Event-ID 过滤。 |
| 持久化端口测试 | 已覆盖，`src/test/persistence.test.ts` 验证跨 service 实例读取、幂等键、clone 防引用污染、audit list、本地 JSON 文件恢复、SQL migration、versioned migration runner、SQL adapter 恢复、审计事件单独落表、审计 scope 索引、retention 默认天数、敏感样本短留存、审计长留存、tenant/workspace scoped 清理 SQL 和 cleanup executor。 |
| 组件级 UI 测试 | 已覆盖主要 P0/P1 页面，`src/test/workbench.test.tsx` 覆盖工作台默认结果、约束可见、表格替代、澄清和权限安全失败；`src/test/semanticGovernance.test.tsx` 覆盖语义中心指标定义、筛选、编辑和审批；`src/test/operationsCenter.test.tsx` 覆盖运营中心 SLO、发布门禁、模型版本、失败分布、回放详情和刷新反馈；`src/test/dataSources.test.tsx` 覆盖数据源中心关键状态；`src/test/collaboration.test.tsx` 覆盖协作资产关键状态。 |
| 浏览器人工验收 | 部分覆盖，当前阶段已人工核验主工作台、澄清、权限拒绝、语义中心、运营中心和移动布局。 |
| 浏览器自动 E2E | 部分覆盖，`tests/e2e/prd-acceptance.desktop.spec.ts` 和 `tests/e2e/prd-acceptance.mobile.spec.ts` 使用 Playwright + 本机 Chrome 覆盖标准查询结果、表格替代、口径证据、CSV 文件下载与水印/策略/审计元数据、澄清、权限拒绝、运行中取消、部分结果显式提示、刷新后恢复上次分析结果、语义指标评审/认证、数据源降级质量门禁、受限字段样本策略、协作资产重新鉴权/水印/订阅阻断、运营回放详情和移动端会话/上下文面板；仍需扩展 WebKit/Safari、真实 XLSX/PDF/PNG 文件和异步大文件导出轮询路径。 |
| 可访问性 E2E | 部分覆盖，`src/test/accessibility.test.tsx` 在 jsdom 中覆盖键盘提交、焦点、ARIA 角色、命名 dialog、tablist、图表替代表格和状态文本；Playwright 已覆盖命名按钮/对话框/移动面板可达，仍需屏幕阅读器级真实浏览器 E2E。 |
| 性能与 SLO | 部分覆盖，`SloApplicationService` 与 `/v1/operations/slo*` 已覆盖本地 SLO 报告、P95 延迟、单次成本、取消传播、扫描量预算、告警 runbook 和预算决策测试；仍需真实 API 流量、数据源执行指标、监控事件、压测和告警投递证明。 |

## 下一阶段验收门槛建议

1. 将 `@insightflow/contracts/openapi` 从当前草案升级为 schema 生成产物，并把 `@insightflow/contracts/sdk` endpoint helper 手写基线升级为 SDK 代码生成/发布流程。
2. 将 SQL persistence 端口接入具体 SQLite/PostgreSQL driver，并补连接池配置、迁移执行 CLI、生产审计查询 API 和 retention cleanup 调度器。
3. 将当前 `apps/api` Node adapter 替换为 Fastify/TypeBox，补 OIDC/API key 中间件、生产 SSE 长连接和错误码表落地文档。
4. 继续扩展可重复浏览器测试：WebKit/Safari、真实 XLSX/PDF/PNG 文件生成和异步大文件导出轮询。
5. 任何真实模型接入前，答案必须保留“只能引用结果集或授权知识”的测试护栏。
