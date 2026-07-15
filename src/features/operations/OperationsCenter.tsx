import { useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconArrowDownRight,
  IconArrowUpRight,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconFilter,
  IconFlask,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconShieldLock,
  IconSparkles,
  IconX,
} from "@tabler/icons-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  failureDistribution,
  gateMetrics,
  modelVersions,
  overviewMetrics,
  replayRuns,
  sloItems,
  trendData,
  type ReplayRun,
  type RunStatus,
} from "./fixtures";
import { EvaluationGovernance, type EvaluationGovernanceView } from "./EvaluationGovernance";
import "./operations.css";

type Period = "7d" | "30d" | "90d";
type OperationsSection = "overview" | EvaluationGovernanceView | "replays";

const operationsSections: Array<{ id: OperationsSection; label: string }> = [
  { id: "overview", label: "总览" },
  { id: "golden", label: "黄金集" },
  { id: "regressions", label: "回归运行" },
  { id: "replays", label: "失败回放" },
];

const statusLabels: Record<RunStatus, string> = {
  failed: "失败",
  partial: "部分结果",
  blocked: "已阻断",
};

const statusIcons: Record<RunStatus, typeof IconAlertTriangle> = {
  failed: IconAlertTriangle,
  partial: IconClock,
  blocked: IconShieldLock,
};

export function OperationsCenter() {
  const [period, setPeriod] = useState<Period>("7d");
  const [domain, setDomain] = useState("all");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | RunStatus>("all");
  const [selectedRun, setSelectedRun] = useState<ReplayRun | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeSection, setActiveSection] = useState<OperationsSection>("overview");

  const filteredRuns = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return replayRuns.filter((run) => {
      const matchesDomain = domain === "all" || run.domain === domain;
      const matchesStatus = status === "all" || run.status === status;
      const matchesQuery =
        !normalized ||
        run.question.toLowerCase().includes(normalized) ||
        run.id.toLowerCase().includes(normalized) ||
        run.reason.toLowerCase().includes(normalized);
      return matchesDomain && matchesStatus && matchesQuery;
    });
  }, [domain, query, status]);

  const refresh = () => {
    setIsRefreshing(true);
    window.setTimeout(() => setIsRefreshing(false), 700);
  };

  const failedGateCount = gateMetrics.filter((metric) => metric.result === "fail").length;

  return (
    <main className="operations" aria-labelledby="operations-title">
      <header className="operations__header">
        <div>
          <p className="operations__eyebrow">运营与评测中心</p>
          <h1 id="operations-title">生产质量总览</h1>
          <p className="operations__subtitle">监控准确率、发布门禁、失败样本与服务目标</p>
        </div>
        <div className="operations__header-actions">
          <label className="operations__field-label">
            <span>时间范围</span>
            <select value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
              <option value="7d">过去 7 天</option>
              <option value="30d">过去 30 天</option>
              <option value="90d">过去 90 天</option>
            </select>
          </label>
          <button className="operations__button operations__button--secondary" type="button" onClick={refresh}>
            <IconRefresh size={17} className={isRefreshing ? "operations__spin" : undefined} aria-hidden="true" />
            {isRefreshing ? "刷新中" : "刷新数据"}
          </button>
        </div>
      </header>

      <div className="operations__tabs" role="tablist" aria-label="运营中心任务">
        {operationsSections.map((section, index) => (
          <button
            id={`operations-tab-${section.id}`}
            key={section.id}
            role="tab"
            type="button"
            aria-selected={activeSection === section.id}
            aria-controls={activeSection === section.id ? `operations-panel-${section.id}` : undefined}
            tabIndex={activeSection === section.id ? 0 : -1}
            onClick={() => setActiveSection(section.id)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const direction = event.key === "ArrowRight" ? 1 : -1;
              const next = operationsSections[(index + direction + operationsSections.length) % operationsSections.length];
              setActiveSection(next.id);
              window.requestAnimationFrame(() => document.getElementById(`operations-tab-${next.id}`)?.focus());
            }}
          >
            {section.label}
          </button>
        ))}
      </div>

      {activeSection === "overview" && (
        <div id="operations-panel-overview" role="tabpanel" aria-labelledby="operations-tab-overview">
      <section className="operations__metric-grid" aria-label="运营核心指标">
        {overviewMetrics.map((metric) => {
          const DeltaIcon = metric.delta.startsWith("+") ? IconArrowUpRight : IconArrowDownRight;
          return (
            <article className="operations__metric" key={metric.label}>
              <p>{metric.label}</p>
              <div className="operations__metric-row">
                <strong>{metric.value}</strong>
                <span className={`operations__delta operations__delta--${metric.tone}`}>
                  <DeltaIcon size={14} aria-hidden="true" />
                  {metric.delta}
                </span>
              </div>
              <small>较上一周期</small>
            </article>
          );
        })}
      </section>

      <div className="operations__two-column">
        <section className="operations__panel operations__panel--gate" aria-labelledby="gate-title">
          <div className="operations__panel-header">
            <div>
              <h2 id="gate-title">黄金集发布门禁</h2>
              <p>候选版本 planner-3.3-rc2 · 2,480 条样本</p>
            </div>
            <span className="operations__badge operations__badge--danger">
              <IconAlertTriangle size={15} aria-hidden="true" />
              {failedGateCount} 项未通过
            </span>
          </div>
          <div className="operations__gate-list">
            {gateMetrics.map((metric) => (
              <div className="operations__gate-row" key={metric.name}>
                <div className="operations__gate-copy">
                  <span>{metric.name}</span>
                  <small>门槛 ≥ {metric.target}%</small>
                </div>
                <div className="operations__progress" aria-label={`${metric.name} ${metric.value}%`}>
                  <span
                    className={metric.result === "pass" ? "is-pass" : "is-fail"}
                    style={{ width: `${Math.min(metric.value, 100)}%` }}
                  />
                </div>
                <strong className={metric.result === "pass" ? "is-pass" : "is-fail"}>{metric.value}%</strong>
                <span className={`operations__gate-result operations__gate-result--${metric.result}`}>
                  {metric.result === "pass" ? <IconCheck size={15} /> : <IconX size={15} />}
                  {metric.result === "pass" ? "通过" : "阻断"}
                </span>
              </div>
            ))}
          </div>
          <div className="operations__gate-footer">
            <span>澄清召回率低于门槛 1.3%，当前版本不可发布。</span>
            <button className="operations__text-button" type="button">查看完整报告 <IconChevronRight size={15} /></button>
          </div>
        </section>

        <section className="operations__panel" aria-labelledby="trend-title">
          <div className="operations__panel-header">
            <div>
              <h2 id="trend-title">质量趋势</h2>
              <p>执行准确率与完整答案延迟</p>
            </div>
            <span className="operations__badge operations__badge--success"><IconCheck size={15} /> 稳定</span>
          </div>
          <div className="operations__chart" role="img" aria-label="过去七天执行准确率从 95.1% 上升至 96.4%">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <AreaChart data={trendData} margin={{ top: 12, right: 8, bottom: 0, left: -18 }}>
                <defs>
                  <linearGradient id="accuracyFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#146EF5" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="#146EF5" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#EEF1F5" vertical={false} />
                <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fill: "#667085", fontSize: 11 }} />
                <YAxis domain={[94, 98]} axisLine={false} tickLine={false} tick={{ fill: "#667085", fontSize: 11 }} />
                <Tooltip contentStyle={{ border: "1px solid #E4E9F0", borderRadius: 8, fontSize: 12 }} formatter={(value) => [`${value}%`, "执行准确率"]} />
                <Area type="monotone" dataKey="accuracy" stroke="#146EF5" strokeWidth={2} fill="url(#accuracyFill)" activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      </div>

      <div className="operations__two-column operations__two-column--distribution">
        <section className="operations__panel" aria-labelledby="failure-title">
          <div className="operations__panel-header">
            <div>
              <h2 id="failure-title">失败分布</h2>
              <p>共 186 个失败或阻断请求</p>
            </div>
            <IconFlask size={20} aria-hidden="true" />
          </div>
          <div className="operations__distribution">
            <div className="operations__donut" role="img" aria-label="失败分布：实体链接 34%，数据源超时 26%，语义未命中 18%，权限阻断 13%，其他 9%">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <PieChart>
                  <Pie data={failureDistribution} dataKey="value" nameKey="name" innerRadius={48} outerRadius={70} paddingAngle={2}>
                    {failureDistribution.map((item) => <Cell key={item.name} fill={item.color} />)}
                  </Pie>
                  <Tooltip formatter={(value) => [`${value}%`, "占比"]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="operations__donut-label"><strong>186</strong><span>问题</span></div>
            </div>
            <ul className="operations__legend">
              {failureDistribution.map((item) => (
                <li key={item.name}><span style={{ background: item.color }} /> <span>{item.name}</span><strong>{item.value}%</strong></li>
              ))}
            </ul>
          </div>
        </section>

        <section className="operations__panel" aria-labelledby="models-title">
          <div className="operations__panel-header">
            <div>
              <h2 id="models-title">模型版本</h2>
              <p>生产版本与候选版本流量</p>
            </div>
            <IconSparkles size={20} aria-hidden="true" />
          </div>
          <div className="operations__model-list">
            {modelVersions.map((model) => (
              <div className="operations__model" key={model.name}>
                <div><strong>{model.name}</strong><span>{model.status}</span></div>
                <dl>
                  <div><dt>生产</dt><dd>{model.active}</dd></div>
                  <div><dt>候选</dt><dd>{model.candidate}</dd></div>
                  <div><dt>流量</dt><dd>{model.traffic}</dd></div>
                </dl>
              </div>
            ))}
          </div>
        </section>
      </div>
        </div>
      )}

      <div
        id={activeSection === "regressions" ? "operations-panel-regressions" : "operations-panel-golden"}
        role="tabpanel"
        aria-labelledby={activeSection === "regressions" ? "operations-tab-regressions" : "operations-tab-golden"}
        hidden={activeSection !== "golden" && activeSection !== "regressions"}
      >
        <EvaluationGovernance activeView={activeSection === "regressions" ? "regressions" : "golden"} />
      </div>

      {activeSection === "replays" && (
        <div id="operations-panel-replays" role="tabpanel" aria-labelledby="operations-tab-replays">
      <section className="operations__panel operations__replay" aria-labelledby="replay-title">
        <div className="operations__panel-header operations__panel-header--wrap">
          <div>
            <h2 id="replay-title">失败回放</h2>
            <p>检查问题、执行阶段和修复建议</p>
          </div>
          <div className="operations__filters">
            <label className="operations__search">
              <IconSearch size={17} aria-hidden="true" />
              <span className="operations__sr-only">搜索回放</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索问题或 Run ID" />
            </label>
            <label className="operations__compact-select">
              <IconFilter size={16} aria-hidden="true" />
              <span className="operations__sr-only">业务域</span>
              <select value={domain} onChange={(event) => setDomain(event.target.value)}>
                <option value="all">全部业务域</option>
                <option value="经营分析">经营分析</option>
                <option value="销售分析">销售分析</option>
                <option value="订单分析">订单分析</option>
              </select>
            </label>
            <label className="operations__compact-select">
              <span className="operations__sr-only">运行状态</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as "all" | RunStatus)}>
                <option value="all">全部状态</option>
                <option value="failed">失败</option>
                <option value="partial">部分结果</option>
                <option value="blocked">已阻断</option>
              </select>
            </label>
          </div>
        </div>
        <div className="operations__table-wrap">
          <table className="operations__table">
            <thead><tr><th>运行</th><th>问题</th><th>业务域</th><th>状态</th><th>失败阶段</th><th>时间</th><th><span className="operations__sr-only">操作</span></th></tr></thead>
            <tbody>
              {filteredRuns.map((run) => {
                const StatusIcon = statusIcons[run.status];
                return (
                  <tr key={run.id}>
                    <td><span className="operations__run-id">{run.id}</span></td>
                    <td><button className="operations__question-link" type="button" onClick={() => setSelectedRun(run)}>{run.question}</button></td>
                    <td>{run.domain}</td>
                    <td><span className={`operations__badge operations__badge--${run.status}`}><StatusIcon size={14} /> {statusLabels[run.status]}</span></td>
                    <td>{run.stage}</td>
                    <td>{run.timestamp}</td>
                    <td><button className="operations__icon-button" type="button" aria-label={`回放 ${run.id}`} onClick={() => setSelectedRun(run)}><IconPlayerPlay size={17} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredRuns.length === 0 && <div className="operations__empty">没有匹配的回放记录，请调整筛选条件。</div>}
        </div>
      </section>
        </div>
      )}

      {activeSection === "overview" && (
      <section className="operations__panel" aria-labelledby="slo-title">
        <div className="operations__panel-header">
          <div><h2 id="slo-title">SLO 状态</h2><p>当前滚动 30 天窗口</p></div>
          <span className="operations__badge operations__badge--success"><IconCheck size={15} /> 整体健康</span>
        </div>
        <div className="operations__slo-grid">
          {sloItems.map((item) => (
            <article className="operations__slo" key={item.name}>
              <div className={`operations__slo-icon operations__slo-icon--${item.state}`}>
                {item.state === "healthy" ? <IconCheck size={17} /> : <IconAlertTriangle size={17} />}
              </div>
              <div><p>{item.name}</p><strong>{item.value}</strong><small>目标 {item.target}</small></div>
            </article>
          ))}
        </div>
      </section>
      )}

      {selectedRun && <ReplayDetail run={selectedRun} onClose={() => setSelectedRun(null)} />}
    </main>
  );
}

function ReplayDetail({ run, onClose }: { run: ReplayRun; onClose: () => void }) {
  const StatusIcon = statusIcons[run.status];
  return (
    <div className="operations__drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="operations__drawer" role="dialog" aria-modal="true" aria-labelledby="replay-detail-title">
        <header>
          <div>
            <p>{run.id}</p>
            <h2 id="replay-detail-title">回放详情</h2>
          </div>
          <button className="operations__icon-button" type="button" aria-label="关闭回放详情" onClick={onClose}><IconX size={20} /></button>
        </header>
        <div className="operations__drawer-body">
          <span className={`operations__badge operations__badge--${run.status}`}><StatusIcon size={14} /> {statusLabels[run.status]}</span>
          <blockquote>{run.question}</blockquote>
          <dl className="operations__detail-grid">
            <div><dt>失败阶段</dt><dd>{run.stage}</dd></div>
            <div><dt>运行耗时</dt><dd>{run.duration}</dd></div>
            <div><dt>模型版本</dt><dd>{run.model}</dd></div>
            <div><dt>语义版本</dt><dd>{run.semanticVersion}</dd></div>
            <div><dt>Trace ID</dt><dd><code>{run.traceId}</code></dd></div>
          </dl>
          <section><h3>原因</h3><p>{run.reason}</p></section>
          <section><h3>SQL / 执行摘要</h3><p>{run.sqlSummary}</p></section>
          <section className="operations__resolution"><h3>建议处理</h3><p>{run.resolution}</p></section>
        </div>
        <footer>
          <button className="operations__button operations__button--secondary" type="button" onClick={onClose}>关闭</button>
          <button className="operations__button operations__button--primary" type="button"><IconPlayerPlay size={17} /> 使用候选版本重放</button>
        </footer>
      </aside>
    </div>
  );
}

export default OperationsCenter;
