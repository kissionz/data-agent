import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'

afterEach(() => {
  vi.useRealTimers()
})

describe('Workbench UI', () => {
  it('renders the default result with visible constraints, evidence and table alternative', () => {
    render(<App />)

    expect(screen.getByRole('heading', { name: '过去 12 个完整自然月净收入趋势' })).toBeInTheDocument()
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByText('结果、口径与来源已就绪')).toBeInTheDocument()
    expect(screen.getByText('采用条件：')).toBeInTheDocument()
    expect(screen.getAllByText(/已完成订单 · 中国区/).length).toBeGreaterThan(0)
    expect(screen.getByText(/数据更新于/)).toHaveTextContent('语义版本')

    fireEvent.click(screen.getByRole('tab', { name: /数据表/ }))
    expect(screen.getByRole('columnheader', { name: '结果引用' })).toBeInTheDocument()
    expect(screen.getByText('result.month[0]')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /口径与来源/ }))
    expect(screen.getByText('指标口径')).toBeInTheDocument()
    expect(screen.getByText('销售经营主题域')).toBeInTheDocument()
    expect(screen.getByText(/trace_id/)).toBeInTheDocument()
  })

  it('keeps ambiguous questions in clarification state until a candidate is selected', () => {
    vi.useFakeTimers()
    render(<App />)

    const input = screen.getByLabelText('输入分析问题')
    fireEvent.change(input, { target: { value: '最近销售情况怎么样' } })
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }))
    expect(screen.getByText('理解中')).toBeInTheDocument()
    expect(screen.getByText('正在匹配指标、维度与权限')).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(screen.getByText('需澄清')).toBeInTheDocument()
    expect(screen.getByText('查询尚未执行')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '“销售情况”需要确认口径' })).toBeInTheDocument()
    const netRevenueCandidate = screen.getByRole('button', { name: /^净收入\s+最近 30 个完整自然日/ })
    expect(netRevenueCandidate).toBeInTheDocument()

    fireEvent.click(netRevenueCandidate)
    act(() => {
      vi.advanceTimersByTime(1200)
    })
    expect(screen.getByText('已完成')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /最近销售情况怎么样（净收入）/ })).toBeInTheDocument()
  })

  it('shows a safe permission failure without leaking forbidden resource names', () => {
    vi.useFakeTimers()
    render(<App />)

    fireEvent.change(screen.getByLabelText('输入分析问题'), {
      target: { value: '列出其他事业部的客户手机号和订单' },
    })
    fireEvent.click(screen.getByRole('button', { name: '开始分析' }))
    act(() => {
      vi.advanceTimersByTime(500)
    })

    const failure = screen.getByText('无法访问该范围').closest('section')
    expect(failure).not.toBeNull()
    expect(within(failure as HTMLElement).getByText('当前请求超出你的数据权限。为避免泄露资源是否存在，系统不会展示候选值或相关明细。')).toBeInTheDocument()
    expect(within(failure as HTMLElement).getByText(/安全事件已记录/)).toBeInTheDocument()
    expect(within(failure as HTMLElement).queryByText('客户手机号')).not.toBeInTheDocument()
    expect(within(failure as HTMLElement).queryByText('其他事业部')).not.toBeInTheDocument()
  })
})
