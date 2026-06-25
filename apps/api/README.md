# InsightFlow ChatBI API App

`apps/api` 是当前后端应用壳，用来把本地 deterministic service、BFF router、认证上下文校验和持久化配置组合成可部署边界。

当前实现不引入 Fastify 依赖，目的是先稳定应用边界和测试契约。后续迁移到 Fastify/TypeBox 时，应保留这里的配置、认证、ready check 和 router 语义。

## 当前能力

- `GET /readyz`：应用层 readiness，返回 persistence、router 和 auth mode。
- `GET /healthz`、`GET /openapi.json`、`POST /v1/questions`、`GET /v1/runs/{id}`、`GET /v1/runs/{id}/events`、`POST /v1/runs/{id}/clarify`、`POST /v1/runs/{id}/cancel`：复用 `src/api` router。
- `required_header_actor`：生产/测试环境默认要求 `x-tenant-id`、`x-workspace-id`、`x-user-id`、`x-business-domain-id`、`x-semantic-version`。
- `Authorization: Bearer <api-key>`：生产/测试环境可用 API Key 验签生成 `service_account` actor，并按端点校验 scope。
- `disabled_demo_actor`：本地环境默认演示 actor，便于前端和样例验收。
- `memory` / `file` persistence mode：本地内存或 JSON 文件持久化。

## 运行时配置

| 配置 | 默认值 | 说明 |
|---|---|---|
| `CHATBI_API_ENV` | `local` | `local`、`test`、`staging`、`production` |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `8787` | HTTP 监听端口 |
| `CHATBI_AUTH_MODE` | local 为 demo，其他环境 required | 设置为 `required_header_actor` 启用 header actor 校验 |
| `CHATBI_PERSISTENCE_MODE` | `memory` | 设置为 `file` 使用 JSON 文件 adapter |
| `CHATBI_PERSISTENCE_FILE` | `/private/tmp/chatbi-api-runtime.json` | file persistence 路径 |
| `CORS_ALLOW_ORIGIN` | `*` | CORS allow-origin |

## 后续生产化

- 用 Fastify/TypeBox 替换当前 Node adapter。
- 将 header actor 继续收敛到 OIDC/SAML；API Key Bearer 路径已具备本地验签和 service-account actor 注入，后续补轮换、持久化和审计落库。
- 将 JSON file persistence 替换为 PostgreSQL/Redis adapter。
- 将当前一次性 SSE 序列升级为生产长连接事件流和事件保留窗口。
