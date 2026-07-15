# InsightFlow ChatBI API App

`apps/api` 是当前后端应用壳，用来把本地 deterministic service、BFF router、认证上下文校验、查询 worker 和持久化配置组合成可部署边界。

当前实现不引入 Fastify 依赖，目的是先稳定应用边界和测试契约。后续迁移到 Fastify/TypeBox 时，应保留这里的配置、认证、ready check 和 router 语义。

## 当前能力

- `GET /readyz`：应用层 readiness，返回 persistence、router、auth mode 和 PostgreSQL 实际连通状态；检查中或失败时返回 503。
- `GET /healthz`、`GET /openapi.json`、`POST /v1/questions`、`GET /v1/runs/{id}`、`GET /v1/runs/{id}/events`、`POST /v1/runs/{id}/clarify`、`POST /v1/runs/{id}/cancel`，以及 `/v1/developer/*` 服务账号、API Key、Webhook delivery 和 embed token 路由：复用 `src/api` router。
- `required_header_actor`：生产/测试环境默认要求 `x-tenant-id`、`x-workspace-id`、`x-user-id`、`x-business-domain-id`、`x-semantic-version`。
- `Authorization: Bearer <api-key>`：生产/测试环境可用 API Key 验签生成 `service_account` actor，并按端点校验 scope。
- `disabled_demo_actor`：本地环境默认演示 actor，便于前端和样例验收。
- `memory` / `file` persistence mode：本地内存或 JSON 文件持久化。
- `fixture` / `postgresql` query mode：浏览器演示保持同步 fixture；PostgreSQL 模式提交问题后返回 202/querying，由带 lease/fencing 的 worker 执行真实只读查询、EXPLAIN 预算门禁、取消和结果映射。

## 运行时配置

| 配置 | 默认值 | 说明 |
|---|---|---|
| `CHATBI_API_ENV` | `local` | `local`、`test`、`staging`、`production` |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `8787` | HTTP 监听端口 |
| `CHATBI_AUTH_MODE` | local 为 demo，其他环境 required | 设置为 `required_header_actor` 启用 header actor 校验 |
| `CHATBI_PERSISTENCE_MODE` | `memory` | 设置为 `file` 使用 JSON 文件 adapter |
| `CHATBI_PERSISTENCE_FILE` | `/private/tmp/chatbi-api-runtime.json` | file persistence 路径 |
| `CHATBI_QUERY_MODE` | local/test 为 `fixture`，staging/production 为 `postgresql` | 查询执行模式 |
| `CHATBI_QUERY_CREDENTIAL_REF` | 无 | 服务端凭据引用，例如 `env:CHATBI_QUERY_DATABASE_URL`；公共配置不保存 DSN |
| `CHATBI_QUERY_DATABASE_URL` | 无 | 仅由 Node 组合根通过 credential ref 解析 |
| `CHATBI_QUERY_SSL_MODE` | `disable` | `disable`、`require` 或 `verify-full` |
| `CHATBI_QUERY_POOL_MAX` | `4` | 连接池大小；至少为 2，保证取消使用独立连接 |
| `CHATBI_QUERY_CONNECT_TIMEOUT_MS` | `5000` | 建连超时 |
| `CHATBI_QUERY_IDLE_TIMEOUT_MS` | `30000` | 空闲连接超时 |
| `CHATBI_QUERY_STATEMENT_TIMEOUT_MS` | `15000` | 单次查询硬超时上限 |
| `CHATBI_QUERY_WORKER_POLL_MS` | `250` | worker 轮询间隔 |
| `CHATBI_QUERY_LEASE_MS` | `30000` | job lease 时长 |
| `CORS_ALLOW_ORIGIN` | `*` | CORS allow-origin |

复制 `.env.example` 后可用 `npm run start:api` 启动 Node API。真实 PostgreSQL adapter 只在 `apps/api` 组合根导入；`src/query` 仅包含 browser-safe 端口和 mapper。

## 后续生产化

- 用 Fastify/TypeBox 替换当前 Node adapter。
- 将 header actor 继续收敛到 OIDC/SAML；API Key Bearer 路径已具备本地验签和 service-account actor 注入，后续补轮换、持久化和审计落库。
- 将当前内存 Run job queue 和 JSON file persistence 替换为同一事务内完成 claim、结果发布和 Run CAS 的 PostgreSQL adapter。
- 将当前一次性 SSE 序列升级为生产长连接事件流和事件保留窗口。
