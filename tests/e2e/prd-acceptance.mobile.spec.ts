import { expect, test } from '@playwright/test'

test('mobile layout keeps session and context panels reachable', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: '打开会话列表' }).click()
  await expect(page.getByRole('complementary', { name: '会话列表' })).toBeVisible()
  await expect(page.getByRole('button', { name: '新建分析' })).toBeVisible()
  await page.getByRole('button', { name: '关闭会话列表' }).click()

  await page.getByRole('button', { name: '打开分析上下文' }).click()
  const contextPanel = page.getByRole('complementary', { name: '分析上下文' })
  await expect(contextPanel).toBeVisible()
  await expect(contextPanel.getByText('语义版本', { exact: true })).toBeVisible()
  await expect(contextPanel.getByText('经营数仓 / 销售主题域')).toBeVisible()
})
