import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAdjustments,
  IconArchive,
  IconArrowUp,
  IconBrain,
  IconChartLine,
  IconCheck,
  IconChevronDown,
  IconCircleX,
  IconDatabase,
  IconDownload,
  IconHelp,
  IconLayoutSidebarRightCollapse,
  IconMenu2,
  IconMessage,
  IconPlayerStop,
  IconPlus,
  IconSearch,
  IconSend2,
  IconShieldCheck,
  IconSparkles,
  IconTable,
  IconThumbDown,
  IconThumbUp,
  IconX,
} from '@tabler/icons-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { SemanticGovernance } from './features/semantic'
import type { SemanticDimension as UiDimension, SemanticMetric as UiMetric } from './features/semantic'
import { OperationsCenter } from './features/operations'
import { DataSourceCenter } from './features/data-sources'
import { createChatBiApplicationService } from './application'
import type { ActorContext, PublicRunView } from './contracts'

type Page = 'workbench' | 'semantic' | 'dataSources' | 'operations'
type RunStatus = 'waiting_input' | 'understanding' | 'querying' | 'completed' | 'needs_clarification' | 'failed'
type ResultView = 'chart' | 'table' | 'evidence'

const revenueData = [
  { month: '1月', revenue: 826 },
  { month: '2月', revenue: 792 },
  { month: '3月', revenue: 918 },
  { month: '4月', revenue: 966 },
  { month: '5月', revenue: 1042 },
  { month: '6月', revenue: 1128 },
  { month: '7月', revenue: 1094 },
  { month: '8月', revenue: 1216 },
  { month: '9月', revenue: 1279 },
  { month: '10月', revenue: 1336 },
  { month: '11月', revenue: 1398 },
  { month: '12月', revenue: 1486 },
]

const sessions = [
  { title: '过去 12 个月净收入趋势', meta: '刚刚', active: true },
  { title: '华东区域收入下钻', meta: '查询完成', active: false },
  { title: '各渠道客单价对比', meta: '昨天', active: false },
  { title: '上季度区域排行榜', meta: '6月20日', active: false },
  { title: '订单退款率复盘', meta: '6月18日', active: false },
]

const governanceDimensions: UiDimension[] = [
  { id: 'order_date', name: '订单日期', dataType: 'date', hierarchy: '年 / 季度 / 月 / 日' },
  { id: 'region', name: '区域', dataType: 'string', hierarchy: '大区 / 省份 / 城市' },
  { id: 'channel', name: '渠道', dataType: 'string', hierarchy: '渠道类型 / 渠道' },
  { id: 'product_line', name: '产品线', dataType: 'string', hierarchy: '品类 / 产品线 / 商品' },
]

const governanceMetrics: UiMetric[] = [
  {
    id: 'net_revenue', name: '净收入', code: 'net_revenue', description: '已完成订单实付金额扣除退款、折扣与税费后的认证经营指标。',
    status: 'certified', formula: 'sum(completed_order_revenue) - sum(refund_amount)', valueType: 'currency', unit: 'CNY', aggregation: 'derived',
    owner: '经营分析组', domain: '销售经营', currentVersion: '2026.06.3', updatedAt: '2026-06-21 16:24', dimensions: ['order_date', 'region', 'channel', 'product_line'],
    dependencies: [{ id: 'dwd_order_settlement', name: '订单结算事实表', type: 'dataset' }, { id: 'refund_amount', name: '退款金额', type: 'metric', status: 'certified' }],
    versions: [{ version: '2026.06.3', status: 'certified', changedAt: '2026-06-21 16:24', changedBy: '周若安', summary: '补充平台优惠分摊规则' }, { version: '2026.04.1', status: 'deprecated', changedAt: '2026-04-02 10:08', changedBy: '周若安', summary: '旧版退款口径' }],
  },
  {
    id: 'gross_revenue', name: '含税收入', code: 'gross_revenue', description: '退款扣减前的订单含税收入。', status: 'review', formula: 'sum(order_gross_amount)', valueType: 'currency', unit: 'CNY', aggregation: 'sum', owner: '财务数据组', domain: '销售经营', currentVersion: '2026.06.1-rc2', updatedAt: '2026-06-20 11:03', dimensions: ['order_date', 'region', 'channel'], dependencies: [{ id: 'dwd_order', name: '订单事实表', type: 'dataset' }], versions: [{ version: '2026.06.1-rc2', status: 'review', changedAt: '2026-06-20 11:03', changedBy: '赵清越', summary: '等待财务负责人对账' }],
  },
  {
    id: 'order_count', name: '已完成订单数', code: 'completed_order_count', description: '完成支付且未全额退款的去重订单数量。', status: 'certified', formula: 'count_distinct(completed_order_id)', valueType: 'number', unit: '笔', aggregation: 'count_distinct', owner: '经营分析组', domain: '销售经营', currentVersion: '2026.05.2', updatedAt: '2026-05-18 09:42', dimensions: ['order_date', 'region', 'channel', 'product_line'], dependencies: [{ id: 'dwd_order', name: '订单事实表', type: 'dataset' }], versions: [{ version: '2026.05.2', status: 'certified', changedAt: '2026-05-18 09:42', changedBy: '许闻舟', summary: '排除测试订单' }],
  },
  {
    id: 'refund_rate', name: '退款率', code: 'refund_rate', description: '退款订单数占已支付订单数的比例。', status: 'draft', formula: 'refund_order_count / paid_order_count', valueType: 'percentage', unit: '%', aggregation: 'derived', owner: '客户体验组', domain: '销售经营', currentVersion: '2026.06.0-draft', updatedAt: '2026-06-22 09:10', dimensions: ['order_date', 'region', 'product_line'], dependencies: [{ id: 'refund_order_count', name: '退款订单数', type: 'metric', status: 'review' }], versions: [{ version: '2026.06.0-draft', status: 'draft', changedAt: '2026-06-22 09:10', changedBy: '沈星回', summary: '首次创建' }],
  },
]

const statusCopy: Record<RunStatus, string> = {
  waiting_input: '待输入',
  understanding: '理解中',
  querying: '查询中',
  completed: '已完成',
  needs_clarification: '需澄清',
  failed: '失败',
}

const demoActor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_lin',
  roles: ['business_user'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

function GlobalRail({ page, onPage, onOpenMenu }: { page: Page; onPage: (page: Page) => void; onOpenMenu: () => void }) {
  const nav = [
    { id: 'workbench' as const, label: '问答工作台', icon: IconMessage },
    { id: 'semantic' as const, label: '语义中心', icon: IconDatabase },
    { id: 'dataSources' as const, label: '数据源中心', icon: IconTable },
    { id: 'operations' as const, label: '运营中心', icon: IconChartLine },
  ]
  return (
    <nav className="global-rail" aria-label="全局导航">
      <button className="brand-mark" aria-label="打开导航" onClick={onOpenMenu}><IconBrain size={24} /></button>
      <div className="rail-nav">
        {nav.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? 'rail-button selected' : 'rail-button'}
            aria-label={item.label}
            title={item.label}
            onClick={() => onPage(item.id)}
          >
            <item.icon size={20} />
          </button>
        ))}
      </div>
      <div className="rail-footer">
        <button className="rail-button" aria-label="帮助" title="帮助"><IconHelp size={20} /></button>
        <button className="user-avatar" aria-label="用户菜单" title="林舟，经营分析">林</button>
      </div>
    </nav>
  )
}

function SessionList({ open, onClose, onNew }: { open: boolean; onClose: () => void; onNew: () => void }) {
  const [query, setQuery] = useState('')
  const filtered = sessions.filter((session) => session.title.includes(query))
  return (
    <aside className={open ? 'session-panel open' : 'session-panel'} aria-label="会话列表">
      <div className="panel-title-row">
        <div>
          <strong>InsightFlow</strong>
          <span>ChatBI</span>
        </div>
        <button className="icon-button mobile-only" onClick={onClose} aria-label="关闭会话列表"><IconX size={18} /></button>
      </div>
      <button className="primary-button new-chat" onClick={onNew}><IconPlus size={18} /> 新建分析</button>
      <label className="search-box">
        <IconSearch size={17} />
        <span className="sr-only">搜索会话</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索会话" />
      </label>
      <div className="session-group">
        <div className="group-label">今天</div>
        {filtered.slice(0, 2).map((session) => <SessionRow key={session.title} {...session} />)}
      </div>
      <div className="session-group">
        <div className="group-label">过去 7 天</div>
        {filtered.slice(2).map((session) => <SessionRow key={session.title} {...session} />)}
      </div>
      <button className="archive-button"><IconArchive size={17} /> 查看已归档会话</button>
    </aside>
  )
}

function SessionRow({ title, meta, active }: { title: string; meta: string; active: boolean }) {
  return (
    <button className={active ? 'session-row active' : 'session-row'}>
      <span className="session-title">{title}</span>
      <span className="session-meta">{meta}</span>
    </button>
  )
}

function Workbench({ onOpenSessions, onOpenContext, resetKey }: { onOpenSessions: () => void; onOpenContext: () => void; resetKey: number }) {
  const serviceRef = useRef(createChatBiApplicationService(() => '2026-06-23T09:00:00+08:00'))
  const [question, setQuestion] = useState('')
  const [submittedQuestion, setSubmittedQuestion] = useState('过去 12 个完整自然月净收入趋势')
  const [status, setStatus] = useState<RunStatus>('completed')
  const [runView, setRunView] = useState<PublicRunView | null>(null)
  const [resultView, setResultView] = useState<ResultView>('chart')
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const timerRef = useRef<number[]>([])
  const previousResetKeyRef = useRef(resetKey)

  const clearTimers = () => {
    timerRef.current.forEach((timer) => window.clearTimeout(timer))
    timerRef.current = []
  }

  useEffect(() => () => clearTimers(), [])
  useEffect(() => {
    if (previousResetKeyRef.current === resetKey) return
    previousResetKeyRef.current = resetKey
    clearTimers()
    setQuestion('')
    setSubmittedQuestion('')
    setStatus('waiting_input')
    setRunView(null)
  }, [resetKey])

  const runQuestion = (value = question) => {
    const clean = value.trim()
    if (!clean) return
    clearTimers()
    setQuestion('')
    setSubmittedQuestion(clean)
    setFeedback(null)
    setRunView(null)
    setStatus('understanding')
    timerRef.current.push(window.setTimeout(() => {
      const response = serviceRef.current.submitQuestion({
        idempotencyKey: `${Date.now()}_${clean}`,
        conversationId: 'conversation_workbench',
        question: clean,
        mode: 'trusted',
        actor: demoActor,
      })
      if (!response.ok) {
        setRunView(null)
        setStatus('failed')
        return
      }
      if (response.data.displayStatus !== 'completed') {
        setRunView(response.data)
        setStatus(response.data.displayStatus)
        return
      }
      setStatus('querying')
      timerRef.current.push(window.setTimeout(() => {
        setRunView(response.data)
        setStatus(response.data.displayStatus)
      }, 720))
    }, 460))
  }

  const cancelRun = () => {
    clearTimers()
    if (runView && (status === 'understanding' || status === 'querying' || status === 'needs_clarification')) {
      const response = serviceRef.current.cancelRun({
        runId: runView.runId,
        conversationId: runView.conversationId,
        actor: demoActor,
      })
      if (response.ok) setRunView(response.data)
    }
    setStatus('waiting_input')
  }

  const chooseClarification = (candidateId: string) => {
    const candidate = runView?.clarification?.candidates.find((item) => item.id === candidateId)
    if (!runView || !candidate) return
    setSubmittedQuestion(`${submittedQuestion}（${candidate.label}）`)
    setStatus('understanding')
    timerRef.current.push(window.setTimeout(() => {
      const response = serviceRef.current.clarifyRun({
        runId: runView.runId,
        conversationId: runView.conversationId,
        candidateId: candidate.id,
        candidateVersion: candidate.candidateVersion,
        actor: demoActor,
      })
      if (!response.ok) {
        setStatus('failed')
        return
      }
      setStatus('querying')
      timerRef.current.push(window.setTimeout(() => {
        setRunView(response.data)
        setStatus(response.data.displayStatus)
      }, 680))
    }, 420))
  }

  const exportCsv = () => {
    const rows = runView?.result?.rows
    const content = rows?.length
      ? ['月份,净收入', ...rows.map((row) => `${row.values.month ?? row.key},${row.values.net_revenue ?? ''}`)].join('\n')
      : ['月份,净收入（万元）', ...revenueData.map((row) => `${row.month},${row.revenue}`)].join('\n')
    const url = URL.createObjectURL(new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '净收入趋势_2025.csv'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const active = status === 'understanding' || status === 'querying'
  return (
    <main className="workspace">
      <header className="workspace-header">
        <button className="icon-button panel-toggle" onClick={onOpenSessions} aria-label="打开会话列表"><IconMenu2 size={20} /></button>
        <div className="workspace-heading">
          <span className="breadcrumb">经营分析 / 收入</span>
          <h1>{submittedQuestion || '新建分析'}</h1>
        </div>
        <div className="header-actions">
          <button className="domain-button">销售经营 <IconChevronDown size={15} /></button>
          <span className="mode-badge"><IconShieldCheck size={15} /> 可信模式</span>
          <button className="icon-button context-toggle" onClick={onOpenContext} aria-label="打开分析上下文"><IconLayoutSidebarRightCollapse size={19} /></button>
        </div>
      </header>

      <div className="timeline" aria-live="polite">
        {!submittedQuestion && status === 'waiting_input' ? <Welcome onExample={runQuestion} /> : (
          <div className="timeline-content">
            <div className="user-question">
              <div className="question-avatar">你</div>
              <p>{submittedQuestion}</p>
            </div>
            {status !== 'waiting_input' && <RunStage status={status} />}
            {status === 'needs_clarification' && <Clarification clarification={runView?.clarification} onChoose={chooseClarification} />}
            {status === 'failed' && <PermissionFailure requestId={runView?.requestId} onRetry={() => setQuestion('仅查看我有权限的业务域汇总')} />}
            {status === 'completed' && (
              <AnswerResult
                runView={runView}
                view={resultView}
                onView={setResultView}
                onExport={exportCsv}
                feedback={feedback}
                onFeedback={setFeedback}
                onFollowup={(value) => runQuestion(value)}
              />
            )}
          </div>
        )}
      </div>

      <Composer
        value={question}
        onChange={setQuestion}
        onSubmit={() => runQuestion()}
        active={active}
        onCancel={cancelRun}
      />
    </main>
  )
}

function Welcome({ onExample }: { onExample: (question: string) => void }) {
  return (
    <section className="welcome">
      <div className="welcome-icon"><IconSparkles size={24} /></div>
      <h2>从一个经营问题开始</h2>
      <p>我会先核对指标口径、权限和时间范围，再返回可追溯的结果。</p>
      <div className="example-list">
        <button onClick={() => onExample('上月净收入是多少？')}>上月净收入是多少？</button>
        <button onClick={() => onExample('上季度净收入最高的 10 个区域')}>上季度净收入最高的 10 个区域</button>
        <button onClick={() => onExample('过去 12 个完整自然月净收入趋势')}>过去 12 个完整自然月净收入趋势</button>
      </div>
    </section>
  )
}

function RunStage({ status }: { status: RunStatus }) {
  const failed = status === 'failed'
  const warning = status === 'needs_clarification'
  return (
    <div className={`run-stage ${failed ? 'danger' : warning ? 'warning' : status === 'completed' ? 'success' : 'info'}`}>
      <div className="stage-icon">
        {failed ? <IconCircleX size={19} /> : status === 'completed' ? <IconCheck size={19} /> : warning ? <IconHelp size={19} /> : <span className="progress-orbit" />}
      </div>
      <div>
        <strong>{statusCopy[status]}</strong>
        <span>{status === 'understanding' ? '正在匹配指标、维度与权限' : status === 'querying' ? '安全校验通过，正在执行只读查询' : status === 'completed' ? '结果、口径与来源已就绪' : warning ? '关键条件有多个有效解释，尚未执行查询' : '请求已安全终止'}</span>
      </div>
    </div>
  )
}

function Clarification({ clarification, onChoose }: { clarification?: PublicRunView['clarification']; onChoose: (candidateId: string) => void }) {
  const candidates = clarification?.candidates ?? []
  return (
    <section className="clarification-card">
      <div className="card-heading">
        <div><IconHelp size={20} /><h2>{clarification?.prompt ?? '需要确认口径'}</h2></div>
        <span>查询尚未执行</span>
      </div>
      <p>请选择分析指标和时间范围。该选择会记录在本次分析的默认条件中。</p>
      <div className="clarification-options">
        {candidates.map((candidate) => (
          <button key={candidate.id} onClick={() => onChoose(candidate.id)}>
            <strong>{candidate.label}</strong>
            <span>{candidate.description}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function PermissionFailure({ requestId, onRetry }: { requestId?: string; onRetry: () => void }) {
  return (
    <section className="failure-card">
      <IconShieldCheck size={22} />
      <div>
        <h2>无法访问该范围</h2>
        <p>当前请求超出你的数据权限。为避免泄露资源是否存在，系统不会展示候选值或相关明细。</p>
        <div className="failure-actions">
          <button className="secondary-button" onClick={onRetry}>修改为已授权范围</button>
          <button className="text-button">查看访问申请流程</button>
        </div>
        <span className="audit-note">安全事件已记录 · request_id {requestId ?? 'req_local'}</span>
      </div>
    </section>
  )
}

function AnswerResult({ runView, view, onView, onExport, feedback, onFeedback, onFollowup }: {
  runView: PublicRunView | null
  view: ResultView
  onView: (view: ResultView) => void
  onExport: () => void
  feedback: 'up' | 'down' | null
  onFeedback: (value: 'up' | 'down') => void
  onFollowup: (value: string) => void
}) {
  const headline = runView?.result?.answer.headline ?? '净收入全年保持增长，四季度增速进一步扩大'
  const summary = runView?.result?.answer.summary ?? '过去 12 个完整自然月净收入合计 1.35 亿元。12 月达到 1,486 万元，较 1 月增长 79.9%。'
  const freshness = runView?.result?.freshnessAt ?? '2026-06-22 08:12'
  const semanticVersion = runView?.semanticVersion ?? 'sales@2026.06.3'
  return (
    <article className="answer-card">
      <div className="answer-header">
        <div>
          <span className="answer-label">分析结论</span>
          <h2>{headline}</h2>
          <p>{summary}</p>
        </div>
        <button className="secondary-button export-button" onClick={onExport}><IconDownload size={17} /> 导出 CSV</button>
      </div>

      <div className="assumption-strip">
        <IconShieldCheck size={18} />
        <span><strong>采用条件：</strong>已完成订单 · 中国区 · 2025-01-01 至 2025-12-31 · Asia/Shanghai</span>
      </div>

      <div className="kpi-row">
        <div><span>净收入合计</span><strong>1.35 亿元</strong><em>认证指标</em></div>
        <div><span>同比增长</span><strong className="positive"><IconArrowUp size={18} /> 18.6%</strong><em>较上年同期</em></div>
        <div><span>12 月净收入</span><strong>1,486 万元</strong><em>本周期最高</em></div>
      </div>

      <div className="result-toolbar" role="tablist" aria-label="结果视图">
        <button role="tab" aria-selected={view === 'chart'} className={view === 'chart' ? 'active' : ''} onClick={() => onView('chart')}><IconChartLine size={17} /> 趋势图</button>
        <button role="tab" aria-selected={view === 'table'} className={view === 'table' ? 'active' : ''} onClick={() => onView('table')}><IconTable size={17} /> 数据表</button>
        <button role="tab" aria-selected={view === 'evidence'} className={view === 'evidence' ? 'active' : ''} onClick={() => onView('evidence')}><IconShieldCheck size={17} /> 口径与来源</button>
      </div>

      {view === 'chart' && <RevenueChart />}
      {view === 'table' && <RevenueTable />}
      {view === 'evidence' && <EvidencePanel />}

      <div className="followups">
        <span>继续分析</span>
        <div>
          <button onClick={() => onFollowup('按区域下钻净收入趋势')}>按区域下钻</button>
          <button onClick={() => onFollowup('对比上年同期净收入')}>对比上年同期</button>
          <button onClick={() => onFollowup('解释 3 月和 8 月的变化')}>解释关键变化</button>
        </div>
      </div>

      <footer className="answer-footer">
        <span>数据更新于 {freshness} · 语义版本 {semanticVersion}</span>
        <div>
          <span>{feedback ? '感谢反馈' : '这个结果有帮助吗？'}</span>
          <button className={feedback === 'up' ? 'icon-button selected' : 'icon-button'} onClick={() => onFeedback('up')} aria-label="结果有帮助"><IconThumbUp size={16} /></button>
          <button className={feedback === 'down' ? 'icon-button selected' : 'icon-button'} onClick={() => onFeedback('down')} aria-label="结果无帮助"><IconThumbDown size={16} /></button>
        </div>
      </footer>
    </article>
  )
}

function RevenueChart() {
  return (
    <div className="chart-wrap" aria-label="2025 年净收入月度趋势图">
      <ResponsiveContainer width="100%" height={286} minWidth={0}>
        <LineChart data={revenueData} margin={{ top: 16, right: 16, left: 4, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="#E4E9F0" strokeDasharray="3 3" />
          <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#667085', fontSize: 12 }} />
          <YAxis axisLine={false} tickLine={false} width={42} tick={{ fill: '#667085', fontSize: 12 }} unit="万" />
          <Tooltip contentStyle={{ border: '1px solid #E4E9F0', borderRadius: 8, boxShadow: '0 8px 24px rgba(16,24,40,.12)' }} formatter={(value) => [`${value} 万元`, '净收入']} />
          <Line type="monotone" dataKey="revenue" stroke="#146EF5" strokeWidth={2.5} dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} activeDot={{ r: 5 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function RevenueTable() {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th>月份</th><th>净收入（万元）</th><th>环比</th><th>结果引用</th></tr></thead>
        <tbody>{revenueData.map((row, index) => <tr key={row.month}><td>2025-{String(index + 1).padStart(2, '0')}</td><td>{row.revenue.toLocaleString()}</td><td>{index === 0 ? '-' : `${(((row.revenue / revenueData[index - 1].revenue) - 1) * 100).toFixed(1)}%`}</td><td><code>result.month[{index}]</code></td></tr>)}</tbody>
      </table>
    </div>
  )
}

function EvidencePanel() {
  return (
    <div className="evidence-grid">
      <section><span>指标口径</span><strong>净收入</strong><p>已完成订单实付金额，扣除退款、折扣与税费。</p></section>
      <section><span>数据来源</span><strong>销售经营主题域</strong><p>dwd_order_settlement · 每日 08:00 更新</p></section>
      <section><span>语义与权限</span><strong>sales@2026.06.3</strong><p>中国区经营分析角色 · 行级策略 cn_business_scope</p></section>
      <section><span>执行记录</span><strong>只读查询已校验</strong><p>trace_id tr_8c2f04 · 扫描 48.2 MB · 1.4 秒</p></section>
    </div>
  )
}

function Composer({ value, onChange, onSubmit, active, onCancel }: { value: string; onChange: (value: string) => void; onSubmit: () => void; active: boolean; onCancel: () => void }) {
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              if (!active) onSubmit()
            }
          }}
          placeholder="基于当前结果继续追问..."
          aria-label="输入分析问题"
          rows={1}
          disabled={active}
        />
        {active ? (
          <button className="stop-button" onClick={onCancel}><IconPlayerStop size={17} /> 停止</button>
        ) : (
          <button className="send-button" onClick={onSubmit} disabled={!value.trim()} aria-label="开始分析"><IconSend2 size={19} /></button>
        )}
      </div>
      <span className="composer-hint">Enter 发送，Shift + Enter 换行 · 只查询已授权的受治理数据</span>
    </div>
  )
}

function ContextPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = [
    ['业务域', '销售经营'],
    ['模式', '可信模式'],
    ['指标', '净收入'],
    ['维度', '自然月'],
    ['时间', '2025 全年'],
    ['过滤', '已完成订单 · 中国区'],
    ['语义版本', 'sales@2026.06.3'],
    ['数据源', '经营数仓 / 销售主题域'],
  ]
  return (
    <aside className={open ? 'context-panel open' : 'context-panel'} aria-label="分析上下文">
      <div className="context-header"><div><IconAdjustments size={19} /><strong>分析上下文</strong></div><button className="icon-button context-close" onClick={onClose} aria-label="关闭上下文"><IconX size={18} /></button></div>
      <div className="context-status"><IconCheck size={17} /><span>约束已通过校验</span></div>
      <dl>{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      <div className="context-section">
        <span>采用的默认条件</span>
        <p>工作区时区：Asia/Shanghai</p>
        <p>完整自然月，不含当月</p>
      </div>
      <button className="secondary-button full-width">修改分析条件</button>
    </aside>
  )
}

export function App() {
  const [page, setPage] = useState<Page>('workbench')
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [resetKey, setResetKey] = useState(0)

  const FeaturePage = useMemo(() => {
    if (page === 'workbench') return null
    if (page === 'semantic') {
      return <SemanticGovernance metrics={governanceMetrics} dimensions={governanceDimensions} canEdit canApprove onCreateMetric={() => undefined} onSaveMetric={() => undefined} onRequestApproval={() => undefined} />
    }
    if (page === 'dataSources') return <DataSourceCenter />
    return <OperationsCenter />
  }, [page])

  return (
    <div className={`app-shell page-${page}`}>
      <GlobalRail page={page} onPage={setPage} onOpenMenu={() => setSessionsOpen(true)} />
      {page === 'workbench' && <SessionList open={sessionsOpen} onClose={() => setSessionsOpen(false)} onNew={() => { setResetKey((value) => value + 1); setSessionsOpen(false) }} />}
      {page === 'workbench' ? <Workbench onOpenSessions={() => setSessionsOpen(true)} onOpenContext={() => setContextOpen(true)} resetKey={resetKey} /> : FeaturePage}
      {page === 'workbench' && <ContextPanel open={contextOpen} onClose={() => setContextOpen(false)} />}
      {(sessionsOpen || contextOpen) && <button className="scrim" aria-label="关闭侧栏" onClick={() => { setSessionsOpen(false); setContextOpen(false) }} />}
    </div>
  )
}
