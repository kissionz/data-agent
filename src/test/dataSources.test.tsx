import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataSourceCenter } from '../features/data-sources'

describe('DataSourceCenter', () => {
  it('renders source health, metadata and quality gates', () => {
    render(<DataSourceCenter />)

    expect(screen.getByRole('heading', { name: '数据源中心' })).toBeInTheDocument()
    expect(screen.getAllByText('经营数仓 / 销售主题域')).not.toHaveLength(0)
    expect(screen.getByText('质量门禁')).toBeInTheDocument()
    expect(screen.getByText('字段分类与样本策略')).toBeInTheDocument()
    expect(screen.getByText('customer_phone')).toBeInTheDocument()
    expect(screen.getByText('受限')).toBeInTheDocument()
    expect(screen.getByText('默认不可见，不参与候选值展示')).toBeInTheDocument()
  })

  it('filters data sources by search query and status', () => {
    render(<DataSourceCenter />)

    fireEvent.change(screen.getByPlaceholderText('搜索名称、引擎或业务域'), {
      target: { value: '财务' },
    })
    expect(screen.getAllByText('财务核算库')).not.toHaveLength(0)
    expect(screen.queryByText('用户行为湖仓')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '降级' }))
    expect(screen.getByText('1 个数据源')).toBeInTheDocument()
    expect(screen.getByText('发票事实表')).toBeInTheDocument()
  })

  it('shows temporary connection testing feedback', () => {
    vi.useFakeTimers()
    render(<DataSourceCenter />)

    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(screen.getByRole('button', { name: '测试中' })).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument()
    vi.useRealTimers()
  })
})
