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
