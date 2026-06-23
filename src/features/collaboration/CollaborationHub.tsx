import { useMemo, useState } from 'react'
import {
  IconArchive,
  IconBell,
  IconBellRinging,
  IconCheck,
  IconClock,
  IconFileAnalytics,
  IconFolder,
  IconLock,
  IconRefresh,
  IconSearch,
  IconShare3,
  IconShieldCheck,
  IconStar,
  IconStarFilled,
  IconUsers,
} from '@tabler/icons-react'
import { collaborationAssets } from './fixtures'
import type { AssetStatus, AssetType, CollaborationAsset, ShareScope, SubscriptionCadence } from './types'
import './collaboration.css'

const typeMeta: Record<AssetType, { label: string; icon: typeof IconFolder; tone: string }> = {
  conversation: { label: '会话', icon: IconFileAnalytics, tone: 'info' },
  verified_case: { label: '验证案例', icon: IconShieldCheck, tone: 'success' },
  template: { label: '问题模板', icon: IconFolder, tone: 'neutral' },
  subscription: { label: '订阅', icon: IconBellRinging, tone: 'warning' },
}

const statusMeta: Record<AssetStatus, { label: string; icon: typeof IconCheck; tone: string }> = {
  active: { label: '可用', icon: IconCheck, tone: 'success' },
  review: { label: '审核中', icon: IconClock, tone: 'warning' },
  archived: { label: '已归档', icon: IconArchive, tone: 'neutral' },
}

const shareLabels: Record<ShareScope, string> = {
  private: '私有',
  workspace: '工作区内分享',
  domain_leads: '业务负责人',
  external_blocked: '外部分享已阻断',
}

const cadenceLabels: Record<SubscriptionCadence, string> = {
  daily: '每日',
  weekly: '每周',
  threshold: '阈值触发',
  none: '未订阅',
}

type StatusFilter = 'all' | AssetStatus

export function CollaborationHub() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [selectedId, setSelectedId] = useState(collaborationAssets[0]?.id)
  const [favoriteIds, setFavoriteIds] = useState(() => new Set(collaborationAssets.filter((asset) => asset.isFavorite).map((asset) => asset.id)))
  const [subscribedIds, setSubscribedIds] = useState(() => new Set(collaborationAssets.filter((asset) => asset.subscriptionCadence !== 'none').map((asset) => asset.id)))
  const [toast, setToast] = useState('')

  const assets = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return collaborationAssets.filter((asset) => {
      const matchesStatus = status === 'all' || asset.status === status
      const matchesQuery =
        !normalized ||
        asset.title.toLocaleLowerCase('zh-CN').includes(normalized) ||
        asset.businessDomain.toLocaleLowerCase('zh-CN').includes(normalized) ||
        asset.owner.toLocaleLowerCase('zh-CN').includes(normalized) ||
        asset.questionTemplate.toLocaleLowerCase('zh-CN').includes(normalized)
      return matchesStatus && matchesQuery
    })
  }, [query, status])

  const selected = assets.find((asset) => asset.id === selectedId) ?? assets[0] ?? collaborationAssets[0]
  const reviewCount = collaborationAssets.filter((asset) => asset.status === 'review').length
  const archivedCount = collaborationAssets.filter((asset) => asset.isArchived).length
  const activeSubscriptions = subscribedIds.size

  const toggleFavorite = (asset: CollaborationAsset) => {
    setFavoriteIds((current) => {
      const next = new Set(current)
      if (next.has(asset.id)) {
        next.delete(asset.id)
        setToast(`已取消收藏：${asset.title}`)
      } else {
        next.add(asset.id)
        setToast(`已收藏：${asset.title}`)
      }
      return next
    })
  }

  const toggleSubscription = (asset: CollaborationAsset) => {
    if (asset.status !== 'active') {
      setToast('审核中的资产不能订阅')
      return
    }
    setSubscribedIds((current) => {
      const next = new Set(current)
      if (next.has(asset.id)) {
        next.delete(asset.id)
        setToast(`已暂停订阅：${asset.title}`)
      } else {
        next.add(asset.id)
        setToast(`已开启订阅：${asset.title}`)
      }
      return next
    })
  }

  return (
    <main className="collaboration" aria-labelledby="collaboration-title">
      <header className="collaboration__header">
        <div>
          <p className="collaboration__breadcrumb">协作 / 资产与订阅</p>
          <h1 id="collaboration-title">协作资产</h1>
          <p>把可信问答沉淀为可复用资产，并在分享、导出和订阅时重新校验权限。</p>
        </div>
        <div className="collaboration__header-actions">
          <button className="collaboration__button collaboration__button--secondary" type="button">
            <IconArchive size={17} aria-hidden="true" />
            查看归档
          </button>
          <button className="collaboration__button collaboration__button--primary" type="button">
            <IconShare3 size={17} aria-hidden="true" />
            保存为案例
          </button>
        </div>
      </header>

      <section className="collaboration__summary" aria-label="协作资产概览">
        <SummaryCard label="资产总数" value={String(collaborationAssets.length)} detail="会话、模板、案例和订阅" tone="info" />
        <SummaryCard label="审核队列" value={String(reviewCount)} detail="需分析师确认后发布" tone="warning" />
        <SummaryCard label="活跃订阅" value={String(activeSubscriptions)} detail="通知前重新鉴权" tone="success" />
        <SummaryCard label="归档资产" value={String(archivedCount)} detail="保留审计，不默认展示" tone="neutral" />
      </section>

      <div className="collaboration__workspace">
        <aside className="collaboration__library" aria-label="资产库">
          <div className="collaboration__toolbar">
            <label className="collaboration__search">
              <IconSearch size={17} aria-hidden="true" />
              <span className="collaboration__sr-only">搜索资产</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资产、模板或负责人" />
            </label>
            <div className="collaboration__filters" role="group" aria-label="按资产状态筛选">
              {[
                ['all', '全部'],
                ['active', '可用'],
                ['review', '审核中'],
                ['archived', '已归档'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={status === value ? 'is-active' : ''}
                  aria-pressed={status === value}
                  onClick={() => setStatus(value as StatusFilter)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="collaboration__count">{assets.length} 个资产</div>
          <div className="collaboration__asset-list">
            {assets.map((asset) => {
              const TypeIcon = typeMeta[asset.type].icon
              return (
                <button
                  key={asset.id}
                  type="button"
                  className={`collaboration__asset ${selected.id === asset.id ? 'is-selected' : ''}`}
                  onClick={() => setSelectedId(asset.id)}
                >
                  <span className={`collaboration__type collaboration__type--${typeMeta[asset.type].tone}`}>
                    <TypeIcon size={15} aria-hidden="true" />
                    {typeMeta[asset.type].label}
                  </span>
                  <strong>{asset.title}</strong>
                  <span>{asset.businessDomain} · {asset.owner}</span>
                  <small>{asset.updatedAt}</small>
                </button>
              )
            })}
          </div>
        </aside>

        <section className="collaboration__detail" aria-label={`${selected.title} 详情`}>
          <div className="collaboration__detail-header">
            <div>
              <div className="collaboration__title-row">
                <h2>{selected.title}</h2>
                <StatusBadge status={selected.status} />
              </div>
              <p>{selected.description}</p>
            </div>
            <div className="collaboration__detail-actions">
              <button className="collaboration__icon-action" type="button" onClick={() => toggleFavorite(selected)} aria-label={favoriteIds.has(selected.id) ? '取消收藏' : '收藏资产'}>
                {favoriteIds.has(selected.id) ? <IconStarFilled size={18} aria-hidden="true" /> : <IconStar size={18} aria-hidden="true" />}
              </button>
              <button className="collaboration__button collaboration__button--secondary" type="button" onClick={() => toggleSubscription(selected)}>
                <IconBell size={16} aria-hidden="true" />
                {subscribedIds.has(selected.id) ? '暂停订阅' : '开启订阅'}
              </button>
            </div>
          </div>

          <div className="collaboration__facts">
            <Fact label="分享范围" value={shareLabels[selected.shareScope]} icon={<IconUsers size={16} />} />
            <Fact label="订阅频率" value={subscribedIds.has(selected.id) ? cadenceLabels[selected.subscriptionCadence] : '未订阅'} icon={<IconBell size={16} />} />
            <Fact label="语义版本" value={selected.semanticVersion} icon={<IconShieldCheck size={16} />} />
            <Fact label="IR 版本" value={selected.analysisIrVersion} icon={<IconFileAnalytics size={16} />} />
          </div>

          <section className="collaboration__panel" aria-labelledby="asset-scope-title">
            <div className="collaboration__panel-header">
              <div>
                <h3 id="asset-scope-title">权限与复用范围</h3>
                <p>分享接收者、订阅通知和导出都不能继承创建者权限。</p>
              </div>
              <span className={selected.shareScope === 'external_blocked' ? 'collaboration__guard collaboration__guard--danger' : 'collaboration__guard'}>
                <IconLock size={15} aria-hidden="true" />
                重新鉴权
              </span>
            </div>
            <div className="collaboration__scope-grid">
              <div>
                <span>适用范围</span>
                <p>{selected.scope}</p>
              </div>
              <div>
                <span>导出策略</span>
                <p>{selected.watermarkedExport ? '导出启用水印、大小限制和脱敏审计。' : '未发布资产暂不允许导出。'}</p>
              </div>
            </div>
          </section>

          <section className="collaboration__panel" aria-labelledby="template-title">
            <div className="collaboration__panel-header">
              <div>
                <h3 id="template-title">问题模板与版本快照</h3>
                <p>案例资产保存问题模板、IR、语义版本和适用边界。</p>
              </div>
              <IconRefresh size={19} aria-hidden="true" />
            </div>
            <div className="collaboration__template">
              <span>模板问题</span>
              <p>{selected.questionTemplate}</p>
            </div>
          </section>

          <div className="collaboration__split">
            <section className="collaboration__panel" aria-labelledby="review-title">
              <div className="collaboration__panel-header">
                <div>
                  <h3 id="review-title">审核与协作者</h3>
                  <p>资产发布前需要可追责的审核人。</p>
                </div>
              </div>
              <div className="collaboration__reviewers">
                {selected.reviewers.map((reviewer) => (
                  <div key={`${selected.id}-${reviewer.name}`}>
                    <strong>{reviewer.name}</strong>
                    <span>{reviewer.role}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="collaboration__panel" aria-labelledby="audit-title">
              <div className="collaboration__panel-header">
                <div>
                  <h3 id="audit-title">最近审计事件</h3>
                  <p>用于分享、导出、订阅和归档回放。</p>
                </div>
              </div>
              <code className="collaboration__audit">{selected.lastAudit}</code>
            </section>
          </div>
        </section>
      </div>

      {toast && (
        <div className="collaboration__toast" role="status">
          {toast}
          <button type="button" onClick={() => setToast('')}>关闭</button>
        </div>
      )}
    </main>
  )
}

function SummaryCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return (
    <article className={`collaboration__summary-card collaboration__summary-card--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function StatusBadge({ status }: { status: AssetStatus }) {
  const meta = statusMeta[status]
  const Icon = meta.icon
  return (
    <span className={`collaboration__status collaboration__status--${meta.tone}`}>
      <Icon size={14} aria-hidden="true" />
      {meta.label}
    </span>
  )
}

function Fact({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="collaboration__fact">
      <span>{icon}{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

