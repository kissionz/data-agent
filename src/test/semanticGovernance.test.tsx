import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SemanticGovernance } from '../features/semantic'
import type { SemanticDimension, SemanticMetric } from '../features/semantic'

const dimensions: SemanticDimension[] = [
  { id: 'order_date', name: '订单日期', dataType: 'date', hierarchy: '年 / 季度 / 月 / 日' },
  { id: 'region', name: '区域', dataType: 'string', hierarchy: '大区 / 省份 / 城市' },
  { id: 'channel', name: '渠道', dataType: 'string', hierarchy: '渠道类型 / 渠道' },
]

const metrics: SemanticMetric[] = [
  {
    id: 'net_revenue',
    name: '净收入',
    code: 'net_revenue',
    description: '扣除退款、折扣与税费后的认证收入。',
    status: 'certified',
    formula: 'sum(completed_order_revenue) - sum(refund_amount)',
    valueType: 'currency',
    unit: 'CNY',
    aggregation: 'derived',
    owner: '经营分析组',
    domain: '销售经营',
    currentVersion: '2026.06.3',
    updatedAt: '2026-06-21 16:24',
    dimensions: ['order_date', 'region', 'channel'],
    dependencies: [{ id: 'dwd_order_settlement', name: '订单结算事实表', type: 'dataset' }],
    versions: [{ version: '2026.06.3', status: 'certified', changedAt: '2026-06-21 16:24', changedBy: '周若安', summary: '补充平台优惠分摊规则' }],
  },
  {
    id: 'gross_revenue',
    name: '含税收入',
    code: 'gross_revenue',
    description: '退款扣减前的订单含税收入。',
    status: 'review',
    formula: 'sum(order_gross_amount)',
    valueType: 'currency',
    unit: 'CNY',
    aggregation: 'sum',
    owner: '财务数据组',
    domain: '销售经营',
    currentVersion: '2026.06.1-rc2',
    updatedAt: '2026-06-20 11:03',
    dimensions: ['order_date', 'region'],
    dependencies: [{ id: 'dwd_order', name: '订单事实表', type: 'dataset' }],
    versions: [{ version: '2026.06.1-rc2', status: 'review', changedAt: '2026-06-20 11:03', changedBy: '赵清越', summary: '等待财务负责人对账' }],
  },
]

describe('SemanticGovernance UI', () => {
  it('renders metric definitions, dimensions, dependencies and versions', () => {
    render(<SemanticGovernance metrics={metrics} dimensions={dimensions} canEdit canApprove />)

    expect(screen.getByRole('heading', { name: '指标治理' })).toBeInTheDocument()
    expect(screen.getAllByText('净收入')).not.toHaveLength(0)
    expect(screen.getAllByText('net_revenue').length).toBeGreaterThan(0)
    expect(screen.getByText('sum(completed_order_revenue) - sum(refund_amount)')).toBeInTheDocument()
    expect(screen.getByText('订单日期')).toBeInTheDocument()
    expect(screen.getByText('区域')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /依赖关系/ }))
    expect(screen.getByText('订单结算事实表')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /版本历史/ }))
    expect(screen.getByText('补充平台优惠分摊规则')).toBeInTheDocument()
  })

  it('filters metrics by query and lifecycle status', () => {
    render(<SemanticGovernance metrics={metrics} dimensions={dimensions} />)

    fireEvent.change(screen.getByPlaceholderText('搜索名称、编码或负责人'), {
      target: { value: '财务' },
    })
    const list = screen.getByLabelText('指标列表')
    expect(within(list).getAllByText('含税收入')).not.toHaveLength(0)
    expect(within(list).queryByText('net_revenue')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索名称、编码或负责人'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: '评审中' }))
    expect(screen.getByText('1 个指标')).toBeInTheDocument()
    expect(screen.getAllByText('含税收入')).not.toHaveLength(0)
  })

  it('supports controlled edit actions', () => {
    const onSaveMetric = vi.fn()
    render(
      <SemanticGovernance
        metrics={metrics}
        dimensions={dimensions}
        selectedMetricId="gross_revenue"
        canEdit
        canApprove
        onSaveMetric={onSaveMetric}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '编辑指标' }))
    fireEvent.change(screen.getByDisplayValue('含税收入'), {
      target: { value: '含税收入（财务确认）' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存更改' }))
    expect(onSaveMetric).toHaveBeenCalledWith('gross_revenue', expect.objectContaining({
      name: '含税收入（财务确认）',
    }))
  })

  it('supports controlled approval actions', () => {
    const onRequestApproval = vi.fn()
    render(
      <SemanticGovernance
        metrics={metrics}
        dimensions={dimensions}
        selectedMetricId="gross_revenue"
        canApprove
        onRequestApproval={onRequestApproval}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '认证并发布' }))
    fireEvent.change(screen.getByPlaceholderText('记录本次提交或审批的核验范围'), {
      target: { value: '参考 SQL 已对账' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认认证并发布' }))
    expect(onRequestApproval).toHaveBeenCalledWith({
      metricId: 'gross_revenue',
      action: 'certify',
      note: '参考 SQL 已对账',
    })
  })
})
