import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconArchive,
  IconArrowsJoin,
  IconCertificate,
  IconChevronRight,
  IconCircleCheck,
  IconClockHour4,
  IconCode,
  IconDeviceFloppy,
  IconEdit,
  IconGitBranch,
  IconHistory,
  IconPlus,
  IconSearch,
  IconSend,
  IconShieldCheck,
  IconTag,
  IconUsers,
  IconX,
} from '@tabler/icons-react'
import type {
  ApprovalRequest,
  MetricDraft,
  MetricStatus,
  SemanticGovernanceProps,
  SemanticMetric,
} from './types'
import './semantic-governance.css'

const STATUS_META: Record<MetricStatus, { label: string; tone: string }> = {
  draft: { label: '草稿', tone: 'neutral' },
  review: { label: '评审中', tone: 'warning' },
  certified: { label: '已认证', tone: 'success' },
  deprecated: { label: '已弃用', tone: 'danger' },
  retired: { label: '已下线', tone: 'neutral' },
}

const STATUS_FILTERS: Array<{ value: 'all' | MetricStatus; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'certified', label: '已认证' },
  { value: 'review', label: '评审中' },
  { value: 'draft', label: '草稿' },
  { value: 'deprecated', label: '已弃用' },
]

function createDraft(metric: SemanticMetric): MetricDraft {
  return {
    name: metric.name,
    description: metric.description,
    formula: metric.formula,
    valueType: metric.valueType,
    unit: metric.unit ?? '',
    aggregation: metric.aggregation,
    owner: metric.owner,
    dimensionIds: metric.dimensions,
  }
}

function StatusBadge({ status }: { status: MetricStatus }) {
  const meta = STATUS_META[status]
  return (
    <span className={`semantic-status semantic-status--${meta.tone}`}>
      {status === 'certified' && <IconCertificate size={14} stroke={2} aria-hidden="true" />}
      {meta.label}
    </span>
  )
}

function EmptyMetrics({ onCreateMetric }: Pick<SemanticGovernanceProps, 'onCreateMetric'>) {
  return (
    <div className="semantic-empty">
      <IconArchive size={30} stroke={1.6} aria-hidden="true" />
      <strong>没有符合条件的指标</strong>
      <p>调整搜索或状态筛选，也可以创建一个新的指标草稿。</p>
      {onCreateMetric && (
        <button className="semantic-button semantic-button--secondary" type="button" onClick={onCreateMetric}>
          <IconPlus size={16} aria-hidden="true" />
          创建指标
        </button>
      )}
    </div>
  )
}

export function SemanticGovernance({
  metrics,
  dimensions,
  selectedMetricId,
  canEdit = false,
  canApprove = false,
  isSaving = false,
  onSelectMetric,
  onSaveMetric,
  onRequestApproval,
  onCreateMetric,
}: SemanticGovernanceProps) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | MetricStatus>('all')
  const [internalSelection, setInternalSelection] = useState(selectedMetricId ?? metrics[0]?.id)
  const [editing, setEditing] = useState(false)

  const activeId = selectedMetricId ?? internalSelection
  const activeMetric = metrics.find((metric) => metric.id === activeId) ?? metrics[0]

  const filteredMetrics = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return metrics.filter((metric) => {
      const matchesStatus = statusFilter === 'all' || metric.status === statusFilter
      const matchesQuery =
        !needle ||
        metric.name.toLocaleLowerCase('zh-CN').includes(needle) ||
        metric.code.toLocaleLowerCase('en-US').includes(needle) ||
        metric.owner.toLocaleLowerCase('zh-CN').includes(needle)
      return matchesStatus && matchesQuery
    })
  }, [metrics, query, statusFilter])

  const selectMetric = (metricId: string) => {
    setInternalSelection(metricId)
    setEditing(false)
    onSelectMetric?.(metricId)
  }

  return (
    <section className="semantic-page" aria-label="语义指标治理">
      <header className="semantic-page__header">
        <div>
          <div className="semantic-breadcrumb">语义层 <IconChevronRight size={14} /> 指标中心</div>
          <h1>指标治理</h1>
          <p>维护统一口径、可用维度和发布状态。认证指标将用于可信模式问答。</p>
        </div>
        {onCreateMetric && (
          <button className="semantic-button semantic-button--primary" type="button" onClick={onCreateMetric}>
            <IconPlus size={17} aria-hidden="true" />
            创建指标
          </button>
        )}
      </header>

      <div className="semantic-workspace">
        <aside className="semantic-catalog" aria-label="指标列表">
          <div className="semantic-catalog__tools">
            <label className="semantic-search">
              <IconSearch size={17} aria-hidden="true" />
              <span className="semantic-sr-only">搜索指标</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、编码或负责人" />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="清空搜索">
                  <IconX size={15} />
                </button>
              )}
            </label>
            <div className="semantic-filters" role="group" aria-label="按状态筛选">
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={statusFilter === filter.value ? 'is-active' : ''}
                  aria-pressed={statusFilter === filter.value}
                  onClick={() => setStatusFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
          </div>

          <div className="semantic-catalog__count">{filteredMetrics.length} 个指标</div>
          <div className="semantic-metric-list">
            {filteredMetrics.length ? (
              filteredMetrics.map((metric) => (
                <button
                  key={metric.id}
                  type="button"
                  className={`semantic-metric-row ${activeMetric?.id === metric.id ? 'is-selected' : ''}`}
                  onClick={() => selectMetric(metric.id)}
                >
                  <span className="semantic-metric-row__top">
                    <strong>{metric.name}</strong>
                    <StatusBadge status={metric.status} />
                  </span>
                  <span className="semantic-metric-row__code">{metric.code}</span>
                  <span className="semantic-metric-row__meta">
                    <span>{metric.domain}</span>
                    <span>v{metric.currentVersion}</span>
                    <span>{metric.owner}</span>
                  </span>
                </button>
              ))
            ) : (
              <EmptyMetrics onCreateMetric={onCreateMetric} />
            )}
          </div>
        </aside>

        <main className="semantic-detail">
          {activeMetric ? (
            <MetricDetail
              key={activeMetric.id}
              metric={activeMetric}
              dimensions={dimensions}
              editing={editing}
              canEdit={canEdit}
              canApprove={canApprove}
              isSaving={isSaving}
              onEditingChange={setEditing}
              onSaveMetric={onSaveMetric}
              onRequestApproval={onRequestApproval}
            />
          ) : (
            <div className="semantic-detail__empty">
              <IconTag size={32} stroke={1.5} aria-hidden="true" />
              <h2>选择一个指标查看口径</h2>
              <p>指标详情会展示公式、可用维度、依赖和完整版本记录。</p>
            </div>
          )}
        </main>
      </div>
    </section>
  )
}

interface MetricDetailProps {
  metric: SemanticMetric
  dimensions: SemanticGovernanceProps['dimensions']
  editing: boolean
  canEdit: boolean
  canApprove: boolean
  isSaving: boolean
  onEditingChange: (editing: boolean) => void
  onSaveMetric?: SemanticGovernanceProps['onSaveMetric']
  onRequestApproval?: SemanticGovernanceProps['onRequestApproval']
}

function MetricDetail({
  metric,
  dimensions,
  editing,
  canEdit,
  canApprove,
  isSaving,
  onEditingChange,
  onSaveMetric,
  onRequestApproval,
}: MetricDetailProps) {
  const [draft, setDraft] = useState<MetricDraft>(() => createDraft(metric))
  const [approvalNote, setApprovalNote] = useState('')
  const [approvalAction, setApprovalAction] = useState<ApprovalRequest['action'] | null>(null)
  const [activeTab, setActiveTab] = useState<'definition' | 'dependencies' | 'versions'>('definition')

  useEffect(() => {
    setDraft(createDraft(metric))
    setApprovalAction(null)
    setApprovalNote('')
  }, [metric])

  const changeDraft = <K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const cancelEditing = () => {
    setDraft(createDraft(metric))
    onEditingChange(false)
  }

  const save = async () => {
    await onSaveMetric?.(metric.id, draft)
    onEditingChange(false)
  }

  const requestApproval = async () => {
    if (!approvalAction) return
    await onRequestApproval?.({ metricId: metric.id, action: approvalAction, note: approvalNote.trim() })
    setApprovalAction(null)
    setApprovalNote('')
  }

  const approvalOptions: Array<{ action: ApprovalRequest['action']; label: string; icon: typeof IconSend }> = []
  if (metric.status === 'draft') approvalOptions.push({ action: 'submit_review', label: '提交评审', icon: IconSend })
  if (metric.status === 'review' && canApprove) approvalOptions.push({ action: 'certify', label: '认证并发布', icon: IconShieldCheck })
  if (metric.status === 'certified' && canApprove) approvalOptions.push({ action: 'deprecate', label: '弃用指标', icon: IconArchive })

  return (
    <div className="semantic-detail__inner">
      <header className="semantic-detail__header">
        <div>
          <div className="semantic-detail__title-line">
            <h2>{metric.name}</h2>
            <StatusBadge status={metric.status} />
          </div>
          <div className="semantic-detail__identity">
            <code>{metric.code}</code>
            <span>{metric.domain}</span>
            <span>v{metric.currentVersion}</span>
            <span>更新于 {metric.updatedAt}</span>
          </div>
        </div>
        <div className="semantic-detail__actions">
          {!editing && canEdit && metric.status !== 'retired' && (
            <button className="semantic-button semantic-button--secondary" type="button" onClick={() => onEditingChange(true)}>
              <IconEdit size={16} aria-hidden="true" />
              编辑指标
            </button>
          )}
          {editing && (
            <>
              <button className="semantic-button semantic-button--quiet" type="button" onClick={cancelEditing} disabled={isSaving}>
                取消
              </button>
              <button className="semantic-button semantic-button--primary" type="button" onClick={save} disabled={isSaving || !draft.name.trim() || !draft.formula.trim()}>
                <IconDeviceFloppy size={16} aria-hidden="true" />
                {isSaving ? '保存中…' : '保存更改'}
              </button>
            </>
          )}
        </div>
      </header>

      {metric.status === 'deprecated' && metric.deprecationNote && (
        <div className="semantic-notice semantic-notice--warning">
          <IconArchive size={18} aria-hidden="true" />
          <div><strong>该指标已弃用</strong><p>{metric.deprecationNote}</p></div>
        </div>
      )}

      <div className="semantic-tabs" role="tablist" aria-label="指标详情">
        <button type="button" role="tab" aria-selected={activeTab === 'definition'} onClick={() => setActiveTab('definition')}>
          <IconCode size={16} /> 定义与维度
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'dependencies'} onClick={() => setActiveTab('dependencies')}>
          <IconArrowsJoin size={16} /> 依赖关系 <span>{metric.dependencies.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === 'versions'} onClick={() => setActiveTab('versions')}>
          <IconHistory size={16} /> 版本历史 <span>{metric.versions.length}</span>
        </button>
      </div>

      {activeTab === 'definition' && (
        <div className="semantic-definition" role="tabpanel">
          <section className="semantic-section">
            <div className="semantic-section__heading">
              <h3>业务定义</h3>
              <p>用户在结果页看到的口径说明。</p>
            </div>
            <div className="semantic-form-grid">
              <Field label="指标名称" editing={editing} value={draft.name} onChange={(value) => changeDraft('name', value)} />
              <Field label="负责人" editing={editing} value={draft.owner} onChange={(value) => changeDraft('owner', value)} icon={<IconUsers size={16} />} />
              <Field label="业务说明" editing={editing} value={draft.description} onChange={(value) => changeDraft('description', value)} multiline wide />
              <SelectField label="聚合方式" editing={editing} value={draft.aggregation} onChange={(value) => changeDraft('aggregation', value as MetricDraft['aggregation'])} options={['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'derived']} />
              <SelectField label="数值类型" editing={editing} value={draft.valueType} onChange={(value) => changeDraft('valueType', value as MetricDraft['valueType'])} options={['currency', 'number', 'percentage', 'duration']} />
              <Field label="单位" editing={editing} value={draft.unit} onChange={(value) => changeDraft('unit', value)} />
            </div>
          </section>

          <section className="semantic-section">
            <div className="semantic-section__heading">
              <h3>口径公式</h3>
              <p>仅允许引用已登记字段或认证指标，发布前会执行类型与粒度校验。</p>
            </div>
            {editing ? (
              <label className="semantic-formula-editor">
                <span className="semantic-sr-only">口径公式</span>
                <textarea value={draft.formula} onChange={(event) => changeDraft('formula', event.target.value)} spellCheck={false} rows={5} />
              </label>
            ) : (
              <pre className="semantic-formula"><code>{metric.formula}</code></pre>
            )}
          </section>

          <section className="semantic-section">
            <div className="semantic-section__heading">
              <h3>可用维度</h3>
              <p>限定该指标可切分、筛选和下钻的分析粒度。</p>
            </div>
            <div className="semantic-dimensions">
              {dimensions.map((dimension) => {
                const checked = draft.dimensionIds.includes(dimension.id)
                return (
                  <label key={dimension.id} className={`semantic-dimension ${checked ? 'is-checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!editing}
                      onChange={(event) => changeDraft('dimensionIds', event.target.checked ? [...draft.dimensionIds, dimension.id] : draft.dimensionIds.filter((id) => id !== dimension.id))}
                    />
                    <span><strong>{dimension.name}</strong><small>{dimension.hierarchy ?? dimension.dataType}</small></span>
                    {checked && <IconCircleCheck size={17} aria-hidden="true" />}
                  </label>
                )
              })}
            </div>
          </section>
        </div>
      )}

      {activeTab === 'dependencies' && (
        <div className="semantic-dependency-list" role="tabpanel">
          {metric.dependencies.length ? metric.dependencies.map((dependency) => (
            <div className="semantic-dependency" key={`${dependency.type}-${dependency.id}`}>
              <span className="semantic-dependency__icon"><IconGitBranch size={18} aria-hidden="true" /></span>
              <div><strong>{dependency.name}</strong><code>{dependency.id}</code></div>
              <span className="semantic-type-badge">{dependency.type === 'metric' ? '指标' : dependency.type === 'dataset' ? '数据集' : '模型'}</span>
              {dependency.status && <StatusBadge status={dependency.status} />}
            </div>
          )) : <div className="semantic-inline-empty">此指标没有上游依赖。</div>}
        </div>
      )}

      {activeTab === 'versions' && (
        <div className="semantic-version-list" role="tabpanel">
          {metric.versions.map((version, index) => (
            <article className="semantic-version" key={version.version}>
              <div className="semantic-version__rail"><span>{index === 0 ? <IconCircleCheck size={16} /> : <IconClockHour4 size={15} />}</span></div>
              <div className="semantic-version__body">
                <div><strong>v{version.version}</strong><StatusBadge status={version.status} /><time>{version.changedAt}</time></div>
                <p>{version.summary}</p>
                <small>{version.changedBy}</small>
              </div>
            </article>
          ))}
        </div>
      )}

      {approvalOptions.length > 0 && onRequestApproval && !editing && (
        <section className="semantic-approval">
          <div className="semantic-approval__intro">
            <IconShieldCheck size={21} aria-hidden="true" />
            <div><h3>发布与审批</h3><p>{metric.status === 'draft' ? '提交后将锁定当前版本，等待指标管理员评审。' : metric.status === 'review' ? '认证后，该版本将进入可信模式。' : '弃用不会影响历史回放，但新问题将优先推荐替代指标。'}</p></div>
          </div>
          {!approvalAction ? (
            <div className="semantic-approval__actions">
              {approvalOptions.map(({ action, label, icon: Icon }) => (
                <button key={action} className={`semantic-button ${action === 'deprecate' ? 'semantic-button--danger' : 'semantic-button--primary'}`} type="button" onClick={() => setApprovalAction(action)}>
                  <Icon size={16} aria-hidden="true" /> {label}
                </button>
              ))}
            </div>
          ) : (
            <div className="semantic-approval__form">
              <label>
                <span>{approvalAction === 'deprecate' ? '弃用原因（必填）' : '审批说明'}</span>
                <textarea value={approvalNote} onChange={(event) => setApprovalNote(event.target.value)} placeholder={approvalAction === 'deprecate' ? '说明弃用原因和推荐替代指标' : '记录本次提交或审批的核验范围'} rows={3} />
              </label>
              <div>
                <button className="semantic-button semantic-button--quiet" type="button" onClick={() => setApprovalAction(null)}>取消</button>
                <button className={`semantic-button ${approvalAction === 'deprecate' ? 'semantic-button--danger' : 'semantic-button--primary'}`} type="button" onClick={requestApproval} disabled={approvalAction === 'deprecate' && !approvalNote.trim()}>
                  确认{approvalOptions.find((item) => item.action === approvalAction)?.label}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  )
}

interface FieldProps {
  label: string
  editing: boolean
  value: string
  onChange: (value: string) => void
  multiline?: boolean
  wide?: boolean
  icon?: ReactNode
}

function Field({ label, editing, value, onChange, multiline, wide, icon }: FieldProps) {
  return (
    <label className={`semantic-field ${wide ? 'semantic-field--wide' : ''}`}>
      <span>{label}</span>
      {editing ? (
        multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} /> : <input value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <div className="semantic-read-value">{icon}{value || '未设置'}</div>
      )}
    </label>
  )
}

interface SelectFieldProps {
  label: string
  editing: boolean
  value: string
  onChange: (value: string) => void
  options: string[]
}

function SelectField({ label, editing, value, onChange, options }: SelectFieldProps) {
  return (
    <label className="semantic-field">
      <span>{label}</span>
      {editing ? (
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : <div className="semantic-read-value">{value}</div>}
    </label>
  )
}

export default SemanticGovernance
