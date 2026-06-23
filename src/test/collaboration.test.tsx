import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CollaborationHub } from '../features/collaboration'

describe('CollaborationHub', () => {
  it('renders collaboration assets, sharing guardrails and audit evidence', () => {
    render(<CollaborationHub />)

    expect(screen.getByRole('heading', { name: '协作资产' })).toBeInTheDocument()
    expect(screen.getAllByText('过去 12 个完整自然月净收入趋势')).not.toHaveLength(0)
    expect(screen.getByText('权限与复用范围')).toBeInTheDocument()
    expect(screen.getByText('分享接收者、订阅通知和导出都不能继承创建者权限。')).toBeInTheDocument()
    expect(screen.getByText('导出启用水印、大小限制和脱敏审计。')).toBeInTheDocument()
    expect(screen.getByText(/share.created/)).toBeInTheDocument()
  })

  it('filters assets by search query and review status', () => {
    render(<CollaborationHub />)

    fireEvent.change(screen.getByPlaceholderText('搜索资产、模板或负责人'), {
      target: { value: '退款率' },
    })
    expect(screen.getAllByText('退款率异常解释模板')).not.toHaveLength(0)
    expect(screen.queryByText('区域经营周报订阅')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '审核中' }))
    expect(screen.getByText('1 个资产')).toBeInTheDocument()
    expect(screen.getByText('仅审核人和创建者可见，未审核前不可订阅。')).toBeInTheDocument()
  })

  it('toggles favorite feedback for the selected asset', () => {
    render(<CollaborationHub />)

    fireEvent.click(screen.getByRole('button', { name: '取消收藏' }))
    expect(screen.getByRole('status')).toHaveTextContent('已取消收藏：过去 12 个完整自然月净收入趋势')

    fireEvent.click(screen.getByRole('button', { name: '收藏资产' }))
    expect(screen.getByRole('status')).toHaveTextContent('已收藏：过去 12 个完整自然月净收入趋势')
  })

  it('prevents subscribing to assets that are still in review', () => {
    render(<CollaborationHub />)

    fireEvent.click(screen.getByText('退款率异常解释模板'))
    fireEvent.click(screen.getByRole('button', { name: '开启订阅' }))
    expect(screen.getByRole('status')).toHaveTextContent('审核中的资产不能订阅')
  })
})
