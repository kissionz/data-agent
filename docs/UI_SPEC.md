# InsightFlow ChatBI UI 规范

> 版本：1.0  
> 基线：参考图《InsightFlow ChatBI · 总设计标准》与《ChatBI Production PRD v1.0》  
> 适用范围：问答工作台、语义管理、运营中心、嵌入式分析  
> 实现原则：会话即工作区、结果优先、约束可见、状态无歧义

## 1. 规范优先级

设计与实现发生冲突时，按以下顺序裁决：

1. 安全、权限、口径可核验、状态真实性和 WCAG 2.2 AA。
2. PRD 中的业务与验收要求。
3. 参考图明确给出的视觉令牌和桌面布局。
4. 本文对空白场景、移动端、交互状态和可访问性的补充。

本文使用以下标记：

- **参考图**：直接取自参考图，不应随意改动。
- **PRD**：PRD 明确要求。
- **补充**：为形成可生产实现而增加，可在产品评审后调整。

## 2. 体验原则

### 2.1 会话即工作区

问题、运行过程、答案和后续追问必须处于同一时间线。答案产生后，当前会话立即进入会话列表，输入框始终固定在对话底部。用户不应在“提问页”和“结果页”间跳转。

### 2.2 结果优先

主工作区最先呈现当前任务和分析结论。运行日志、SQL、血缘、权限判定等证据可展开查看，但不得挤占结论的首屏位置。

### 2.3 约束可见

当前业务域、模式、指标口径、时间范围、过滤条件、数据更新时间、来源、语义版本和采用的默认值必须在结果附近可见。不得用“高置信度”代替证据。

### 2.4 状态无歧义

等待用户、理解、查询、完成、部分完成、需澄清、失败、取消必须使用不同文案、图标和语义色。不能只靠颜色区分，也不能把失败包装为自然语言结论。

## 3. 视觉令牌

### 3.1 色彩

#### 3.1.1 基础色

| Token | 值 | 用途 | 来源 |
|---|---:|---|---|
| `--color-blue-600` | `#146EF5` | 主操作、当前选择、处理中状态 | 参考图 |
| `--color-ink-900` | `#101828` | 主文本、标题 | 参考图 |
| `--color-surface` | `#F7F9FC` | 应用背景、次级面板 | 参考图 |
| `--color-surface-raised` | `#FFFFFF` | 卡片、输入框、浮层 | 补充 |
| `--color-border` | `#E4E9F0` | 默认边框、分隔线 | 参考图 |
| `--color-success-600` | `#16A05D` | 成功图标、完成状态 | 参考图 |
| `--color-warning-500` | `#F59E0B` | 需澄清、数据陈旧、风险提示 | 参考图 |
| `--color-danger-500` | `#E5484D` | 失败、危险操作 | 参考图 |

#### 3.1.2 可交互与可访问状态

参考图中的状态色不应直接承担小字号文本颜色。使用下列语义搭配保证可读性：

| 角色 | 前景 | 背景 | 边框 |
|---|---:|---:|---:|
| `info` | `#0B57D0` | `#EAF2FF` | `#A9CBFF` |
| `success` | `#087443` | `#E9F8F0` | `#9BD8B9` |
| `warning` | `#8A4B00` | `#FFF6E5` | `#F6CF82` |
| `danger` | `#C62828` | `#FFF0F0` | `#F4B4B7` |
| `neutral` | `#475467` | `#F2F4F7` | `#D0D5DD` |

交互色：

- Primary hover：`#0F5FD8`。
- Primary pressed：`#0B4EB4`。
- Primary disabled：背景 `#B9D4FC`，前景 `#FFFFFF`，同时移除指针事件并保留禁用语义。
- Focus ring：外圈 `0 0 0 3px rgba(20, 110, 245, .28)`，内圈 `1px #146EF5`。
- Selected surface：背景 `#EEF5FF`，文字与图标 `#0B57D0`。
- Hover surface：`#F2F6FC`。
- Scrim：`rgba(16, 24, 40, .48)`。

规则：品牌蓝仅用于主操作、当前选择、链接和运行状态，不作为装饰性大面积铺色；一个视口内原则上只出现一个视觉主按钮。

### 3.2 字体

字体栈：

```css
font-family: Inter, "SF Pro Text", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
```

| Token | 字号/行高 | 字重 | 用途 | 来源 |
|---|---:|---:|---|---|
| `--type-page-title` | `24px/32px` | 600 | 页面标题 | 参考图 |
| `--type-section-title` | `16px/24px` | 600 | 区块标题、卡片标题 | 参考图 |
| `--type-body` | `14px/22px` | 400 | 正文、表格内容 | 参考图 |
| `--type-caption` | `12px/18px` | 400 | 辅助说明、元数据 | 参考图 |
| `--type-data` | `28px/36px` | 600 | KPI 数值 | 参考图 |
| `--type-control` | `14px/20px` | 500 | 按钮、标签、输入 | 补充 |
| `--type-code` | `12px/18px` | 400 | SQL、IR、trace ID | 补充 |

数字使用 `font-variant-numeric: tabular-nums`。产品界面不使用展示字体、渐变文字或全大写正文。正文阅读区最长 75ch，表格和代码区可更宽。

### 3.3 间距与尺寸

使用 8pt 网格，4px 仅用于图标与文字的微间距。

| Token | 值 | 常见用途 |
|---|---:|---|
| `--space-1` | `4px` | 图标与短标签 |
| `--space-2` | `8px` | 紧凑控件内部、列表项间距 |
| `--space-3` | `12px` | 输入框横向内边距 |
| `--space-4` | `16px` | 卡片内边距、表单间距 |
| `--space-6` | `24px` | 区块间距、页面内边距 |
| `--space-8` | `32px` | 大区块分隔 |

基础控件高度：紧凑型 32px，默认 40px，大型输入/按钮 48px。触控目标不得小于 44×44px，桌面密集工具栏中的 32px 图标按钮必须通过 44px 可点击外框实现。

### 3.4 圆角、边框与阴影

| Token | 值 | 用途 |
|---|---:|---|
| `--radius-sm` | `6px` | 小标签、紧凑按钮 |
| `--radius-md` | `8px` | 输入框、按钮、菜单 |
| `--radius-lg` | `10px` | 卡片、面板 |

不使用胶囊式大圆角容器。状态标签可使用 `6px` 圆角，不使用无语义的全圆胶囊。默认边框 1px。阴影仅用于脱离文档流的浮层：

```css
--shadow-popover: 0 8px 24px rgba(16, 24, 40, .12);
--shadow-modal: 0 24px 64px rgba(16, 24, 40, .20);
```

### 3.5 图标

统一使用线性、圆端、1.5px 或 2px 描边图标。常规 18px，导航 20px，状态 20px。所有图标按钮必须有可访问名称和 Tooltip。成功、警告、失败分别同时使用 check、exclamation、cross 图形，不能仅靠绿、橙、红表达。

### 3.6 层级与动效

```text
base 0 < sticky 10 < dropdown 30 < drawer 40 < modal-backdrop 50
< modal 60 < toast 70 < tooltip 80
```

- Hover/focus：120–160ms。
- 面板展开、状态切换：180–240ms，`cubic-bezier(.16,1,.3,1)`。
- 数据加载使用骨架屏或行级进度，不在内容中央放孤立 Spinner。
- `prefers-reduced-motion: reduce` 时取消位移、缩放和循环动画，只保留即时状态替换或短淡入。

## 4. 桌面布局

### 4.1 1440px 四栏基线

参考图规定桌面端采用以下结构：

```text
┌────68────┬──────260──────┬──────── 弹性主工作区，最小 720 ────────┬────235────┐
│ 全局导航 │ 会话列表       │ 问答时间线、答案、图表、固定输入框       │ 上下文面板 │
└──────────┴───────────────┴───────────────────────────────────────┴───────────┘
```

CSS 建议：

```css
grid-template-columns: 68px 260px minmax(720px, 1fr) 235px;
height: 100dvh;
overflow: hidden;
```

四栏固定宽度合计 563px。1440px 视口下主工作区约 877px。各栏以 1px `--color-border` 分隔，不添加多余阴影。

### 4.2 各栏职责

#### 全局导航，68px

- 顶部：产品标识，工作区切换入口。
- 主区：问答、语义中心、运营中心、数据源、设置。
- 底部：帮助、通知、用户菜单。
- 默认只显示图标，Tooltip 提供文本；当前项使用蓝色图标和 `--selected-surface` 背景。
- 不在此栏承载二级功能树。

#### 会话列表，260px

- 顶部：新建会话主操作、搜索、筛选。
- 中部：按今天、过去 7 天、更早分组的会话项。
- 会话项展示标题、最新状态或时间，溢出操作进入菜单。
- 当前会话使用 selected surface 和 3px 内嵌左侧指示，不使用装饰性卡片。
- 答案生成后立即插入列表顶部；重命名、收藏、归档均原位反馈。

#### 主工作区，弹性且最小 720px

- Header：面包屑或会话标题，业务域、可信/探索/专家模式、分享和更多操作。
- Timeline：用户问题、规划/查询过程、澄清卡、答案卡按时间顺序排列。
- Result：结论优先，随后 KPI/图表/表格、证据摘要和结构化追问。
- Composer：固定在工作区底部，不随结果滚出；支持附件、输入、发送、运行中停止。
- 内容最大宽度建议 1040px，并在更宽工作区居中；数据表可突破该宽度占满工作区。

#### 上下文面板，235px

- 展示当前业务域、模式、指标、维度、时间、过滤、默认条件、语义版本和来源。
- 属性按区组组织，支持单项修改或移除。
- 不重复答案全文，不作为聊天消息侧栏。
- SQL、IR、执行详情可从证据入口打开更宽的检查器，不强行塞入 235px。

### 4.3 桌面断点

| 视口 | 结构 |
|---|---|
| `≥1440px` | 完整四栏，68/260/弹性/235。 |
| `1280–1439px` | 右侧上下文面板收起为 44px 入口或覆盖式抽屉，前三栏保持。 |
| `1024–1279px` | 68px 全局导航保留，会话列表变为覆盖抽屉，主工作区占剩余宽度。 |
| `<1024px` | 进入平板/移动结构，不维持四栏。 |

断点的目标是保障主工作区，不允许为了保留侧栏把主工作区压窄至 720px 以下。

## 5. 平板与移动端

### 5.1 平板，768–1023px

- 顶部应用栏 56px：菜单、会话标题、模式标签、上下文入口。
- 左侧全局导航与会话列表合并为 320px 覆盖抽屉。
- 上下文面板使用右侧 320px 覆盖抽屉。
- 主区单列，页面横向内边距 24px，输入框固定底部。
- 表格优先提供列显隐、冻结首列和横向滚动，不能缩小文字至 12px 以下。

### 5.2 移动，<768px

- 顶部栏 52px：菜单、截断后的会话标题、上下文按钮。
- 主区左右内边距 16px，消息与结果占满可用宽度，不模拟桌面聊天气泡的窄列。
- 输入区固定底部，单行最小 48px，最多自动增长至 6 行；键盘弹出时基于 `visualViewport` 保持可见。
- 全局导航和会话列表在全屏抽屉内分两层，返回行为明确。
- 上下文使用底部 Sheet，默认 65dvh，可展开至 92dvh；提供可见标题与关闭按钮。
- 图表提供横屏模式和“查看数据表”入口；触控 Tooltip 改为点击锁定。
- KPI 超过两个时使用单列或 2 列网格；不使用横向滑动隐藏核心数字。
- 结构化追问使用可换行的按钮组，不使用不可滚动的单行 chips。
- Toast 不遮挡 Composer，底部偏移为 Composer 高度加 16px。

## 6. 核心组件规范

### 6.1 Button

变体：Primary、Secondary、Tertiary、Danger、Icon。默认圆角 8px，高度 40px。Primary 用于“开始分析”“提交澄清”“保存发布”等当前流程唯一主操作。Secondary 用于“修改条件”“导出”等次要操作。所有变体具备 default、hover、focus-visible、pressed、disabled、loading。

Loading 时保留按钮宽度和原标签语义，可显示左侧 16px 进度图标。危险操作标签必须明确对象，如“下线指标”，不能写“确认”。

### 6.2 Field 与 Composer

- 输入边框 1px，圆角 8px，默认高度 40px。
- Composer 是复合组件，包含附件、可增长文本区、发送/停止按钮、输入提示和错误区。
- 空输入时发送禁用；运行时发送替换为停止按钮，停止必须在 3 秒内传递到底层执行。
- `Enter` 发送、`Shift+Enter` 换行，中文输入法 composition 阶段不得误发送。
- 错误信息与字段通过 `aria-describedby` 关联，不只改变边框颜色。

### 6.3 ModeBadge 与 StatusBadge

- ModeBadge：可信、探索、专家。模式是数据边界，不是普通状态。
- 可信模式使用 info 语义；探索模式使用 warning；专家模式使用 neutral 并附审计提示。
- StatusBadge：只表达最终或阶段状态，使用图标、短标签和必要的辅助文案。
- Badge 不承担点击行为。需要切换模式时使用 Select/MenuButton。

### 6.4 ConstraintChip

展示筛选、时间、维度、默认条件。结构为类型图标、值、可选移除按钮。可编辑项点击打开 Popover，删除按钮有独立 44px 触控目标。系统默认条件必须标注“默认”，用户显式条件不得被系统静默覆盖。

### 6.5 ConversationItem

包含状态点、两行内标题、相对时间和更多菜单。当前会话必须同时使用背景、文字权重和 `aria-current="page"`。运行中显示阶段图标，失败显示 danger 图标，但标题仍保持 Ink 色以保证可读性。

### 6.6 TimelineMessage

类型：UserQuestion、SystemProgress、Clarification、Answer、Error、PartialResult。消息使用统一时间线对齐，不把每个内容都包装成同样大小的卡片。用户问题可使用浅蓝表面；答案默认直接落在内容面，复杂数据块才使用有边框容器。

### 6.7 ProgressStep

标准阶段：已接收、理解问题、生成计划、校验权限与成本、查询数据、生成结果。默认折叠为一行当前阶段，展开后显示步骤与耗时。步骤状态为 pending/running/success/failed/skipped。运行过程通过 `aria-live="polite"` 宣告，频率应节流，避免逐 token 播报。

### 6.8 ClarificationCard

最多展示 3 个互斥候选，使用 RadioGroup。必须说明需要确认的字段，如指标、时间或成员值。保留原问题和当前已确定条件。主操作“使用此解释继续”，次操作“修改问题”。未选择时主操作禁用。

### 6.9 AnswerHeader

顺序固定：

1. 一句话结论。
2. 可信/探索模式标签和完成/部分结果状态。
3. 数据更新时间、时间范围、默认条件或异常提示。
4. 收藏、分享、导出和更多操作。

部分结果和陈旧数据必须在结论同级可见，不能藏入详情。

### 6.10 ResultRenderer

支持 KPI、Table、Line、Bar、Stacked Bar、Scatter。组件必须接收校验后的图表规格，不由展示层猜测数据语义。

- KPI：数值、单位、比较基准、变化方向、更新时间。
- 图表：标题、必要的副标题、单位、图例、数据来源入口。
- 表格：语义化 `<table>`、粘性表头、排序状态、分页/虚拟化、导出入口。
- 颜色不作为唯一编码；折线使用线型/点型辅助，分类图表提供直接标签或图例。
- 禁止截断坐标轴制造夸大差异；确需截断时明确标注。

### 6.11 EvidencePanel

使用 Disclosure/Accordion 展示：指标口径、过滤、时间、来源、数据新鲜度、语义版本、结果引用、SQL、Analysis IR、执行耗时。默认展开“口径与过滤”，SQL 和 IR 默认折叠。复制成功通过非阻塞 Toast 反馈。

### 6.12 FollowUpActions

结构化快捷追问包括下钻、换维度、同比、环比、解释异常。每个动作都应展示将修改的约束，并在执行后进入同一时间线。自然语言输入紧随其后，不另开页面。

### 6.13 Empty、Error 与 Skeleton

- 首次空状态：示例问题、可用业务域和当前权限范围，帮助用户开始任务。
- 无会话：新建会话入口和简短说明。
- 空结果：说明查询已成功但无匹配数据，并提供放宽时间或过滤的操作。
- 权限拒绝：不泄露资源存在性，只说明当前权限无法完成并提供申请入口。
- 系统失败：显示可理解原因、重试和 request ID 复制入口。
- 加载：骨架尺寸应接近最终内容，不在页面中心使用单一 Spinner。

### 6.14 Overlay

Popover 用于轻量编辑，Drawer 用于会话和上下文，Modal 只用于不可逆确认或强阻塞流程。所有 Overlay 使用 Portal，具备焦点圈定、Esc 关闭、关闭后焦点归还和背景滚动锁定。危险确认不得仅依赖 Modal 标题，按钮应写明操作对象。

## 7. 状态语义与状态机

| UI 状态 | 视觉 | 主文案示例 | 可用操作 |
|---|---|---|---|
| `idle` | neutral/user icon | 待输入 | 输入问题 |
| `accepted` | info/dot | 已接收问题 | 停止 |
| `understanding` | info/progress ring | 正在理解问题与上下文 | 停止 |
| `planning` | info/progress ring | 正在生成分析计划 | 停止、展开步骤 |
| `clarification_required` | warning/exclamation | 需要确认指标或时间 | 选择候选、修改问题 |
| `querying` | info/progress ring | 正在查询数据 | 停止、查看步骤 |
| `completed` | success/check | 分析完成 | 追问、导出、分享 |
| `partial` | warning/partial icon | 部分结果已就绪 | 查看原因、重试未完成步骤 |
| `empty` | neutral/empty icon | 查询成功，暂无匹配数据 | 修改条件 |
| `stale` | warning/clock | 数据尚未更新 | 查看最近更新时间、继续或取消 |
| `cancelled` | neutral/stop icon | 已停止分析 | 重新运行、修改问题 |
| `failed` | danger/cross | 分析失败 | 重试、复制 request ID |
| `permission_denied` | danger/lock | 当前权限无法完成此请求 | 申请权限、返回 |

状态转换：

```text
idle → accepted → understanding → planning
planning → clarification_required → planning
planning → querying → completed | partial | empty | stale | failed
accepted | understanding | planning | querying → cancelled
任何执行阶段 → permission_denied（终止，不暴露资源存在性）
```

`completed` 只表示数据与答案均已就绪。若任一步骤失败但有可用结果，必须使用 `partial`，不得显示绿色“完成”。

## 8. 页面与前端组件地图

### 8.1 应用壳

```text
AppShell
├─ GlobalRail
├─ ConversationSidebar
│  ├─ NewConversationButton
│  ├─ ConversationSearch
│  └─ ConversationList > ConversationItem
├─ Workspace
│  ├─ WorkspaceHeader
│  ├─ ConversationTimeline
│  └─ Composer
└─ ContextPanel
   ├─ DomainSummary
   ├─ ModeSummary
   ├─ ConstraintList
   └─ SemanticVersionSummary
```

### 8.2 问答工作台，PRD F04–F08

```text
ChatWorkspace
├─ QuestionMessage
├─ RunProgress > ProgressStep[]
├─ ClarificationCard
├─ AnswerBlock
│  ├─ AnswerHeader
│  ├─ KPIGroup | ResultChart | ResultTable
│  ├─ EvidencePanel
│  ├─ FollowUpActions
│  └─ FeedbackControl
├─ PartialResultNotice | ErrorNotice | EmptyResult
└─ Composer
```

### 8.3 语义管理，PRD F02/F03

```text
SemanticCenter
├─ SemanticObjectList
│  ├─ SearchAndFilterBar
│  ├─ StatusFilter
│  └─ MetricOrDimensionTable
├─ SemanticEditor
│  ├─ BasicDefinitionForm
│  ├─ FormulaEditor
│  ├─ DimensionAndGrainRules
│  ├─ JoinGraphViewer
│  ├─ DependencyPanel
│  └─ VersionHistory
├─ ReconciliationPreview
├─ ImpactAnalysis
└─ ApprovalBar
```

生命周期状态严格使用草稿、评审、认证、弃用、下线。发布或下线为明确主操作，需展示门禁和影响范围。

### 8.4 运营中心，PRD F09/F10/F13/F14

```text
OperationsCenter
├─ OverviewMetrics
├─ EvaluationRuns
│  ├─ GateStatus
│  ├─ MetricTable
│  └─ VersionComparison
├─ FailureReplay
│  ├─ RequestTrace
│  ├─ RetrievalSnapshot
│  ├─ IRDiff
│  ├─ SQLDiff
│  └─ ResultAndAnswerDiff
├─ FeedbackQueue
├─ ModelAndPromptVersions
├─ CostAndQuota
└─ SLOAndAlerts
```

运营数据密集页优先表格、筛选与下钻，不使用相同卡片反复包装。指标异常必须有基准、时间和版本信息。

### 8.5 数据源与工作区管理，PRD F01/F02

```text
Admin
├─ WorkspaceAndDomainSettings
├─ IdentityAndRoleMatrix
├─ DataSourceCatalog
│  ├─ ConnectionWizard
│  ├─ MetadataSyncStatus
│  ├─ QualityGate
│  └─ FreshnessAndLineage
└─ AuditLog
```

连接凭据始终掩码显示，测试连接有独立进度与结果。权限矩阵必须支持键盘操作和文本化权限摘要。

## 9. 表格、图表和数据密度

- 默认表格行高 44px，紧凑模式 36px，仅桌面可用。
- 表头 12px/18px、600；正文 14px/22px；数字右对齐并使用等宽数字。
- 表头必须与单元格建立程序化关联。排序按钮提供 `aria-sort`。
- 超过 100 行使用服务端分页或虚拟化。虚拟化不能破坏屏幕阅读器获取当前行信息。
- 图表必须同时提供可访问名称、文本摘要和数据表入口。
- 默认分类色序列应通过色盲检验；同一指标跨页面保持同色，不把红绿直接用于普通涨跌，除非业务语义明确。
- 导出菜单必须标示格式、权限/脱敏结果和数据更新时间。

## 10. 可访问性

目标：WCAG 2.2 AA。

- 正文和占位文本对背景对比度至少 4.5:1；大字至少 3:1；非文本控件边界至少 3:1。
- 所有交互可通过键盘完成，焦点顺序与视觉顺序一致，`focus-visible` 始终可见。
- 页面只有一个 `h1`；答案、口径、来源、SQL 等使用顺序正确的标题层级。
- 全局导航使用 `<nav>`，主工作区使用 `<main>`，上下文使用有名称的 `<aside>`。
- 运行阶段更新使用节流后的 `aria-live="polite"`；失败、权限拒绝等使用 `role="alert"`，避免重复宣告。
- 图标按钮、关闭按钮、更多菜单必须有可访问名称。Tooltip 不能是名称的唯一来源。
- Toast 至少保留 5 秒；关键错误不得仅以 Toast 呈现。
- 不自动夺取焦点到新答案。答案完成后宣告“分析完成”，用户可用“跳到最新结果”快捷入口定位。
- 提供跳至主内容、跳至输入框、跳至最新结果的快捷链接。
- Windows 高对比模式下保留边框、焦点和状态图标。
- 本地化文案不得依赖固定宽度；按钮和标签需容纳约 1.5 倍中文文本长度。

## 11. 文案与反馈

- 按钮采用动词加对象：“开始分析”“修改条件”“停止查询”“导出结果”。
- 权限错误不暴露对象是否存在：“当前权限无法完成此请求”。
- 空结果说明查询成功但无匹配数据，不写“分析失败”。
- 部分结果明确已完成内容和未完成原因。
- 默认条件使用“已采用：近 30 个完整自然日”，不使用含糊的“智能默认”。
- 不展示模型自报置信分数作为可信凭证。
- 技术标识 request ID、trace ID 默认折叠，但错误场景提供一键复制。

## 12. 验收清单

### 12.1 视觉与布局

- 1440px 下为 68/260/弹性主区/235 四栏，主区不小于 720px。
- 1280px 以下按规范收起右面板，1024px 以下会话栏改覆盖抽屉。
- 全站使用 Blue 600 `#146EF5` 和 8pt 网格。
- 控件圆角只使用 6/8/10px，不出现大胶囊容器。
- 同一流程同一层级组件视觉一致，当前视口主按钮不竞争。

### 12.2 交互与状态

- 每个交互组件覆盖 default、hover、focus、active、disabled、loading、error。
- 等待、理解、查询、完成、部分结果、需澄清、失败和取消能通过文字与图标区分。
- Composer 始终可见，运行中发送切换为停止。
- 答案生成后会话立即进入列表。
- 口径、过滤、时间、来源、数据更新时间和语义版本无需查看 SQL 即可获得。

### 12.3 响应式与可访问性

- 在 320、375、768、1024、1280、1440、1920px 检查无横向页面溢出。
- 键盘可完成提问、澄清、展开证据、追问、导出和关闭浮层。
- 200% 缩放后核心内容与操作不丢失。
- 屏幕阅读器可感知运行状态、错误、表头关系和图表摘要。
- `prefers-reduced-motion`、高对比模式、中文输入法和移动键盘场景通过测试。

## 13. 建议的前端分层

```text
ui/tokens          颜色、字体、间距、圆角、动效、层级
ui/primitives      Button、Field、Menu、Dialog、Drawer、Tabs、Tooltip
ui/data-display    Badge、Table、ChartFrame、KPI、Skeleton、EmptyState
features/chat      Timeline、Composer、Clarification、Answer、FollowUp
features/context   ConstraintChip、EvidencePanel、SemanticSummary
features/semantic  指标编辑、依赖、Join Graph、审批与发布
features/ops       评测、回放、反馈、版本、成本、SLO
layouts            AppShell、ResponsiveDrawer、MobileTopBar
```

业务组件只消费语义 Token，不直接写十六进制颜色或任意间距。状态机与视觉层解耦，后端事件先归一化为统一 UI 状态，再由组件渲染。这样可以防止不同页面对同一运行状态使用不同文案或颜色。
