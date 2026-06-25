import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('standard query result exposes constraints, table alternative and evidence', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '过去 12 个完整自然月净收入趋势' })).toBeVisible()
  await expect(page.locator('.run-stage').getByText('已完成', { exact: true })).toBeVisible()
  await expect(page.getByText('结果、口径与来源已就绪')).toBeVisible()
  await expect(page.getByText('采用条件：')).toBeVisible()
  await expect(page.getByText(/已完成订单 · 中国区/).first()).toBeVisible()

  await page.getByRole('tab', { name: /数据表/ }).click()
  await expect(page.getByRole('columnheader', { name: '结果引用' })).toBeVisible()
  await expect(page.getByText('result.month[0]')).toBeVisible()

  await page.getByRole('tab', { name: /口径与来源/ }).click()
  await expect(page.getByText('指标口径')).toBeVisible()
  await expect(page.getByText('销售经营主题域')).toBeVisible()
  await expect(page.getByText(/trace_id/)).toBeVisible()
})

test('ambiguous question requires clarification before executing a query', async ({ page }) => {
  await page.getByLabel('输入分析问题').fill('最近销售情况怎么样')
  await page.getByRole('button', { name: '开始分析' }).click()

  await expect(page.getByText('需澄清')).toBeVisible()
  await expect(page.getByText('查询尚未执行')).toBeVisible()
  await expect(page.getByRole('heading', { name: '“销售情况”需要确认口径' })).toBeVisible()

  await page.getByRole('button', { name: /^净收入\s+最近 30 个完整自然日/ }).click()
  await expect(page.getByRole('heading', { name: /最近销售情况怎么样（净收入）/ })).toBeVisible()
  await expect(page.getByText('已完成')).toBeVisible()
  await expect(page.getByText('结果、口径与来源已就绪')).toBeVisible()
})

test('permission denial is safe and does not leak forbidden values in the failure card', async ({ page }) => {
  await page.getByLabel('输入分析问题').fill('列出其他事业部的客户手机号和订单')
  await page.getByRole('button', { name: '开始分析' }).click()

  const failure = page.locator('.failure-card')
  await expect(failure.getByRole('heading', { name: '无法访问该范围' })).toBeVisible()
  await expect(failure.getByText('当前请求超出你的数据权限。为避免泄露资源是否存在，系统不会展示候选值或相关明细。')).toBeVisible()
  await expect(failure.getByText(/安全事件已记录/)).toBeVisible()
  await expect(failure).not.toContainText('客户手机号')
  await expect(failure).not.toContainText('其他事业部')
})

test('operations center supports replay filtering and detail review', async ({ page }) => {
  await page.getByRole('button', { name: '运营中心' }).click()
  await expect(page.getByRole('heading', { name: '生产质量总览' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '黄金集发布门禁' })).toBeVisible()
  await expect(page.getByText('澄清召回率低于门槛 1.3%，当前版本不可发布。')).toBeVisible()

  await page.getByPlaceholder('搜索问题或 Run ID').fill('RUN-28403')
  await expect(page.getByText('RUN-28403')).toBeVisible()
  await expect(page.getByText('RUN-28419')).not.toBeVisible()

  await page.getByRole('button', { name: '回放 RUN-28403' }).click()
  const dialog = page.getByRole('dialog', { name: '回放详情' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('失败阶段')).toBeVisible()
  await expect(dialog.getByText('模型版本')).toBeVisible()
  await expect(dialog.getByText('使用候选版本重放')).toBeVisible()

  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog).not.toBeVisible()
})
