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
- 本地应用服务：deterministic `submitQuestion` / `clarifyRun` / `cancelRun` / `getRun`，前端工作台已通过该服务驱动 mock 流程。
- 本地 BFF router：`/healthz`、`/openapi.json`、`POST /v1/questions`、`GET /v1/runs/{id}`、`POST /v1/runs/{id}/clarify`、`POST /v1/runs/{id}/cancel` 的可测试 HTTP 契约。
- 运行事件流：`GET /v1/runs/{id}/events` 的 SSE 契约、事件序列化、`Last-Event-ID` 续传和工作空间边界检查。
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

- [src/api/router.ts](/Users/kissionz/Documents/data-agent/src/api/router.ts)
- [src/api/openapi.ts](/Users/kissionz/Documents/data-agent/src/api/openapi.ts)
- [src/api/nodeServer.ts](/Users/kissionz/Documents/data-agent/src/api/nodeServer.ts)
- [src/persistence/ports.ts](/Users/kissionz/Documents/data-agent/src/persistence/ports.ts)
- [src/persistence/memory.ts](/Users/kissionz/Documents/data-agent/src/persistence/memory.ts)
- [src/persistence/file.ts](/Users/kissionz/Documents/data-agent/src/persistence/file.ts)

已覆盖的本地 HTTP 契约：

- `GET /healthz`
- `GET /openapi.json`
- `POST /v1/questions`
- `GET /v1/runs/{runId}?conversation_id=...`
- `GET /v1/runs/{runId}/events?conversation_id=...`
- `POST /v1/runs/{runId}/clarify`
- `POST /v1/runs/{runId}/cancel`

本地 router 已验证状态码映射、幂等键、CORS、跨工作空间拒绝、澄清候选版本绑定、SSE 事件流和 OpenAPI 草案。持久化目前有内存 adapter 和本地 JSON 文件 adapter；文件 adapter 使用临时文件 + rename 做原子替换，适合本地开发和验收样例，不是生产数据库。生产阶段仍需接入 Fastify/TypeBox、真实认证上下文、长连接运行时、PostgreSQL/Redis adapter 和网关部署。

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

- Fastify/TypeBox API BFF、生产 SSE 长连接、PostgreSQL/Redis 持久化、租户/组织/工作空间模型。
- OIDC/SAML/SCIM、RBAC + ABAC、策略变更实时生效。
- 真实数据源连接器、元数据扫描任务、数据质量门禁执行器、语义对象持久化与 Join Graph 编辑审批。
- Analysis IR 契约包、Planner、生产方言 Compiler、真实 Query Gateway 执行器、成本模型和取消传播。
- 真实协作资产持久化、通知发送、导出水印、分享二次鉴权、缓存权限失效。
- Model Gateway、评测中心、黄金集回归、灰度发布与回滚。
- Playwright E2E、性能/SLO、安全与多租户隔离测试。

语义中心和运营中心的筛选、刷新、审批、回放等交互当前均为 fixture/mock 交互，不代表已连接真实审批流、监控平台或评测流水线。

## 建议下一阶段

1. 将当前 `src/contracts` 抽到 `packages/contracts`，并把 `openApiDocument` 改为从 schema 自动生成。
2. 为 `src/persistence` 增加 SQLite/PostgreSQL adapter，并把审计事件单独落表；本地 JSON adapter 只作为开发替代。
3. 增加 `apps/api`，用 Fastify/TypeBox 包装当前 deterministic service、router 和 SSE 契约。
4. 将前端 service adapter 切到真实 BFF，同时保留 fixtures 作为黄金问题回归样本。
5. 补齐 Playwright E2E：标准查询、澄清、越权拒绝、部分结果、语义编辑、协作分享、运营回放。
