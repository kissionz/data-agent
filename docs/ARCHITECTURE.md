# InsightFlow ChatBI 系统架构

> 版本：v0.1（本地演示基线）  
> 来源：`ChatBI_Production_PRD_v1.0`、InsightFlow ChatBI UI 规范  
> 原则：本地演示不伪装成生产能力；生产边界从第一天保留，但先以模块化单体交付端到端可信闭环。

## 1. 架构决策摘要

项目从空仓启动，建议先落地一个 TypeScript workspace 中的“模块化单体 + 可替换适配器”，而不是立即部署 PRD 中的全部微服务。这样能最快完成可演示切片，同时保持领域边界、接口和事件可独立拆分。

- Web：当前本地演示采用 Vite 7、React 19、TypeScript、CSS design tokens、Tabler Icons、Recharts；引入服务端渲染或嵌入式交付时，再评估 Next.js 应用壳，领域与 API 契约不随壳变化。
- API：Fastify + TypeBox/OpenAPI；运行编排使用显式状态机，长任务通过 SSE 推送。
- 持久化：生产 PostgreSQL；本地使用 SQLite（Drizzle ORM 的相同领域模型）。
- 队列与缓存：生产 Redis + BullMQ；本地使用进程内队列与 TTL Map，通过接口注入替换。
- 检索：生产 PostgreSQL `pgvector` + 全文检索/可插拔 reranker；本地使用内存语义目录、关键词/同义词打分。
- 数据查询：生产经只读 Query Gateway 连接数仓；本地仅查询固定 mock dataset 或 DuckDB 演示库。
- LLM：统一 `ModelGateway`；本地默认确定性规则规划器，可选通过环境变量启用真实模型。模型永远不持有数据源凭据。
- 契约：TypeBox/JSON Schema 为单一事实源，生成 OpenAPI 与前端类型；拒绝未知字段。
- 测试：Vitest、Testing Library、Playwright；契约与状态迁移测试优先于页面快照。

生产演进时，模块按 PRD 边界拆为 Conversation、Retrieval、Planner、Semantic、Compiler、Query Gateway、Result、Evaluation、Audit 服务；API 和事件契约保持不变。

### 1.1 当前仓库落地状态

当前代码仍是单仓 Vite/TypeScript 项目，但已经形成四层边界：

| 层 | 当前目录 | 当前能力 | 后续演进 |
|---|---|---|---|
| UI | `src/App.tsx`、`src/features/*` | 工作台、语义中心、运营中心；工作台通过本地 application service 驱动 | 切换为 API adapter，补组件测试与 E2E |
| Contracts | `src/contracts/*` | `AnalysisIR v1`、`PublicRunView`、API envelope、审计事件、错误对象、错误码目录、SSE 事件和 schema 草案 | 抽为 `packages/contracts`，使用 TypeBox 生成 OpenAPI |
| Application | `src/application/*` | deterministic `submitQuestion`、澄清、取消、Run 查询、幂等和边界检查；依赖 persistence 端口 | 接检索、Planner、Query Gateway adapter |
| Persistence | `src/persistence/*` | conversation、run、idempotency、audit events 端口、内存 adapter、本地 JSON 文件 adapter | SQLite/PostgreSQL/Redis adapter 与 migration |
| BFF Adapter | `src/api/*` | 本地 HTTP router、OpenAPI 草案、SSE events endpoint、Node server adapter 源码、CORS/状态码映射测试 | 迁移到 `apps/api` Fastify + 生产 SSE 长连接 + 认证中间件 |

本地 BFF router 支持 `/healthz`、`/openapi.json`、`POST /v1/questions`、`GET /v1/runs/{id}`、`GET /v1/runs/{id}/events`、`POST /v1/runs/{id}/clarify` 和 `POST /v1/runs/{id}/cancel`。它是生产 API 的契约基线，不是最终运行时；本地 JSON 文件 adapter 用于开发态跨进程/重启验收，生产环境仍需真实认证、数据库/缓存持久化、长连接生命周期管理、审计落库和网关部署。

## 2. 系统上下文与边界

```mermaid
flowchart LR
  U["业务用户 / 分析师"] --> W["四栏 ChatBI 工作台"]
  W -->|HTTPS + SSE| G["API Gateway / BFF"]
  G --> C["Conversation & Run Orchestrator"]
  C --> R["Retrieval"]
  C --> P["Planner"]
  P --> S["Semantic Service"]
  P --> V["Validator / Compiler"]
  V --> Q["Query Gateway"]
  Q --> D[("受治理数据源 / 本地演示库")]
  Q --> RS["Result Service"]
  RS --> C
  C -.事件.-> A["Audit / Evaluation"]
  M["Model Gateway"] --> P
  M --> RS
```

不可越过的边界：

1. 浏览器不接触数据源、模型密钥或 SQL 执行凭据。
2. Planner 只输出版本化 Analysis IR，不能直接提交 SQL。
3. Semantic Service 裁决指标、维度与 Join Graph；Compiler 只接受规范 ID。
4. Query Gateway 只执行已验证的只读 AST，并再次注入租户/权限/预算。
5. Answer 只能引用查询结果单元格或已授权知识；失败、空结果和部分结果不能被自然语言掩盖。

## 3. UI 信息架构与状态语义

### 3.1 四栏桌面结构

桌面端设计基准为 1440px，严格对齐 UI 规范：

| 区域 | 宽度 | 职责 | 数据来源 |
|---|---:|---|---|
| 全局导航 | 68px 固定 | 产品入口、工作台、语义/运营入口、个人菜单 | 静态路由 + 当前角色 |
| 会话列表 | 260px 固定 | 新建、搜索、会话历史、当前会话、最新消息/状态 | `ConversationSummary[]` |
| 主工作区 | 弹性，最小 720px | 问题、执行时间线、答案、图表、证据、底部追问输入 | `Message[]`、`RunView`、`ResultView` |
| 上下文面板 | 235px 固定 | 业务域、模式、指标口径、过滤、时间、来源、语义版本 | `ConversationState`、`Evidence` |

总宽不足 1280px 时，右侧上下文面板变为抽屉；不足 960px 时，会话列表也变为抽屉。主工作区不能低于可用阅读宽度。输入框固定在主工作区底部，答案永远与问题及执行过程位于同一时间线；首页不堆叠功能入口。

### 3.2 用户可见状态（唯一词表）

| UI 状态 | API `display_status` | 含义 | 允许操作 |
|---|---|---|---|
| 待输入 | `waiting_input` | 没有活动运行，等待用户问题 | 提交问题 |
| 理解中 | `understanding` | 检索、实体链接、计划生成或校验 | 停止 |
| 查询中 | `querying` | 编译、预算检查、数据执行或结果处理 | 停止 |
| 已完成 | `completed` | 可信结果和依据已就绪 | 追问、导出、反馈 |
| 需澄清 | `needs_clarification` | 关键歧义；未执行查询 | 选择候选、补充问题、取消 |
| 失败 | `failed` | 运行不能继续，且无可交付结果 | 重试、修改条件 |

内部状态可以更细，但必须映射到上述六种展示状态；`partial_result` 是结果完整性而非第七种任务状态，UI 在“已完成”卡片上使用警告标记并列出未完成步骤。取消后的运行回到“待输入”，历史消息保留“已取消”终止原因。

合法迁移：

```text
waiting_input -> understanding -> querying -> completed
                         |              |  -> completed(partial=true)
                         |              -> failed
                         -> needs_clarification -> understanding
                         -> failed
understanding/querying/needs_clarification -> cancelled -> waiting_input
```

规则：同一会话至多一个活动 Run；会话列表显示最近消息与最近 Run 状态；“停止”必须 3 秒内完成取消传播或明确提示仍在取消。

## 4. 模块化单体结构

建议目录：

```text
apps/
  web/                    # Vite + React 四栏工作台
  api/                    # Fastify HTTP/SSE 入口
packages/
  contracts/              # TypeBox schema、OpenAPI、事件、错误码
  domain/                 # 领域实体、状态机、策略，不依赖框架
  application/            # 用例与端口：SubmitQuestion、ClarifyRun、CancelRun
  adapters/
    persistence/          # SQLite/PostgreSQL
    planner/              # deterministic / LLM
    semantic/             # mock catalog / production catalog
    query/                # mock dataset / DuckDB / warehouse
    events/               # in-memory / Redis
  ui/                     # token、复用组件
fixtures/
  semantic/               # 演示指标、维度、同义词、Join Graph
  datasets/               # 演示结果数据，不含真实敏感数据
  scenarios/              # 问题 -> IR -> 结果/澄清/失败
```

依赖方向固定为 `web/api -> application -> domain`；adapters 实现 application 定义的端口。领域层不得依赖 Fastify、React、数据库 ORM 或模型 SDK。

## 5. 核心领域模型

所有聚合都携带 `tenantId`、`workspaceId`；外部返回的 ID 使用不透明 UUID/ULID。

### 5.1 聚合与值对象

- `Conversation`：`id`、`title`、`businessDomainId`、`mode`、`semanticVersion`、`state`、`activeRunId?`、`createdBy`、时间戳。
- `ConversationState`：当前 `metrics`、`dimensions`、`filters`、`timeRange`、`grain`、`orderLimit`、`presentation`、`assumptions`；用户显式约束带 `source=user`，系统默认不能覆盖它。
- `Message`：`role=user|assistant|system`、`content`、`runId?`、`resultRefs[]`、`createdAt`；自然语言历史不是执行事实源。
- `Run`：问题快照、模式、内部状态、展示状态、阶段、预算、IR、结果/澄清/错误、版本标签、取消令牌和审计关联。
- `Clarification`：`reasonCode`、`prompt`、1–3 个 `Candidate`、`irRevision`、过期时间；响应必须绑定候选版本。
- `SemanticMetric`：规范 ID、公式、聚合、粒度、单位、时间语义、所有者、生命周期和不可变版本。
- `SemanticDimension`：规范 ID、类型、层级、枚举/同义词、默认排序、兼容粒度。
- `JoinEdge`：左右实体、键、基数、方向、允许路径、风险标签。
- `AnalysisPlan`：通过 schema 校验的 IR 与确定性 `planFingerprint`。
- `QueryExecution`：SQL 指纹、方言、预算、权限摘要、数据版本、执行统计；对普通用户默认不返回原始 SQL。
- `ResultSet`：schema、分页 rows、统计、完整性、freshness、cell references、chart spec。
- `Evidence`：指标口径、过滤、时间、数据新鲜度、来源、语义版本、结果引用。
- `Feedback`：评价、原因标签、备注、可选正确答案，关联完整运行链路。
- `AuditEvent`：主体、代理、目的、策略/语义/模型版本、脱敏级别、trace/request ID。

### 5.2 模式隔离

`mode` 为 `trusted | exploration | expert`。MVP UI 默认且仅开放 `trusted`；即使未来开放，也禁止单个 Run 混用认证指标与临时计算。模式进入缓存键、审计、结果标签和分享授权。

## 6. Analysis IR v1 契约

IR 使用严格 JSON Schema（`additionalProperties: false`），服务端维护兼容版本白名单：

```json
{
  "schema_version": "1.0",
  "intent": "trend",
  "business_domain_id": "sales",
  "metrics": [{ "metric_id": "net_revenue", "operation": "value" }],
  "dimensions": [{ "dimension_id": "order_date", "grain": "month" }],
  "time_range": {
    "kind": "relative",
    "expression": "last_12_complete_months",
    "timezone": "Asia/Shanghai"
  },
  "filters": [{
    "dimension_id": "order_status",
    "operator": "in",
    "values": ["completed"]
  }],
  "order_limit": { "order_by": [{ "field_ref": "order_date", "direction": "asc" }], "limit": 1000 },
  "steps": [{
    "id": "step_1",
    "kind": "query",
    "depends_on": [],
    "budget": { "timeout_ms": 15000, "max_rows": 1000, "max_scan_bytes": 100000000 }
  }],
  "presentation": { "preferred_view": "line" },
  "assumptions": [{ "code": "WORKSPACE_TIMEZONE", "label": "按工作区时区统计", "value": "Asia/Shanghai" }]
}
```

关键校验顺序：Schema → 语义对象及版本 → 指标/维度粒度兼容 → Join Graph → 类型/成员值 → 权限 → 预算 → AST 白名单。任一阶段失败都不能提交数据源。

## 7. HTTP、SSE 与错误契约

所有 HTTP 响应带 `request_id`；请求头支持 `Idempotency-Key`。认证上下文来自服务端会话/令牌，客户端不得提交可信的 `tenant_id` 或权限摘要。

### 7.1 MVP API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/bootstrap` | 当前用户、工作空间、业务域、模式能力和 UI 配置 |
| `GET/POST` | `/v1/conversations` | 列表/新建会话 |
| `GET/PATCH` | `/v1/conversations/{id}` | 获取、重命名、归档会话 |
| `GET` | `/v1/conversations/{id}/messages` | 游标分页时间线 |
| `POST` | `/v1/questions` | 提交问题，返回 `202` + Run |
| `GET` | `/v1/runs/{id}` | Run 快照，用于重连与兜底轮询 |
| `GET` | `/v1/runs/{id}/events` | SSE 增量事件；支持 `Last-Event-ID` |
| `POST` | `/v1/runs/{id}/clarify` | 提交候选 ID + `ir_revision` |
| `POST` | `/v1/runs/{id}/cancel` | 幂等取消并向执行器传播 |
| `GET` | `/v1/results/{id}` | 游标分页结果，服务端复核权限 |
| `POST` | `/v1/feedback` | 点赞/点踩与原因 |
| `GET` | `/v1/semantic/metrics/{id}` | 当前用户可见的指标口径与版本 |

`POST /v1/questions` 请求：

```json
{
  "conversation_id": "01J...",
  "question": "过去 12 个完整自然月净收入趋势",
  "business_domain_id": "sales",
  "mode": "trusted",
  "stream": true
}
```

`202` 响应：

```json
{
  "request_id": "req_...",
  "run": {
    "id": "run_...",
    "conversation_id": "01J...",
    "display_status": "understanding",
    "phase": "retrieving",
    "can_cancel": true,
    "created_at": "2026-06-22T09:00:00+08:00"
  },
  "events_url": "/v1/runs/run_.../events"
}
```

### 7.2 SSE 包络

```text
id: 42
event: run.phase_changed
data: {"event_version":"1.0","run_id":"run_...","sequence":42,"occurred_at":"...","display_status":"querying","phase":"executing"}
```

事件至少包括：`run.snapshot`、`run.phase_changed`、`clarification.required`、`result.delta`、`answer.completed`、`run.completed`、`run.failed`、`run.cancelled`。客户端只按 `sequence` 应用新事件；断线后携带 `Last-Event-ID` 重连，若事件已过期则先取 Run 快照。

### 7.3 统一错误

```json
{
  "request_id": "req_...",
  "error": {
    "code": "QUERY_TOO_EXPENSIVE",
    "message": "查询范围过大，请缩短时间或增加筛选。",
    "retryable": false,
    "details": { "suggested_actions": ["shorten_time_range", "add_filter"] }
  }
}
```

公开错误码采用 PRD 词表：`AMBIGUOUS_QUERY`、`SEMANTIC_NOT_FOUND`、`PERMISSION_DENIED`、`QUERY_TOO_EXPENSIVE`、`DATA_STALE`、`PARTIAL_RESULT`、`MODEL_UNAVAILABLE`，并补充 `RUN_ALREADY_ACTIVE`、`RUN_CANCELLED`、`VALIDATION_FAILED`、`INTERNAL_ERROR`。`PERMISSION_DENIED` 不返回资源是否存在、候选值或内部策略细节。

## 8. 本地 mock 策略

本地演示必须是可重复的“场景模拟”，不是在 UI 中散落 `setTimeout`。

### 8.1 Fixtures

- 业务域：销售分析。
- 认证指标：净收入、订单数、客单价；均带单位、公式、负责人、版本和新鲜度。
- 维度：日期、区域、城市、产品线、渠道、订单状态。
- 数据：12–18 个月匿名聚合数据，包含趋势、区域排名、空结果和局部异常。
- 问题场景：成功趋势、排行榜、多轮换维度、指标歧义、成员歧义、越权、超预算、空结果、部分结果、模型不可用、取消。

### 8.2 可替换端口

```ts
interface PlannerPort { plan(input: PlanningInput, signal: AbortSignal): Promise<PlanOutcome> }
interface SemanticPort { resolve(input: ResolveInput): Promise<SemanticContext> }
interface QueryPort { execute(input: SafeQuery, signal: AbortSignal): AsyncIterable<QueryEvent> }
interface EventBus { publish(event: DomainEvent): Promise<void>; subscribe(runId: string): AsyncIterable<DomainEvent> }
```

`SCENARIO_MODE=fixture` 时，确定性规划器按规范化问题/场景 ID 返回固定 IR；Query Adapter 查询 fixtures/DuckDB 并按配置延时发出阶段事件。测试可将延时设为 0。`SCENARIO_MODE=live` 才启用模型与真实只读数据适配器，并且需要显式密钥和安全配置。

### 8.3 演示真实性规则

- UI 中所有数字必须来自 fixture 查询结果，不能硬编码在答案组件。
- 状态由后端状态机产生，刷新后可恢复；不能只保存在 React state。
- 澄清选择会生成新的 IR revision，并继续同一个 Run 链路。
- 取消使用 `AbortController` 贯穿 Planner/Query Adapter；测试断言不再产生完成事件。
- 开发调试面板可切换场景，但生产构建不可见。

## 9. 安全、治理与可观测性

本地演示也保留这些接口级约束：

- 请求上下文：`subjectId`、`tenantId`、`workspaceId`、角色、属性、策略版本；服务端派生权限摘要。
- 每次检索、计划、查询、导出继承身份上下文；日志只记录 SQL 指纹和脱敏摘要。
- 缓存键：租户 + 用户权限摘要 + 模式 + 语义版本 + SQL 指纹 + 数据版本。
- 数据内容一律视为不可信输入，不得改变系统策略或触发工具调用。
- Trace：所有运行具有 `trace_id`、`request_id`、版本标签；领域事件可重放。
- 指标：成功率、澄清率、拒答率、阶段 P95、执行准确率、引用覆盖、取消传播耗时、缓存命中和单次成本。
- 审计失败时，敏感查询和导出 fail closed；普通演示请求可记录到本地受控缓冲。

生产适配建议：OpenTelemetry + Prometheus/Grafana + 结构化日志；策略使用 OPA/Cedar 类 Policy Engine；密钥来自 KMS/Vault；下载使用短期签名 URL 和水印。

## 10. 数据存储

MVP 最小表：

- `conversations`、`conversation_states`、`messages`
- `runs`、`run_events`、`clarifications`
- `result_sets`、`result_pages`（本地可 JSON；生产对象存储 + 元数据）
- `semantic_objects`、`semantic_versions`、`join_edges`
- `feedback`、`audit_events`

关键约束：Run 状态迁移使用乐观锁 `version`；`run_events(run_id, sequence)` 唯一；一个会话只能有一个活动 Run（部分唯一索引）；语义版本不可变；结果按保留策略清理。用户分享会话时只分享定义与问题，不复用发送方的高权限结果。

## 11. 实现优先级与完成门槛

### Slice 0：契约与壳（P0）

- 建立 monorepo、契约包、状态机、四栏响应式壳和设计 token。
- 提供 `/bootstrap`、会话列表和 fixture 数据。
- 门槛：类型检查、lint、单测通过；六种展示状态只在契约中定义一次。

### Slice 1：可信问答闭环（P0，首个可演示版本）

- 提交问题 → SSE 阶段 → 固定 IR → mock 查询 → KPI/折线/表格 → 依据与追问。
- 覆盖完成、澄清、失败、取消、刷新恢复。
- 门槛：Playwright 端到端覆盖核心旅程；所有数字有 cell reference；同一会话无并发 Run。

### Slice 2：结构化多轮与证据（P0）

- 会话状态增量修改，支持筛选、同比/环比、换维度、时间与粒度。
- 上下文面板展示默认条件、过滤、口径、来源、语义版本和 freshness。
- 门槛：用户显式条件不被默认覆盖；跨业务域重新检索/鉴权。

### Slice 3：安全编译与真实本地数据（P0）

- IR JSON Schema、Semantic 校验、受限 AST、DuckDB Query Adapter、预算与分页。
- 门槛：DDL/DML、多语句、未知字段、危险 Join、越权与超预算均在执行前阻断。

### Slice 4：评测与生产适配（P0/P1）

- 黄金问题、回放、反馈、OpenTelemetry、PostgreSQL/Redis、真实模型/数据适配器。
- 门槛：PRD 第 14 章准确性/安全门禁与第 12 章 SLO 在试点环境达标。

首轮不做：任意 Text-to-SQL、专家 SQL 编辑、生产数据写入、跨源归因、完整语义管理后台、导出全格式。接口可预留，但 UI 不展示不可用入口。

## 12. 测试策略

- 领域单测：状态迁移、约束覆盖、模式隔离、IR revision、预算和取消幂等。
- 契约测试：请求/响应/SSE 事件均经 schema 验证，未知字段拒绝。
- Adapter 集成：fixture 与 DuckDB 得出相同黄金结果；权限摘要进入缓存键。
- E2E：完成、澄清后继续、失败重试、取消、断线重连、刷新恢复、响应式抽屉。
- 安全：越权、提示注入、SQL 注入、多语句、缓存污染、分享越权、候选值侧信道。
- 可访问性：键盘可操作、焦点管理、状态 `aria-live`、图表提供表格替代、颜色不是唯一状态信号。
- 视觉回归：1440px 四栏基准，以及 1280/960/390px 降级布局。

## 13. PRD 补全与明确决策

以下内容是实现所需、但 PRD 未完全定稿的补充默认值：

1. MVP 首个业务域固定为“销售分析”，只开放可信模式；后续通过配置扩展。
2. 工作区默认时区 `Asia/Shanghai`，周一为周起始；货币默认为 CNY。所有采用值必须显式展示。
3. 同一会话仅允许一个活动 Run；重复幂等键返回原 Run。
4. 会话历史游标分页默认 30 条，结果页默认 100、最大 1000 行。
5. 本地事件保留 24 小时；生产保留时间按租户政策配置，审计与业务结果分级。
6. SSE 为 MVP 流式协议；不依赖 WebSocket。耗时任务未来可迁移到队列 worker。
7. 部分结果表现为 `completed + completeness=partial`，不扩展用户可见状态词表。
8. “已取消”作为历史终止原因而非常驻任务状态，避免与设计规范六态冲突。
9. 图表规范采用受限 JSON schema，轴必须从结果字段推导，禁止截断误导轴和不存在字段。
10. SQL 可见性按角色控制：业务用户默认仅见口径/来源/过滤，分析师可在探索模式展开脱敏 SQL。

这些默认值应写入配置与契约，而不是散落在组件中；产品或数据负责人决策后可版本化替换。
