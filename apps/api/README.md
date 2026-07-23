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
- `fixture` / `postgresql` query mode：浏览器演示保持同步 fixture；PostgreSQL 模式使用独立 warehouse/control-plane pool，Run+Job 原子提交后返回 202，由带 lease/fencing 的 worker 原子发布 Run、结果页、审计和 SSE 事件。
- durable SSE 使用最长 25 秒的有限 long-poll；支持 `Last-Event-ID`，无新事件返回不推进 sequence 的 heartbeat。总 deadline 覆盖持久化读取；PostgreSQL event read 使用 dedicated client、硬 `query_timeout` 和独立取消池的 `pg_cancel_backend` 响应断连，随后释放监听器与连接。
- control-plane reconciler 周期扫描不可能状态，只自动释放可证明终态的 Conversation 或 fence 已失效 Job；结果/manifest 不一致只持久告警，绝不推测或生成结果。
- durable outbox 与 Run/Job/结果/事件使用同一 control-plane 事务提交；独立 publisher 通过数据库权威 lease 时钟、attempt、fence 和 token 提供至少一次投递，使用稳定 event ID、HMAC-SHA256、确定性指数退避和死信状态。连续投递失败与死信会让 readiness 退化并暴露 public-safe 计数；readiness、日志错误摘要和 outbox 状态视图不包含 payload、lease token、secret 或异常 message。
- terminal query Job 只保存 versioned manifest reference（`resultId + manifestChecksum`）；答案、事实、rows、columns、chartSpec 和结果摘要仅存在于同事务发布的最终 Run 与不可变 result pages/manifest。预算阻断只保存 versioned no-result code，不保存解释文本。
- `inline` / `s3` result storage mode：本地和测试默认 inline；staging/production PostgreSQL 强制使用 S3-compatible immutable blob storage。对象 key 由 tenant/workspace/run/attempt 与 SHA-256 派生，写入采用 create-only 条件语义，并在发布 manifest 前校验长度和摘要；数据库事务只提交 blob reference，失败事务遗留的内容寻址对象不会被 reader 看见。
- `GET /v1/results/{runId}/stream`：重新鉴权并确认 published manifest 后才解析 inline/blob 页面，逐行输出 NDJSON；Node transport 支持背压与断连取消，默认硬限制为 100k 行、32 MiB、60 秒，流中错误只返回 public-safe 终止记录。

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
| `CHATBI_QUERY_SSL_MODE` | staging/production 为 `verify-full`，其他环境 `disable` | `disable`、`require` 或 `verify-full`；未知非空值拒绝启动 |
| `CHATBI_QUERY_POOL_MAX` | `4` | 连接池大小；至少为 2，保证取消使用独立连接 |
| `CHATBI_QUERY_CONNECT_TIMEOUT_MS` | `5000` | 建连超时 |
| `CHATBI_QUERY_IDLE_TIMEOUT_MS` | `30000` | 空闲连接超时 |
| `CHATBI_QUERY_STATEMENT_TIMEOUT_MS` | `15000` | 单次查询硬超时上限 |
| `CHATBI_QUERY_WORKER_POLL_MS` | `250` | worker 轮询间隔 |
| `CHATBI_QUERY_LEASE_MS` | `30000` | job lease 时长 |
| `CHATBI_CONTROL_PLANE_CREDENTIAL_REF` | 无 | 独立写控制面凭据引用，例如 `env:CHATBI_CONTROL_PLANE_DATABASE_URL`；生产环境不得与 query ref 相同 |
| `CHATBI_CONTROL_PLANE_DATABASE_URL` | 无 | 仅由 Node 组合根通过 control-plane credential ref 解析 |
| `CHATBI_CONTROL_PLANE_SSL_MODE` | staging/production 为 `verify-full`，其他环境 `disable` | control-plane 独立 TLS 策略 |
| `CHATBI_CONTROL_PLANE_POOL_MAX` | `4` | control-plane pool；PostgreSQL 模式至少为 2 |
| `CHATBI_CONTROL_PLANE_CONNECT_TIMEOUT_MS` | `5000` | control-plane 建连超时 |
| `CHATBI_CONTROL_PLANE_IDLE_TIMEOUT_MS` | `30000` | control-plane 空闲连接超时 |
| `CHATBI_CONTROL_PLANE_CANCELLATION_POLL_MS` | `250` | 跨进程取消观察间隔，最小 25ms |
| `CHATBI_CONTROL_PLANE_WORKER_DRAIN_MS` | `30000` | 停机时等待当前 worker cycle 的时间 |
| `CHATBI_CONTROL_PLANE_RECONCILE_INTERVAL_MS` | `30000` | durable reconciler 非重叠扫描周期 |
| `CHATBI_CONTROL_PLANE_RECONCILE_BATCH_SIZE` | `100` | 每批最多检查的异常候选 Run，范围 1–500 |
| `CHATBI_OUTBOX_MODE` | local/test 为 `disabled`，staging/production PostgreSQL 为 `http` | fixture 模式始终不配置 publisher；staging/production PostgreSQL 禁止关闭 |
| `CHATBI_OUTBOX_HTTP_URL` | 无 | HTTPS 投递端点；禁止 URL userinfo、query parameter 和 fragment，避免凭据进入公共配置 |
| `CHATBI_OUTBOX_HMAC_SECRET_REF` | 无 | 必须为 `env:CHATBI_*` 服务端引用，不在公共配置保存 secret |
| `CHATBI_OUTBOX_HMAC_SECRET` | 无 | 示例 secret 环境变量；仅通过独立引用解析，至少 32 个随机字节且不得复用数据库凭据 |
| `CHATBI_OUTBOX_POLL_MS` | `250` | single-flight publisher 轮询周期，范围 25–60000ms |
| `CHATBI_OUTBOX_LEASE_MS` | `30000` | publisher lease，范围 1000–600000ms，必须大于 HTTP timeout |
| `CHATBI_OUTBOX_HTTP_TIMEOUT_MS` | `10000` | 单次 HTTPS 投递超时，范围 100–120000ms |
| `CHATBI_OUTBOX_RETRY_INITIAL_MS` | `1000` | 确定性指数退避初始延迟，范围 100–3600000ms |
| `CHATBI_OUTBOX_RETRY_MAX_MS` | `300000` | 退避上限，不得小于初始延迟，最大 86400000ms |
| `CHATBI_OUTBOX_MAX_ATTEMPTS` | `5` | 最大投递次数，范围 1–100；耗尽后进入死信 |
| `CHATBI_RESULT_STORAGE_MODE` | local/test 为 `inline`，staging/production PostgreSQL 为 `s3` | `inline` 或 `s3`；生产 PostgreSQL 禁止退回 inline |
| `CHATBI_RESULT_STORAGE_S3_ENDPOINT` | 无 | S3-compatible HTTPS origin；禁止 userinfo、path、query parameter 和 fragment |
| `CHATBI_RESULT_STORAGE_S3_REGION` | 无 | SigV4 region，使用小写字母、数字和连字符 |
| `CHATBI_RESULT_STORAGE_S3_BUCKET` | 无 | DNS-style bucket 名称 |
| `CHATBI_RESULT_STORAGE_CREDENTIAL_REF` | 无 | 独立的 `env:CHATBI_*` 或受支持 `vault://` opaque bundle reference；解析结果包含 `accessKeyId`、`secretAccessKey` 和可选 `sessionToken`，不得复用 query、control-plane 或 outbox ref |
| `CHATBI_RESULT_STORAGE_TIMEOUT_MS` | `15000` | 单次对象存储操作硬超时，范围 100–120000ms |
| `CHATBI_RESULT_STORAGE_MAX_BLOB_BYTES` | `67108864` | 单个 immutable blob 上限，范围 1024–1073741824 bytes |
| `CORS_ALLOW_ORIGIN` | `*` | CORS allow-origin |

复制 `.env.example` 后，先运行 `npm run migrate:control-plane`；migration CLI 使用非阻塞 advisory lock、SHA-256 ledger 和逐文件事务，检测到已应用文件变化、数据库未来版本，或 ledger 中存在 000/缺口/非连续前缀时会拒绝继续，避免向异常数据库补跑旧版本。空 ledger 若已存在任一已知 control-plane relation 也会拒绝接管；运行结束前还会核验全部已知 migration 的必需关系和结果不可变触发器，防止 `CREATE IF NOT EXISTS` 为漂移 schema 错误背书。001 是不含演示数据、登录角色或数据库名称的纯 control-plane baseline；006 增加 durable outbox message/attempt 状态。`scripts/postgres/init.sql` 仅供本地 PostgreSQL 集成测试使用，不属于生产迁移链。随后可用 `npm run start:api` 启动 Node API。真实 PostgreSQL adapter 只在 `apps/api` 组合根导入；`src/query` 仅包含 browser-safe 端口和 mapper。

## 后续生产化

- 用 Fastify/TypeBox 替换当前 Node adapter。
- 将 header actor 继续收敛到 OIDC/SAML；API Key Bearer 路径已具备本地验签和 service-account actor 注入，后续补轮换、持久化和审计落库。
- 在真实 PostgreSQL 环境持续运行 outbox 并发、lease 接管、事务回滚、reconciler、停机取消和多实例压测门禁。
- 将当前一次性 SSE 序列升级为生产长连接事件流和事件保留窗口。
