# InsightFlow ChatBI / Data Agent

面向企业经营分析的自然语言数据问答工作台。当前仓库交付的是第一阶段成果：按照 PRD 与 UI 规范完成的 React 前端工作台、语义治理与运营中心页面，以及可测试的 TypeScript 领域 mock 基座。

当前阶段不伪装成生产后端。SSO、真实数据源连接、持久化、Query Gateway、SQL 编译、审计存储、模型网关和评测流水线仍需在后续阶段接入。

## 当前已实现

- 四栏 ChatBI 工作台：全局导航、会话列表、主时间线、右侧上下文面板、底部固定追问输入。
- 运行状态闭环：待输入、理解中、查询中、已完成、需澄清、失败；部分结果作为结果完整性标记处理。
- 可信答案视图：结论、KPI、趋势图、表格、口径、筛选条件、证据、SQL 摘要、反馈入口。
- 澄清流程 mock：低置信或多义问题不执行查询，展示最多 3 个结构化候选。
- 权限安全 mock：越权问题进入安全拒绝，不泄露无权资源是否存在。
- 语义中心：指标列表、详情、编辑态、公式、维度、依赖、版本历史和审批信息。
- 运营中心：SLO/KPI、发布门禁、失败分布、回放队列、模型版本、延迟趋势。
- 响应式布局：桌面四栏；窄屏抽屉/底部面板；移动端单栏与固定输入。
- 领域与测试基座：运行状态机、会话模型、语义版本、权限拒绝与安全场景测试。

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

已完成的是“可运行、可审查、可继续开发”的产品基座，不是完整生产系统。生产化仍至少需要：

- API/BFF、会话持久化、租户/组织/工作空间模型。
- OIDC/SAML/SCIM、RBAC + ABAC、策略变更实时生效。
- 数据源管理、元数据同步、数据质量门禁、语义对象持久化。
- Analysis IR 契约包、Planner、确定性 SQL Compiler、Query Gateway。
- 审计事件、导出水印、分享二次鉴权、缓存权限失效。
- Model Gateway、评测中心、黄金集回归、灰度发布与回滚。
- Playwright E2E、性能/SLO、安全与多租户隔离测试。

语义中心和运营中心的筛选、刷新、审批、回放等交互当前均为 fixture/mock 交互，不代表已连接真实审批流、监控平台或评测流水线。

## 建议下一阶段

1. 抽出 `packages/contracts`，定义 PRD 中的 Analysis IR、Run、Result、ErrorCode、AuditEvent JSON Schema。
2. 增加 `apps/api`，先用 deterministic planner + mock query adapter 跑通 `POST /v1/questions`、澄清、取消和状态查询。
3. 将当前前端 mock 替换为 BFF adapter，同时保留 fixtures 作为黄金问题回归样本。
4. 补齐 Playwright E2E：标准查询、澄清、越权拒绝、部分结果、语义编辑、运营回放。
