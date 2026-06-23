import type { Conversation } from '../domain'

export const salesConversation: Conversation = {
  id: 'conversation_sales_demo',
  tenantId: 'tenant_demo',
  workspaceId: 'workspace_sales',
  title: '净收入趋势分析',
  businessDomainId: 'sales',
  mode: 'trusted',
  semanticVersion: 'sales-semantic-2026.06.1',
  state: {
    metrics: { value: ['net_revenue'], source: 'user' },
    dimensions: { value: ['order_date'], source: 'system_default' },
    filters: { value: { order_status: ['completed'] }, source: 'system_default' },
    timeRange: { value: 'last_12_complete_months', source: 'user' },
    grain: { value: 'month', source: 'user' },
    presentation: { value: 'line', source: 'system_default' },
    assumptions: ['时区：Asia/Shanghai', '仅包含完整自然月'],
  },
  createdBy: 'user_demo',
  createdAt: '2026-06-22T09:00:00+08:00',
  updatedAt: '2026-06-22T09:00:00+08:00',
}
