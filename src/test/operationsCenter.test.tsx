import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationsCenter } from '../features/operations'

afterEach(() => {
  vi.useRealTimers()
})

describe('OperationsCenter UI', () => {
  it('renders SLO, release gate, model versions and failure distribution', () => {
    render(<OperationsCenter />)

    expect(screen.getByRole('heading', { name: '生产质量总览' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '黄金集发布门禁' })).toBeInTheDocument()
    expect(screen.getByText('1 项未通过')).toBeInTheDocument()
    expect(screen.getByText('澄清召回率低于门槛 1.3%，当前版本不可发布。')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '模型版本' })).toBeInTheDocument()
    expect(screen.getByText('3.3-rc2')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'SLO 状态' })).toBeInTheDocument()
    expect(screen.getByText('整体健康')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /失败分布/ })).toBeInTheDocument()
  })

  it('filters replay runs and opens a replay detail drawer', () => {
    render(<OperationsCenter />)

    fireEvent.click(screen.getByRole('tab', { name: '失败回放' }))
    fireEvent.change(screen.getByPlaceholderText('搜索问题或 Run ID'), {
      target: { value: 'RUN-28403' },
    })
    expect(screen.getByText('RUN-28403')).toBeInTheDocument()
    expect(screen.queryByText('RUN-28419')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /RUN-28403/ }))
    const dialog = screen.getByRole('dialog', { name: '回放详情' })
    expect(within(dialog).getByText('失败阶段')).toBeInTheDocument()
    expect(within(dialog).getByText('模型版本')).toBeInTheDocument()
    expect(within(dialog).getByText('使用候选版本重放')).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))
    expect(screen.queryByRole('dialog', { name: '回放详情' })).not.toBeInTheDocument()
  })

  it('approves a candidate golden sample and schedules a scoped regression run', () => {
    render(<OperationsCenter />)

    fireEvent.click(screen.getByRole('tab', { name: '黄金集' }))
    expect(screen.getByRole('heading', { name: '黄金集样本' })).toBeInTheDocument()
    expect(screen.getByText('最近销售情况怎么样？')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '查看样本 golden_seed_002' }))
    const dialog = screen.getByRole('dialog', { name: '黄金样本详情' })
    expect(within(dialog).getByText('已完成敏感信息脱敏')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: '批准进入黄金集' })).toBeDisabled()
    fireEvent.change(within(dialog).getByLabelText('审批说明'), {
      target: { value: '人工复核歧义与期望口径通过' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: '批准进入黄金集' }))
    expect(screen.getByRole('status')).toHaveTextContent('已批准进入黄金集')
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭' }))

    fireEvent.click(screen.getByRole('checkbox', { name: '选择样本 golden_seed_002' }))
    expect(screen.getByText('已选 1 条黄金样本')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '回归运行' }))
    expect(screen.getByRole('heading', { name: '批量回归运行' })).toBeInTheDocument()
    expect(screen.getByText('当前选择 1 条')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '调度回归' }))
    expect(screen.getByRole('status')).toHaveTextContent(/已排队，覆盖 1 条黄金样本/)
    expect(screen.getByText('排队中')).toBeInTheDocument()
    expect(screen.getByText('0/5')).toBeInTheDocument()
  })

  it('filters golden samples and provides a recoverable empty state', () => {
    render(<OperationsCenter />)
    fireEvent.click(screen.getByRole('tab', { name: '黄金集' }))

    fireEvent.change(screen.getByLabelText('黄金样本状态'), {
      target: { value: 'candidate_dataset' },
    })
    expect(screen.getByText('最近销售情况怎么样？')).toBeInTheDocument()
    expect(screen.queryByText('过去 12 个完整自然月净收入趋势。')).not.toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索问题、样本 ID 或标签'), {
      target: { value: '没有这个样本' },
    })
    expect(screen.getByText('没有匹配的黄金样本')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }))
    expect(screen.getByText('过去 12 个完整自然月净收入趋势。')).toBeInTheDocument()
  })

  it('switches task tabs with arrow keys', () => {
    render(<OperationsCenter />)
    const overview = screen.getByRole('tab', { name: '总览' })
    overview.focus()
    fireEvent.keyDown(overview, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: '黄金集' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('heading', { name: '黄金集样本' })).toBeInTheDocument()
  })

  it('shows refresh feedback without changing the operating context', () => {
    vi.useFakeTimers()
    render(<OperationsCenter />)

    fireEvent.click(screen.getByRole('button', { name: '刷新数据' }))
    expect(screen.getByRole('button', { name: '刷新中' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '生产质量总览' })).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(700)
    })
    expect(screen.getByRole('button', { name: '刷新数据' })).toBeInTheDocument()
  })
})
