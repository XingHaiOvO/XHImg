import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('install, login, folder upload, public gallery, random service, private transition and trash', async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(e.message));
  await page.goto('/setup');
  await page
    .getByLabel('一次性安装令牌')
    .fill((await readFile('.cache/e2e-token.txt', 'utf8')).trim());
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await expect(page.getByRole('heading', { name: '一切，井然有序。' })).toBeVisible();
  await page.getByRole('link', { name: '资源文件夹', exact: true }).click();
  await page.getByRole('button', { name: '新建文件夹' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('文件夹名称').fill('旅行');
  await dialog.getByLabel('自身权限', { exact: true }).selectOption('public');
  await dialog.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: /旅行/ }).click();
  await page.getByRole('button', { name: '上传图片', exact: true }).first().click();
  await dialog.getByLabel('图片自身权限').selectOption('public');
  await dialog.getByLabel('选择上传图片').setInputFiles(resolve('.cache/e2e-image.png'));
  await expect(dialog.getByText('上传成功', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('e2e-image.png', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'API', exact: true }).click();
  await page.getByRole('link', { name: '配置随机图服务' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await dialog.getByLabel('服务名称').fill('旅行随机图');
  await dialog.getByLabel('访问策略').selectOption('public');
  await dialog.getByLabel('每分钟调用上限（每调用者）').fill('0');
  await dialog.getByLabel('启用此服务').check();
  await dialog.getByRole('button', { name: '保存服务' }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '旅行随机图' }) })
    .getByRole('button', { name: '配置', exact: true })
    .click();
  await expect(dialog.getByLabel('每分钟调用上限（每调用者）')).toHaveValue('0');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  const adminSession = await (await page.request.get('/api/v1/auth/me')).json();
  for (const name of ['自然风景', '灵感图集']) {
    const created = await page.request.post('/api/v1/admin/random-services', {
      headers: { 'X-CSRF-Token': adminSession.csrf },
      data: {
        kind: 'custom',
        name,
        description: '公开图片资源，随时调用。',
        visibility: 'public',
        enabled: true,
        rateLimit: 0,
      },
    });
    expect(created.status()).toBe(201);
  }
  const visitor = await page.context().browser()!.newContext();
  await visitor.grantPermissions(['clipboard-read', 'clipboard-write']);
  const publicPage = await visitor.newPage();
  await publicPage.goto('/');
  await expect(publicPage.getByRole('heading', { name: '旅行随机图' })).toBeVisible();
  await expect
    .poll(
      () =>
        publicPage
          .locator('.service-preview img')
          .evaluateAll((images) =>
            images.some((img) => (img as HTMLImageElement).naturalWidth > 0),
          ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(publicPage.locator('.home-banner')).toBeVisible();
  await expect
    .poll(
      () =>
        publicPage
          .locator('.home-banner-image')
          .evaluateAll((images) =>
            images.some((img) => (img as HTMLImageElement).naturalWidth > 0),
          ),
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(publicPage.getByRole('link', { name: '图库预览', exact: true })).toBeVisible();
  await expect(publicPage.locator('.service-card')).toHaveCount(3);
  expect(
    await publicPage
      .locator('.service-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(3);
  const refreshed = publicPage.waitForResponse(
    (r) => r.url().includes('/folders/') && r.url().includes('/random?mode=json'),
  );
  await publicPage.getByRole('button', { name: '刷新 旅行随机图 图片', exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  expect(visitor.pages()).toHaveLength(1);
  await publicPage.getByRole('button', { name: '复制 旅行随机图 API 地址', exact: true }).click();
  await expect
    .poll(() => publicPage.evaluate(() => navigator.clipboard.readText()))
    .toContain('/api/v1/folders/');
  await publicPage.screenshot({ path: 'test-results/public-desktop.png', fullPage: true });
  await publicPage.setViewportSize({ width: 768, height: 1024 });
  expect(
    await publicPage
      .locator('.service-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(2);
  await publicPage.screenshot({ path: 'test-results/public-tablet.png', fullPage: true });
  await publicPage.setViewportSize({ width: 390, height: 844 });
  expect(
    await publicPage
      .locator('.service-grid')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(1);
  expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await publicPage.screenshot({ path: 'test-results/public-mobile.png', fullPage: true });
  await publicPage.setViewportSize({ width: 1280, height: 720 });
  await publicPage.getByRole('link', { name: '图库', exact: true }).click();
  await expect(publicPage.getByText('e2e-image.png', { exact: true })).toBeVisible();
  await publicPage.getByRole('button', { name: '查看 e2e-image.png' }).click();
  await expect(publicPage.getByRole('dialog')).toBeVisible();
  const src = await publicPage
    .getByRole('dialog')
    .locator('.preview-image img')
    .getAttribute('src');
  expect((await request.get(src!)).status()).toBe(200);
  await publicPage.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('link', { name: '资源文件夹', exact: true }).click();
  await page.getByRole('button', { name: /旅行/ }).click();
  await page.getByRole('tab', { name: '权限', exact: true }).click();
  await page.getByLabel('文件夹自身权限').selectOption('private');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('当前有效权限：私有')).toBeVisible();
  expect((await request.get(src!)).status()).toBe(404);
  await publicPage.reload();
  await expect(publicPage.getByText('还没有符合条件的图片')).toBeVisible();
  await page.getByRole('tab', { name: '图片', exact: true }).click();
  await page.getByLabel('选择 e2e-image.png').check();
  await page.getByRole('button', { name: '移入回收站' }).click();
  await expect(page.getByText('留一点空间，给新的图片。')).toBeVisible();
  await page.getByRole('link', { name: '回收站', exact: true }).click();
  await expect(page.getByText('e2e-image.png', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByText('回收站是空的。')).toBeVisible();
  await page.getByRole('link', { name: '资源文件夹', exact: true }).click();
  await page.getByRole('button', { name: /旅行/ }).click();
  await page.screenshot({ path: 'test-results/admin-desktop.png', fullPage: true });
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await publicPage.goto('/');
  await publicPage.screenshot({ path: 'test-results/public-empty-mobile.png', fullPage: true });
  expect(await publicPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '展开管理导航' }).click();
  await page.getByRole('link', { name: '设置中心', exact: true }).click();
  await expect(page.getByRole('heading', { name: '设置中心', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -235, 0)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/settings-mobile.png', fullPage: true });
  expect(browserErrors).toEqual([]);
  await visitor.close();
});

test('scoped multi-resource key form, site settings and dark theme work in the browser', async ({
  page,
}) => {
  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('link', { name: '设置中心', exact: true }).click();
  await page.getByRole('button', { name: 'API Key', exact: true }).click();
  await page.getByRole('button', { name: '创建密钥', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('密钥名称').fill('独立应用');
  await dialog.getByLabel('图片读取', { exact: true }).check();
  await dialog.getByLabel('私有图片读取', { exact: true }).check();
  await dialog.getByLabel('随机图服务调用', { exact: true }).check();
  const first = dialog.getByRole('group', { name: '范围 1', exact: true });
  await first.getByLabel('目标资源').selectOption({ label: '旅行' });
  await dialog.getByRole('button', { name: '添加范围' }).click();
  const second = dialog.getByRole('group', { name: '范围 2', exact: true });
  await second.getByLabel('授权类型').selectOption('service');
  await second.getByLabel('目标资源').selectOption({ label: '旅行随机图' });
  await dialog.getByLabel('每分钟请求上限').fill('0');
  await dialog.getByRole('button', { name: '创建并显示密钥' }).click();
  await expect(dialog.getByRole('heading', { name: '请保存你的 API Key' })).toBeVisible();
  await expect(dialog.locator('.secret-value')).toContainText('xh_');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByText('独立应用', { exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/xh_[a-f0-9]{64}/);
  await page.getByRole('button', { name: '站点设置', exact: true }).click();
  await page.getByLabel('站点名称').fill('XHImg 测试');
  await page.getByRole('button', { name: '保存站点设置' }).click();
  await expect(page.getByRole('link', { name: 'XHImg 测试 首页' })).toBeVisible();
  await expect(page).toHaveTitle(/XHImg 测试/);
  await page.getByRole('button', { name: '主题：跟随系统' }).click();
  await page.getByRole('button', { name: '主题：浅色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ path: 'test-results/settings-dark.png', fullPage: true });
});
