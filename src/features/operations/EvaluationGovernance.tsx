import { useEffect, useMemo, useRef, useState } from 'react'
import {
  IconCheck,
  IconChevronRight,
  IconClock,
  IconFilter,
  IconPlayerPlay,
  IconSearch,
  IconShieldCheck,
  IconX,
} from '@tabler/icons-react'
import {
  createEvaluationApplicationService,
  type EvaluationApplicationService,
} from '../../application/evaluation'
import type {
  ActorContext,
  GoldenSampleStatus,
  GoldenSampleView,
  RegressionRunPlanView,
} from '../../contracts'

export type EvaluationGovernanceView = 'golden' | 'regressions'

const evaluationActor: ActorContext = {
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  userId: 'user_ops',
  roles: ['platform_ops', 'analyst'],
  businessDomainId: 'sales',
  semanticVersion: 'sales-semantic-2026.06.1',
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
}

const intentLabels: Record<GoldenSampleView['expectedIntent'], string> = {
  trend: '趋势',
  breakdown: '拆分',
  ranking: '排名',
  lookup: '指标查询',
  clarification: '澄清',
  empty_check: '空结果',
}

const statusLabels: Record<GoldenSampleStatus, string> = {
  new: '新建',
  triaged: '已分诊',
  in_review: '审核中',
  resolved: '已解决',
  rejected: '已拒绝',
  candidate_dataset: '候选集',
  golden_approved: '黄金集',
}

export function EvaluationGovernance({ activeView }: { activeView: EvaluationGovernanceView }) {
  const serviceRef = useRef<EvaluationApplicationService>(
    createEvaluationApplicationService({
      now: () => '2026-06-25T09:30:00+08:00',
      seedGoldenSamples: true,
    }),
  )
  const [samples, setSamples] = useState<GoldenSampleView[]>(() => listSamples(serviceRef.current))
  const [regressions, setRegressions] = useState<RegressionRunPlanView[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | GoldenSampleStatus>('all')
  const [domain, setDomain] = useState('all')
  const [tag, setTag] = useState('all')
  const [selectedSample, setSelectedSample] = useState<GoldenSampleView | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [candidateVersion, setCandidateVersion] = useState('planner-3.3-rc2')
  const [notice, setNotice] = useState('')
  const inspectorTriggerRef = useRef<HTMLButtonElement | null>(null)

  const filteredSamples = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return samples.filter((sample) => {
      const matchesQuery = !normalized || [
        sample.id,
        sample.sourceRunId,
        sample.sanitizedQuestion,
        sample.expectedIntent,
        ...sample.tags,
      ].some((value) => value.toLowerCase().includes(normalized))
      const matchesStatus = status === 'all' || sample.status === status
      const matchesDomain = domain === 'all' || sample.domain === domain
      const matchesTag = tag === 'all' || sample.tags.includes(tag)
      return matchesQuery && matchesStatus && matchesDomain && matchesTag
    })
  }, [domain, query, samples, status, tag])

  useEffect(() => {
    setSelectedIds((current) => {
      const visible = current.filter((id) => filteredSamples.some((sample) => sample.id === id))
      return visible.length === current.length ? current : visible
    })
  }, [filteredSamples])

  const approvedSamples = samples.filter((sample) => sample.status === 'golden_approved')
  const selectedApprovedIds = selectedIds.filter((id) => (
    approvedSamples.some((sample) => sample.id === id)
  ))
  const domains = [...new Set(samples.map((sample) => sample.domain))]
  const tags = [...new Set(samples.flatMap((sample) => sample.tags))]

  const refreshSamples = () => {
    setSamples(listSamples(serviceRef.current))
  }

  const refreshRegressions = () => {
    const response = serviceRef.current.listRegressionRuns({ actor: evaluationActor })
    if (response.ok) setRegressions(response.data.items)
  }

  const scheduleRegression = () => {
    const response = serviceRef.current.scheduleRegressionRun({
      actor: evaluationActor,
      candidateVersion: candidateVersion.trim(),
      sampleIds: selectedApprovedIds.length > 0 ? selectedApprovedIds : undefined,
    })
    if (!response.ok) {
      setNotice(`回归未调度：${response.error.message}`)
      return
    }
    refreshRegressions()
    setNotice(
      `回归 ${response.data.id} 已排队，覆盖 ${response.data.sampleCount} 条黄金样本；不使用生产凭据并关联发布门。`,
    )
  }

  const openSample = (sample: GoldenSampleView, trigger: HTMLButtonElement) => {
    inspectorTriggerRef.current = trigger
    setSelectedSample(sample)
  }

  const closeSample = () => {
    setSelectedSample(null)
    window.requestAnimationFrame(() => inspectorTriggerRef.current?.focus())
  }

  const approveSample = (note: string) => {
    if (!selectedSample) return
    const response = serviceRef.current.approveGoldenSample({
      actor: evaluationActor,
      sampleId: selectedSample.id,
      note,
    })
    if (!response.ok) {
      setNotice(`审批未完成：${response.error.message}`)
      return
    }
    refreshSamples()
    setSelectedSample(response.data)
    setNotice(`样本 ${response.data.id} 已批准进入黄金集，可用于候选版本回归。`)
  }

  return (
    <div className="evaluation-governance">
      <div className="evaluation-governance__live" role="status" aria-live="polite">{notice}</div>
      {activeView === 'golden' && (
        <section
          className="operations__panel evaluation-governance__panel"
          aria-labelledby="golden-samples-title"
        >
        <div className="operations__panel-header operations__panel-header--wrap">
          <div>
            <h2 id="golden-samples-title">黄金集样本</h2>
            <p>线上样本先脱敏、去重并人工标注，再审批进入发布回归集</p>
          </div>
          <span className="evaluation-governance__count">共 {filteredSamples.length} 条</span>
        </div>

        <div className="evaluation-toolbar" aria-label="黄金样本筛选">
          <label className="operations__search">
            <IconSearch size={17} aria-hidden="true" />
            <span className="operations__sr-only">搜索黄金样本</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索问题、样本 ID 或标签" />
          </label>
          <label className="operations__compact-select">
            <IconFilter size={16} aria-hidden="true" />
            <span className="operations__sr-only">黄金样本状态</span>
            <select value={status} onChange={(event) => setStatus(event.target.value as 'all' | GoldenSampleStatus)}>
              <option value="all">全部状态</option>
              <option value="candidate_dataset">候选集</option>
              <option value="golden_approved">黄金集</option>
            </select>
          </label>
          <label className="operations__compact-select">
            <span className="operations__sr-only">黄金样本业务域</span>
            <select value={domain} onChange={(event) => setDomain(event.target.value)}>
              <option value="all">全部业务域</option>
              {domains.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <label className="operations__compact-select">
            <span className="operations__sr-only">黄金样本标签</span>
            <select value={tag} onChange={(event) => setTag(event.target.value)}>
              <option value="all">全部场景</option>
              {tags.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          {(query || status !== 'all' || domain !== 'all' || tag !== 'all') && (
            <button
              className="operations__text-button"
              type="button"
              onClick={() => {
                setQuery('')
                setStatus('all')
                setDomain('all')
                setTag('all')
              }}
            >
              清除筛选
            </button>
          )}
        </div>

        {selectedApprovedIds.length > 0 && (
          <div className="evaluation-selection" role="status">
            <span>已选 {selectedApprovedIds.length} 条黄金样本</span>
            <button className="operations__text-button" type="button" onClick={() => setSelectedIds([])}>清除选择</button>
          </div>
        )}

        <div className="operations__table-wrap evaluation-table-wrap">
          <table className="operations__table evaluation-table">
            <caption className="operations__sr-only">黄金集样本列表</caption>
            <thead>
              <tr>
                <th scope="col"><span className="operations__sr-only">选择</span></th>
                <th scope="col">脱敏问题</th>
                <th scope="col">场景与业务域</th>
                <th scope="col">期望标注</th>
                <th scope="col">质量门禁</th>
                <th scope="col">生命周期</th>
                <th scope="col">语义版本</th>
                <th scope="col"><span className="operations__sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody>
              {filteredSamples.map((sample) => {
                const isApproved = sample.status === 'golden_approved'
                return (
                  <tr key={sample.id}>
                    <td data-label="选择">
                      <input
                        className="evaluation-checkbox"
                        type="checkbox"
                        aria-label={`选择样本 ${sample.id}`}
                        disabled={!isApproved}
                        checked={selectedIds.includes(sample.id)}
                        onChange={() => setSelectedIds((current) => (
                          current.includes(sample.id)
                            ? current.filter((id) => id !== sample.id)
                            : [...current, sample.id]
                        ))}
                      />
                    </td>
                    <td data-label="脱敏问题">
                      <button
                        className="operations__question-link evaluation-question"
                        type="button"
                        onClick={(event) => openSample(sample, event.currentTarget)}
                      >
                        {sample.sanitizedQuestion}
                      </button>
                      <span className="evaluation-sample-id">{sample.id} · {sample.sourceRunId}</span>
                    </td>
                    <td data-label="场景与业务域">
                      <strong>{sample.tags[0] ?? '未分类'}</strong>
                      <span>{sample.domain}</span>
                    </td>
                    <td data-label="期望标注">
                      <strong>{intentLabels[sample.expectedIntent]}</strong>
                      <span>{sample.expectedMetricIds.length} 指标 · {sample.expectedDimensionIds.length} 维度</span>
                    </td>
                    <td data-label="质量门禁">
                      <span className="evaluation-quality"><IconShieldCheck size={15} aria-hidden="true" /> 4/4 通过</span>
                    </td>
                    <td data-label="生命周期">
                      <span className={`operations__badge ${isApproved ? 'operations__badge--success' : 'operations__badge--partial'}`}>
                        {isApproved ? <IconCheck size={14} aria-hidden="true" /> : <IconClock size={14} aria-hidden="true" />}
                        {statusLabels[sample.status]}
                      </span>
                    </td>
                    <td data-label="语义版本"><code>{sample.semanticVersion}</code></td>
                    <td data-label="操作">
                      <button
                        className="operations__icon-button"
                        type="button"
                        aria-label={`查看样本 ${sample.id}`}
                        onClick={(event) => openSample(sample, event.currentTarget)}
                      >
                        <IconChevronRight size={17} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {filteredSamples.length === 0 && (
            <div className="operations__empty">
              <strong>没有匹配的黄金样本</strong>
              <span>调整条件或清除筛选后重试。</span>
            </div>
          )}
        </div>
        </section>
      )}

      {activeView === 'regressions' && (
        <section
          className="operations__panel evaluation-governance__panel"
          aria-labelledby="regression-runs-title"
        >
        <div className="operations__panel-header operations__panel-header--wrap">
          <div>
            <h2 id="regression-runs-title">批量回归运行</h2>
            <p>仅使用已审批黄金样本，依次验证检索、规划、编译、查询网关和答案依据</p>
          </div>
          <span className="evaluation-governance__count">已批准 {approvedSamples.length} 条</span>
        </div>
        <div className="regression-scheduler">
          <label>
            <span>候选版本</span>
            <input value={candidateVersion} onChange={(event) => setCandidateVersion(event.target.value)} />
          </label>
          <div className="regression-scheduler__scope">
            <strong>{selectedApprovedIds.length > 0 ? `当前选择 ${selectedApprovedIds.length} 条` : `全部已批准 ${approvedSamples.length} 条`}</strong>
            <span>5 个确定性阶段 · 不使用生产凭据 · 关联发布门</span>
          </div>
          <button
            className="operations__button operations__button--primary"
            type="button"
            disabled={!candidateVersion.trim() || approvedSamples.length === 0}
            onClick={scheduleRegression}
          >
            <IconPlayerPlay size={17} aria-hidden="true" />
            调度回归
          </button>
        </div>
        <div className="operations__table-wrap evaluation-table-wrap">
          <table className="operations__table evaluation-table evaluation-table--regressions">
            <caption className="operations__sr-only">批量回归运行列表</caption>
            <thead>
              <tr>
                <th scope="col">运行 ID</th>
                <th scope="col">候选版本</th>
                <th scope="col">状态</th>
                <th scope="col">样本</th>
                <th scope="col">阶段</th>
                <th scope="col">发起人</th>
                <th scope="col">创建时间</th>
              </tr>
            </thead>
            <tbody>
              {regressions.map((run) => (
                <tr key={run.id}>
                  <td data-label="运行 ID"><code>{run.id}</code></td>
                  <td data-label="候选版本">{run.candidateVersion}</td>
                  <td data-label="状态"><span className="operations__badge operations__badge--partial"><IconClock size={14} /> 排队中</span></td>
                  <td data-label="样本">{run.sampleCount}</td>
                  <td data-label="阶段">{run.completedStages.length}/{run.stages.length}</td>
                  <td data-label="发起人">{run.requestedBy}</td>
                  <td data-label="创建时间">{formatTimestamp(run.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {regressions.length === 0 && (
            <div className="operations__empty">
              <strong>还没有回归运行</strong>
              <span>确认候选版本和样本范围后调度第一条回归。</span>
            </div>
          )}
        </div>
        </section>
      )}

      {selectedSample && (
        <GoldenSampleInspector
          sample={selectedSample}
          onApprove={approveSample}
          onClose={closeSample}
        />
      )}
    </div>
  )
}

function GoldenSampleInspector({
  sample,
  onApprove,
  onClose,
}: {
  sample: GoldenSampleView
  onApprove: (note: string) => void
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLElement | null>(null)
  const canApprove = sample.status === 'candidate_dataset' && Object.values(sample.qualityGates).every(Boolean)

  useEffect(() => {
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="operations__drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside ref={dialogRef} className="operations__drawer evaluation-inspector" role="dialog" aria-modal="true" aria-labelledby="golden-sample-detail-title">
        <header>
          <div>
            <p>{sample.id}</p>
            <h2 id="golden-sample-detail-title">黄金样本详情</h2>
          </div>
          <button ref={closeRef} className="operations__icon-button" type="button" aria-label="关闭黄金样本详情" onClick={onClose}><IconX size={20} /></button>
        </header>
        <div className="operations__drawer-body">
          <span className={`operations__badge ${sample.status === 'golden_approved' ? 'operations__badge--success' : 'operations__badge--partial'}`}>
            {statusLabels[sample.status]}
          </span>
          <blockquote>{sample.sanitizedQuestion}</blockquote>
          <dl className="operations__detail-grid">
            <div><dt>来源 Run</dt><dd><code>{sample.sourceRunId}</code></dd></div>
            <div><dt>业务域</dt><dd>{sample.domain}</dd></div>
            <div><dt>期望意图</dt><dd>{intentLabels[sample.expectedIntent]}</dd></div>
            <div><dt>语义版本</dt><dd>{sample.semanticVersion}</dd></div>
            <div><dt>指标</dt><dd>{sample.expectedMetricIds.join('、') || '无'}</dd></div>
            <div><dt>维度</dt><dd>{sample.expectedDimensionIds.join('、') || '无'}</dd></div>
          </dl>
          <section>
            <h3>场景标签</h3>
            <div className="evaluation-tags">{sample.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
          </section>
          <section>
            <h3>质量门禁</h3>
            <ul className="evaluation-gates">
              <li><IconCheck size={16} /> 已完成敏感信息脱敏</li>
              <li><IconCheck size={16} /> 已完成重复样本检查</li>
              <li><IconCheck size={16} /> 已完成人工标注复核</li>
              <li><IconCheck size={16} /> 已移除生产数据库凭据</li>
            </ul>
          </section>
          {sample.status === 'golden_approved' ? (
            <section>
              <h3>审批记录</h3>
              <p>{sample.approvedBy} · {sample.approvedAt ? formatTimestamp(sample.approvedAt) : '时间未记录'}</p>
            </section>
          ) : (
            <section className="evaluation-approval">
              <label>
                <span>审批说明</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={4} maxLength={500} placeholder="记录标注复核、边界条件和适用范围" />
              </label>
            </section>
          )}
        </div>
        <footer>
          <button className="operations__button operations__button--secondary" type="button" onClick={onClose}>关闭</button>
          {sample.status !== 'golden_approved' && (
            <button
              className="operations__button operations__button--primary"
              type="button"
              disabled={!canApprove || !note.trim()}
              onClick={() => onApprove(note.trim())}
            >
              <IconCheck size={17} />
              批准进入黄金集
            </button>
          )}
        </footer>
      </aside>
    </div>
  )
}

function listSamples(service: EvaluationApplicationService) {
  const response = service.listGoldenSamples({ actor: evaluationActor })
  return response.ok ? response.data.items : []
}

function formatTimestamp(value: string) {
  return value.replace('T', ' ').replace(/:00(?:\+08:00|Z)$/, '')
}

export default EvaluationGovernance
