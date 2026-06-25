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

test('running analysis can be cancelled without later result overwrite', async ({ page }) => {
  await page.getByLabel('输入分析问题').fill('按城市分析过去一年净收入')
  await page.getByRole('button', { name: '开始分析' }).click()
  await expect(page.getByRole('button', { name: '停止' })).toBeVisible()

  await page.getByRole('button', { name: '停止' }).click()
  await expect(page.getByRole('status').filter({ hasText: '已取消本次分析' })).toBeVisible()
  await expect(page.locator('.run-stage')).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '净收入连续三个月增长' })).not.toBeVisible()

  await page.waitForTimeout(1300)
  await expect(page.getByRole('heading', { name: '净收入连续三个月增长' })).not.toBeVisible()
})

test('partial result is explicit and survives browser refresh', async ({ page }) => {
  await page.getByLabel('输入分析问题').fill('区域贡献超时的净收入趋势')
  await page.getByRole('button', { name: '开始分析' }).click()

  await expect(page.getByRole('heading', { name: '净收入趋势已就绪，区域贡献未完成' })).toBeVisible()
  await expect(page.getByLabel('部分结果说明')).toContainText('部分结果可用')
  await expect(page.getByText('区域贡献步骤超时，趋势结果仍可用。')).toBeVisible()
  await expect(page.getByText('未完成步骤：regional_contribution')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('status').filter({ hasText: '已从本机恢复上次分析结果' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '净收入趋势已就绪，区域贡献未完成' })).toBeVisible()
  await expect(page.getByLabel('部分结果说明')).toContainText('部分结果可用')
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

test('semantic governance exposes metric review and certification guardrails', async ({ page }) => {
  await page.getByRole('button', { name: '语义中心' }).click()
  await expect(page.getByRole('heading', { name: '指标治理' })).toBeVisible()
  await expect(page.getByLabel('指标列表')).toBeVisible()

  await page.getByPlaceholder('搜索名称、编码或负责人').fill('含税收入')
  await expect(page.getByRole('button', { name: /含税收入/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /净收入/ })).not.toBeVisible()

  await page.getByRole('button', { name: /含税收入/ }).click()
  await expect(page.getByRole('heading', { name: '含税收入' })).toBeVisible()
  await expect(page.getByText('order_gross_amount')).toBeVisible()
  await page.getByRole('tab', { name: /依赖关系/ }).click()
  await expect(page.getByText('订单事实表')).toBeVisible()
  await page.getByRole('tab', { name: /版本历史/ }).click()
  await expect(page.getByText('等待财务负责人对账')).toBeVisible()

  await page.getByRole('button', { name: '认证并发布' }).click()
  await page.getByPlaceholder('记录本次提交或审批的核验范围').fill('Playwright E2E 认证发布验收')
  await page.getByRole('button', { name: '确认认证并发布' }).click()
  await expect(page.getByRole('button', { name: '认证并发布' })).toBeVisible()
})

test('data source governance exposes degraded quality gates and restricted sample policy', async ({ page }) => {
  await page.getByRole('button', { name: '数据源中心' }).click()
  await expect(page.getByRole('heading', { name: '数据源中心' })).toBeVisible()
  await expect(page.getByText('质量预警')).toBeVisible()

  await page.getByRole('group', { name: '按状态筛选' }).getByRole('button', { name: '降级' }).click()
  await expect(page.getByRole('button', { name: /财务核算库/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /经营数仓/ })).not.toBeVisible()

  await expect(page.getByRole('heading', { name: '财务核算库' })).toBeVisible()
  const qualityGate = page.getByLabel('质量门禁')
  await expect(qualityGate.getByText('新鲜度', { exact: true })).toBeVisible()
  await expect(qualityGate.getByText('9h04m')).toBeVisible()
  await expect(qualityGate.getByText('空值率')).toBeVisible()
  await expect(qualityGate.getByText('发票来源字段缺失率升高。')).toBeVisible()
  await expect(page.getByText('taxpayer_id')).toBeVisible()
  await expect(page.getByText('默认不可见')).toBeVisible()

  await page.getByRole('button', { name: '测试连接' }).click()
  await expect(page.getByRole('button', { name: '测试中' })).toBeVisible()
})

test('collaboration assets enforce reauthorization, watermark and subscription rules', async ({ page }) => {
  await page.getByRole('button', { name: '协作资产' }).click()
  await expect(page.getByRole('heading', { name: '协作资产' })).toBeVisible()
  await expect(page.getByText('分享接收者、订阅通知和导出都不能继承创建者权限。')).toBeVisible()
  await expect(page.getByText('导出启用水印、大小限制和脱敏审计。')).toBeVisible()

  await page.getByPlaceholder('搜索资产、模板或负责人').fill('退款率')
  await expect(page.getByRole('button', { name: /退款率异常解释模板/ })).toBeVisible()
  await page.getByRole('button', { name: /退款率异常解释模板/ }).click()
  await expect(page.getByText('仅审核人和创建者可见，未审核前不可订阅。')).toBeVisible()

  await page.getByRole('button', { name: '开启订阅' }).click()
  await expect(page.getByRole('status')).toContainText('审核中的资产不能订阅')
  await expect(page.getByText('case.submitted · pii_scan=pass')).toBeVisible()
})
