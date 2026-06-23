import { useMemo, useState } from 'react'
import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconDatabase,
  IconKey,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
  IconTable,
  IconX,
} from '@tabler/icons-react'
import { dataSources } from './fixtures'
import type { DataSource, DataSourceColumn, DataSourceStatus, FieldClassification, QualityGateStatus } from './types'
import './data-sources.css'

const statusMeta: Record<DataSourceStatus, { label: string; tone: string }> = {
  healthy: { label: '健康', tone: 'success' },
  degraded: { label: '降级', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  syncing: { label: '同步中', tone: 'info' },
  draft: { label: '草稿', tone: 'neutral' },
}

const gateMeta: Record<QualityGateStatus, { label: string; icon: typeof IconCheck; tone: string }> = {
  pass: { label: '通过', icon: IconCheck, tone: 'success' },
  warning: { label: '预警', icon: IconClock, tone: 'warning' },
  fail: { label: '失败', icon: IconAlertTriangle, tone: 'danger' },
}

const classificationMeta: Record<FieldClassification, { label: string; tone: string }> = {
  public: { label: '公开', tone: 'success' },
  internal: { label: '内部', tone: 'neutral' },
  confidential: { label: '敏感', tone: 'warning' },
  restricted: { label: '受限', tone: 'danger' },
}

export function DataSourceCenter() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | DataSourceStatus>('all')
  const [selectedId, setSelectedId] = useState(dataSources[0]?.id)
  const [testingId, setTestingId] = useState<string | null>(null)

  const filteredSources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN')
    return dataSources.filter((source) => {
      const matchesStatus = status === 'all' || source.status === status
      const matchesQuery =
        !needle ||
        source.name.toLocaleLowerCase('zh-CN').includes(needle) ||
        source.engine.toLocaleLowerCase('en-US').includes(needle) ||
        source.businessDomain.toLocaleLowerCase('zh-CN').includes(needle)
      return matchesStatus && matchesQuery
    })
  }, [query, status])

  const selected = filteredSources.find((source) => source.id === selectedId) ?? filteredSources[0] ?? dataSources[0]
  const allTables = selected.tables
  const allColumns = allTables.flatMap((table) => table.columns.map((column) => ({ ...column, tableName: table.displayName })))

  const testConnection = (source: DataSource) => {
    setTestingId(source.id)
    window.setTimeout(() => setTestingId(null), 700)
  }

  return (
    <main className="datasource-page" aria-labelledby="datasource-title">
      <header className="datasource-header">
        <div>
          <div className="datasource-breadcrumb">数据治理 / 数据源</div>
          <h1 id="datasource-title">数据源中心</h1>
          <p>管理只读连接、元数据同步、字段分类和质量门禁。未通过门禁的数据不会进入可信问答。</p>
        </div>
        <button className="datasource-button datasource-button--primary" type="button">
          <IconDatabase size={17} aria-hidden="true" />
          新建数据源
        </button>
      </header>

      <section className="datasource-summary" aria-label="数据源概览">
        <SummaryItem label="可用数据源" value={`${dataSources.filter((source) => source.status === 'healthy').length}/${dataSources.length}`} detail="健康连接" tone="success" />
        <SummaryItem label="已分类字段" value={dataSources.reduce((sum, source) => sum + source.classifiedFields, 0).toLocaleString()} detail="受限字段继承策略" tone="info" />
        <SummaryItem label="质量预警" value={String(dataSources.filter((source) => source.qualityGates.some((gate) => gate.status !== 'pass')).length)} detail="需数据管理员确认" tone="warning" />
        <SummaryItem label="平均质量分" value={`${Math.round(dataSources.reduce((sum, source) => sum + source.qualityScore, 0) / dataSources.length)}%`} detail="核心门禁" tone="success" />
      </section>

      <div className="datasource-workspace">
        <aside className="datasource-list" aria-label="数据源列表">
          <div className="datasource-tools">
            <label className="datasource-search">
              <IconSearch size={17} aria-hidden="true" />
              <span className="datasource-sr-only">搜索数据源</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、引擎或业务域" />
              {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"><IconX size={15} /></button>}
            </label>
            <div className="datasource-filter" role="group" aria-label="按状态筛选">
              {[
                ['all', '全部'],
                ['healthy', '健康'],
                ['degraded', '降级'],
                ['syncing', '同步中'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={status === value ? 'is-active' : ''}
                  aria-pressed={status === value}
                  onClick={() => setStatus(value as 'all' | DataSourceStatus)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="datasource-count">{filteredSources.length} 个数据源</div>
          <div className="datasource-source-list">
            {filteredSources.map((source) => (
              <button
                key={source.id}
                type="button"
                className={`datasource-row ${selected.id === source.id ? 'is-selected' : ''}`}
                onClick={() => setSelectedId(source.id)}
              >
                <span className="datasource-row__top">
                  <strong>{source.name}</strong>
                  <StatusBadge status={source.status} />
                </span>
                <span>{source.engine} · {source.businessDomain}</span>
                <span className="datasource-row__meta">新鲜度 {source.freshness} · 质量 {source.qualityScore}%</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="datasource-detail" aria-label={`${selected.name} 详情`}>
          <div className="datasource-detail__header">
            <div>
              <div className="datasource-title-row">
                <h2>{selected.name}</h2>
                <StatusBadge status={selected.status} />
              </div>
              <p>{selected.engine} · {selected.connection}</p>
            </div>
            <button className="datasource-button datasource-button--secondary" type="button" onClick={() => testConnection(selected)}>
              <IconRefresh size={16} className={testingId === selected.id ? 'datasource-spin' : undefined} aria-hidden="true" />
              {testingId === selected.id ? '测试中' : '测试连接'}
            </button>
          </div>

          <div className="datasource-facts">
            <Fact label="最近同步" value={selected.lastSyncAt} />
            <Fact label="下次同步" value={selected.nextSyncAt} />
            <Fact label="凭据引用" value={selected.credentialRef} icon={<IconKey size={16} />} />
            <Fact label="扫描预算" value={selected.scanBudget} />
          </div>

          <section className="datasource-panel" aria-labelledby="quality-gate-title">
            <div className="datasource-panel__header">
              <div>
                <h3 id="quality-gate-title">质量门禁</h3>
                <p>所有门禁会写入审计事件，失败或预警会限制可信模式使用。</p>
              </div>
              <span className="datasource-score">质量分 {selected.qualityScore}%</span>
            </div>
            <div className="datasource-gates">
              {selected.qualityGates.map((gate) => <GateRow key={gate.name} gate={gate} />)}
            </div>
          </section>

          <div className="datasource-columns">
            <section className="datasource-panel" aria-labelledby="metadata-title">
              <div className="datasource-panel__header">
                <div>
                  <h3 id="metadata-title">元数据目录</h3>
                  <p>{selected.scannedTables} 张表 · {selected.classifiedFields} 个字段已分类</p>
                </div>
                <IconTable size={19} aria-hidden="true" />
              </div>
              <div className="datasource-table-list">
                {allTables.map((table) => (
                  <article className="datasource-table-card" key={table.id}>
                    <div>
                      <strong>{table.displayName}</strong>
                      <code>{table.name}</code>
                    </div>
                    <dl>
                      <div><dt>行数</dt><dd>{table.rowCount}</dd></div>
                      <div><dt>新鲜度</dt><dd>{table.freshness}</dd></div>
                      <div><dt>负责人</dt><dd>{table.owner}</dd></div>
                      <div><dt>质量</dt><dd>{table.qualityScore}%</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>

            <section className="datasource-panel" aria-labelledby="fields-title">
              <div className="datasource-panel__header">
                <div>
                  <h3 id="fields-title">字段分类与样本策略</h3>
                  <p>受限字段不会进入候选值或普通答案。</p>
                </div>
                <IconShieldCheck size={19} aria-hidden="true" />
              </div>
              <div className="datasource-field-list">
                {allColumns.map((column) => <FieldRow key={`${column.tableName}.${column.name}`} column={column} />)}
              </div>
            </section>
          </div>

          <section className="datasource-panel" aria-labelledby="sync-title">
            <div className="datasource-panel__header">
              <div>
                <h3 id="sync-title">同步与扫描记录</h3>
                <p>用于排查新鲜度、枚举和 Schema 变化。</p>
              </div>
              <IconClock size={19} aria-hidden="true" />
            </div>
            <div className="datasource-timeline">
              {selected.syncEvents.map((event) => (
                <div className={`datasource-event datasource-event--${event.status}`} key={`${event.at}-${event.summary}`}>
                  <span>{event.at}</span>
                  <p>{event.summary}</p>
                </div>
              ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  )
}

function SummaryItem({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return (
    <article className={`datasource-summary-item datasource-summary-item--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function StatusBadge({ status }: { status: DataSourceStatus }) {
  const meta = statusMeta[status]
  return <span className={`datasource-status datasource-status--${meta.tone}`}>{meta.label}</span>
}

function Fact({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return (
    <div className="datasource-fact">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function GateRow({ gate }: { gate: DataSource['qualityGates'][number] }) {
  const meta = gateMeta[gate.status]
  const Icon = meta.icon
  return (
    <div className="datasource-gate-row">
      <div>
        <strong>{gate.name}</strong>
        <span>{gate.detail}</span>
      </div>
      <div className="datasource-gate-value">
        <span>{gate.value}</span>
        <small>目标 {gate.target}</small>
      </div>
      <span className={`datasource-gate-result datasource-gate-result--${meta.tone}`}>
        <Icon size={14} aria-hidden="true" />
        {meta.label}
      </span>
    </div>
  )
}

function FieldRow({ column }: { column: DataSourceColumn & { tableName: string } }) {
  const meta = classificationMeta[column.classification]
  return (
    <article className="datasource-field-row">
      <div>
        <strong>{column.name}</strong>
        <span>{column.tableName} · {column.type}{column.nullable ? ' · 可空' : ''}</span>
        <p>{column.description}</p>
      </div>
      <div>
        <span className={`datasource-classification datasource-classification--${meta.tone}`}>{meta.label}</span>
        <small>{column.samplePolicy}</small>
      </div>
    </article>
  )
}
