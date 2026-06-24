import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { OperationsCenter } from '../features/operations'
import { SemanticGovernance } from '../features/semantic'
import type { SemanticDimension, SemanticMetric } from '../features/semantic'

afterEach(() => {
  vi.useRealTimers()
})

const dimensions: SemanticDimension[] = [
  { id: 'order_date', name: '订单日期', dataType: 'date', hierarchy: '年 / 季度 / 月 / 日' },
  { id: 'region', name: '区域', dataType: 'string', hierarchy: '大区 / 省份 / 城市' },
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
    dimensions: ['order_date', 'region'],
    dependencies: [{ id: 'dwd_order_settlement', name: '订单结算事实表', type: 'dataset' }],
    versions: [{ version: '2026.06.3', status: 'certified', changedAt: '2026-06-21 16:24', changedBy: '周若安', summary: '补充平台优惠分摊规则' }],
  },
]

describe('Accessibility acceptance', () => {
  it('keeps global navigation, icon buttons and composer keyboard operation accessible', () => {
    vi.useFakeTimers()
    render(<App />)

    const nav = screen.getByRole('navigation', { name: '全局导航' })
    expect(within(nav).getByRole('button', { name: '问答工作台' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: '语义中心' })).toBeInTheDocument()
    expect(within(nav).getByRole('button', { name: '数据源中心' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '结果有帮助' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '结果无帮助' })).toBeInTheDocument()

    const input = screen.getByLabelText('输入分析问题')
    input.focus()
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: '上月净收入是多少？' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    expect(screen.getByText('理解中')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1300)
    })
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '上月净收入是多少？' })).toBeInTheDocument()
  })

  it('pairs chart summaries with a keyboard-reachable data table alternative', () => {
    render(<App />)

    expect(screen.getByLabelText('2025 年净收入月度趋势图')).toBeInTheDocument()
    const tableTab = screen.getByRole('tab', { name: /数据表/ })
    tableTab.focus()
    expect(tableTab).toHaveFocus()
    fireEvent.click(tableTab)

    expect(tableTab).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '月份' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '结果引用' })).toBeInTheDocument()
  })

  it('uses tablist semantics for semantic governance detail panes', () => {
    render(<SemanticGovernance metrics={metrics} dimensions={dimensions} canEdit />)

    const tablist = screen.getByRole('tablist', { name: '指标详情' })
    const definition = within(tablist).getByRole('tab', { name: /定义与维度/ })
    const dependencies = within(tablist).getByRole('tab', { name: /依赖关系/ })
    const versions = within(tablist).getByRole('tab', { name: /版本历史/ })

    expect(definition).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(dependencies)
    expect(dependencies).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('订单结算事实表')).toBeInTheDocument()

    fireEvent.click(versions)
    expect(versions).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('补充平台优惠分摊规则')).toBeInTheDocument()
  })

  it('exposes replay detail as a named dialog with an explicit close control', () => {
    render(<OperationsCenter />)

    fireEvent.click(screen.getByRole('button', { name: '回放 RUN-28419' }))
    const dialog = screen.getByRole('dialog', { name: '回放详情' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(within(dialog).getByRole('button', { name: '关闭回放详情' })).toBeInTheDocument()
    expect(within(dialog).getByText('Trace ID')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭回放详情' }))
    expect(screen.queryByRole('dialog', { name: '回放详情' })).not.toBeInTheDocument()
  })

  it('keeps status meaning available as text, not color alone', () => {
    render(<OperationsCenter />)

    expect(screen.getByText('整体健康')).toBeInTheDocument()
    expect(screen.getAllByText('阻断').length).toBeGreaterThan(0)
    expect(screen.getByText('当前版本不可发布。', { exact: false })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /过去七天执行准确率/ })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /失败分布/ })).toBeInTheDocument()
  })
})
