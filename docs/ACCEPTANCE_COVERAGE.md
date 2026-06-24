# PRD 验收覆盖矩阵

> 阶段：前端、领域 mock、本地契约、API app 壳、数据源/协作资产/评测回放服务与 BFF router 基座  
> 日期：2026-06-24  
> 口径：只把已经在仓库中可运行、可检查、可测试的内容标为“已覆盖”。需要真实后端、权限系统、数据源、模型或评测平台的要求标为“部分覆盖”或“未覆盖”。

## 总体结论

当前阶段已经完成 ChatBI 核心体验的可视化、数据源治理入口与服务契约、协作资产入口与服务契约、评测回放入口与门禁契约、领域状态机、共享契约、本地编译执行边界、API app 壳和本地 BFF router 基座，足以作为产品评审、前后端契约拆分和后续 API 开发的起点。完整 PRD 的生产验收尚未完成，尤其是身份权限、真实数据源、审计存储、线上评测流水线和 SLO 证明仍需后续阶段实现。

## 功能覆盖

| PRD 功能域 | 当前状态 | 已覆盖内容 | 仍需补齐 |
|---|---|---|---|
| F01 身份、租户与工作空间 | 部分覆盖 | UI 展示工作空间、业务域、用户角色与上下文；领域 mock 保留权限输入；本地 BFF 通过请求头模拟 actor 并测试跨 workspace 拒绝；`apps/api` 在非 local 环境默认要求 header actor 上下文；conversation/run 持久化端口、内存 adapter 和本地 JSON 文件 adapter 已覆盖。 | OIDC/SAML、SCIM、API key、生产租户/组织/工作空间持久化、策略变更 5 分钟内生效、缓存权限失效。 |
| F02 数据源与元数据 | 部分覆盖 | 数据源中心页面；数据源健康度、搜索/状态筛选、连接测试反馈、元数据目录、字段分类、样本策略、质量门禁和同步记录；新增 `DataSourceApplicationService` 与 `/v1/data-sources` API，覆盖 actor 可见范围过滤、只读 credential ref、不暴露真实凭据、连接测试、质量门禁状态、元数据目录和受限字段样本策略；组件测试和服务/API 测试覆盖关键规则。 | 真实数据源连接器、凭据校验、元数据扫描任务、血缘、枚举采样执行器、质量门禁执行器、Schema 变更审批和数据源持久化。 |
| F03 语义层与指标治理 | 部分覆盖 | 语义中心页面；指标列表、公式、维度、依赖、版本历史、审批状态；语义版本领域模型；本地 Semantic Catalog 覆盖认证指标、草稿指标、维度、兼容维度、语义版本边界和 Join Graph 风险门禁。 | 语义对象持久化、Join Graph 编辑审批、参考 SQL 对账、灰度发布、回滚、认证口径 100% 生产证明。 |
| F04 理解、检索与规划 | 部分覆盖 | mock 场景覆盖标准查询、澄清、失败、越权和部分结果；领域状态机限制展示状态；新增 `AnalysisIR v1` 契约和 deterministic service。 | 真实检索服务、实体链接、Planner、黄金问题准确率评测。 |
| F05 澄清与多轮会话 | 部分覆盖 | 澄清 UI 与候选选择流程；本地 application service 和 BFF router 绑定原 run、candidate id 和 candidate version；会话 active run 阻断已测试；SSE 事件流契约和 Last-Event-ID 续传已测试。 | 生产 SSE 长连接、候选失效刷新、真实多轮状态持久化。 |
| F06 编译、查询与安全执行 | 部分覆盖 | 本地确定性 Compiler 先通过 Semantic Catalog / Join Graph 校验 metric/dimension ID、版本、认证状态、粒度、兼容维度和 Join 风险，再将 Analysis IR 编译为只读 SQL AST/SQL；Query Gateway 注入租户、工作区、业务域守卫，校验只读、多语句、危险 token、预算、SQL 指纹、权限摘要和缓存键；应用服务返回 public-safe 执行摘要并写入 `compiler.plan_created` 审计事件；测试覆盖参数化、SQL 注入、只读拒绝、预算阻断和不暴露原始 SQL。 | 真实数据源执行、方言插件矩阵、EXPLAIN 成本模型、取消传播、连接池隔离、结果分页/大结果处理和生产缓存失效。 |
| F07 答案、图表与证据 | 部分覆盖 | 结论、KPI、趋势图、表格、证据、默认条件、口径、来源、新鲜度、语义版本。 | 真实结果引用映射、图表误导性校验、分页、大结果处理、答案 groundedness 自动检查。 |
| F08 导出、分享与嵌入 | 部分覆盖 | UI 上预留导出/分享动作和上下文约束展示；协作资产中心展示分享范围、导出水印/脱敏审计策略和重新鉴权提示。 | 导出重新鉴权执行、水印文件生成、大小限制、脱敏、分享接收者后端鉴权、嵌入式 SDK。 |
| F09 运营、模型与监控 | 部分覆盖 | 运营中心页面；SLO、门禁、失败分布、回放队列、模型版本、延迟趋势；`EvaluationApplicationService` 暴露当前候选版本黄金集门禁和失败回放列表，支持按状态/业务域/关键词过滤。 | 真实监控事件、模型路由、配额、降级链、灰度发布、成本与告警。 |
| F10 评测、审计与回放 | 部分覆盖 | 领域测试覆盖状态、安全、语义版本；PublicRunView 携带审计事件；审计事件可通过 persistence 端口列出，并可由本地 JSON 文件 adapter 落盘；新增评测服务与 `/v1/evaluation/*` API，覆盖黄金集 P0 门禁阻断、失败回放详情、阻断样本角色可见性、脱敏重放计划和“不使用生产凭据”规则。 | 黄金集管理、批量回归调度、生产审计存储、真实失败链路回放执行、灰度发布联动和发布阻断落库。 |
| F11 开放 API / SDK | 部分覆盖 | `apps/api` 提供 API app 壳、运行时配置、`/readyz`、header actor guard、memory/file persistence mode；本地 BFF router 覆盖 `/healthz`、`/openapi.json`、问题提交、Run 查询、SSE 事件、澄清、取消、数据源列表/详情/连接测试、评测门禁/回放、协作资产列表/收藏/订阅/审计；OpenAPI 草案已存在；错误码目录已覆盖全部 public code。 | API Key/服务账号、Fastify/TypeBox 生产 OpenAPI 生成、SDK、Webhook、配额和调用审计。 |
| F12 协作资产与订阅 | 部分覆盖 | 协作资产中心页面；资产库、搜索/状态筛选、收藏反馈、归档状态、订阅反馈、分享范围、审核人、版本快照、审计事件；新增 `CollaborationAssetApplicationService` 与 `/v1/assets` API，覆盖 actor 可见范围过滤、收藏更新、审核中/归档不可订阅、订阅更新、接收者重新鉴权摘要和 public audit event；组件测试和服务/API 测试覆盖关键规则。 | 真实资产持久化、重命名、权限分享链接、通知发送、订阅调度、协作权限策略落库和导出水印文件生成。 |

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
| 可访问性基础 | 部分覆盖 | 表单、按钮、状态文本和 reduced-motion 已处理；仍需系统性键盘与屏幕阅读器 E2E。 |

## 自动化验证覆盖

| 验证项 | 当前状态 |
|---|---|
| TypeScript 项目检查 | 已覆盖，使用 `pnpm build` 中的 `tsc -b`。 |
| 领域状态机测试 | 已覆盖，`src/test/run.test.ts`。 |
| 权限与安全拒绝测试 | 已覆盖，`src/test/security.test.ts`。 |
| 语义与模型测试 | 已覆盖，`src/test/models.test.ts` 验证语义指标、Semantic Catalog、版本边界和 Join Graph 风险门禁。 |
| 契约测试 | 已覆盖，`src/test/contracts.test.ts` 验证未知字段拒绝、IR schema 与安全护栏。 |
| 应用服务测试 | 已覆盖，`src/test/application.test.ts` 验证提交、幂等、澄清、越权、跨工作空间拒绝。 |
| 本地编译/网关测试 | 已覆盖，`src/test/query.test.ts` 验证确定性 SQL 指纹、语义 Catalog 校验、Join Graph 拒绝、权限守卫注入、参数化过滤、只读拒绝、预算阻断和 public-safe 执行摘要。 |
| 本地 BFF/API 测试 | 已覆盖，`src/test/api.test.ts` 验证健康检查、OpenAPI、HTTP 状态码、CORS、幂等、澄清和取消；`src/test/apiRuntime.test.ts` 验证 `apps/api` readiness、header actor guard 和 file persistence runtime；`src/test/dataSourceService.test.ts` 验证数据源服务与 `/v1/data-sources` API；`src/test/evaluationService.test.ts` 验证评测门禁、失败回放和 `/v1/evaluation/*` API；`src/test/collaborationService.test.ts` 验证协作资产服务与 `/v1/assets` API。 |
| SSE/错误码契约测试 | 已覆盖，`src/test/events.test.ts` 验证 public error catalog、Run 事件序列和 Last-Event-ID 过滤。 |
| 持久化端口测试 | 已覆盖，`src/test/persistence.test.ts` 验证跨 service 实例读取、幂等键、clone 防引用污染、audit list 和本地 JSON 文件恢复。 |
| 组件级 UI 测试 | 部分覆盖，`src/test/dataSources.test.tsx` 已覆盖数据源中心关键状态，`src/test/collaboration.test.tsx` 已覆盖协作资产关键状态；仍需补工作台、语义中心、运营中心组件测试。 |
| 浏览器人工验收 | 部分覆盖，当前阶段已人工核验主工作台、澄清、权限拒绝、语义中心、运营中心和移动布局。 |
| 浏览器自动 E2E | 未覆盖，建议下一阶段使用 Playwright 固化关键路径。 |
| 可访问性 E2E | 未覆盖，需要补键盘、焦点管理、屏幕阅读器和图表替代表达测试。 |
| 性能与 SLO | 未覆盖，需要真实 API、数据和监控后验证。 |

## 下一阶段验收门槛建议

1. 将 `src/contracts` 独立为共享包，并用 TypeBox/JSON Schema 生成生产 OpenAPI。
2. 将本地 JSON persistence adapter 替换为 SQLite/PostgreSQL adapter，并补 migration 与审计事件表。
3. 将当前 `apps/api` Node adapter 替换为 Fastify/TypeBox，补 OIDC/API key 中间件、生产 SSE 长连接和错误码表落地文档。
4. 每个 PRD P0 流程至少有一个可重复测试：标准查询、澄清、权限拒绝、取消、部分结果、语义发布、回放门禁。
5. 任何真实模型接入前，答案必须保留“只能引用结果集或授权知识”的测试护栏。
