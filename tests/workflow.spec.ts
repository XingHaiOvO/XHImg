import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function loginInteractions(page: import('@playwright/test').Page) {
  const state = JSON.parse(await readFile('.cache/e2e-session.json', 'utf8'));
  await page.context().addCookies(state.cookies);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '一切，井然有序。' })).toBeVisible();
}

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
  await page.context().storageState({ path: '.cache/e2e-session.json' });
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
  await expect(page.locator('.desktop-sidebar')).toBeHidden();
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

test('processing settings, interrupted transfer, refresh/reselect resume and AI organization work together', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('link', { name: '设置中心', exact: true }).click();
  await page.getByRole('button', { name: '图片处理', exact: true }).click();
  await page.getByLabel('启用图片处理', { exact: true }).check();
  await page.getByLabel('输出格式').selectOption('webp');
  await page.getByLabel('最大宽度（像素）').fill('640');
  await page.getByRole('button', { name: '保存处理策略' }).click();
  await expect(page.locator('.notice[role=status]')).toContainText('已保存');
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click();
  await page
    .getByLabel('API Base URL')
    .fill((await readFile('.cache/e2e-model.txt', 'utf8')).trim());
  await page.getByLabel('模型名称').fill('fixture');
  await page.getByLabel('启用 AI 自动分类').check();
  await page.getByLabel('旅行（私有）', { exact: true }).check();
  await page.getByRole('button', { name: '保存并测试模型' }).click();
  await expect(page.locator('.notice[role=status]')).toContainText('视觉输入和分类输出测试通过');
  await page.getByRole('link', { name: '智能整理', exact: true }).click();
  await page.getByRole('button', { name: '手动任务', exact: true }).click();
  await page.getByLabel('来源文件夹').selectOption({ label: '旅行' });
  await page.getByLabel('搜索已有图片').fill('does-not-exist');
  await expect(page.getByText('没有符合条件的图片。')).toBeVisible();
  await page.getByLabel('搜索已有图片').fill('e2e-image');
  await expect(page.getByText('尚未分类', { exact: true })).toBeVisible();
  await page.getByLabel('选择 e2e-image.png').check();
  await page.screenshot({ path: 'test-results/manual-classification-desktop.png', fullPage: true });
  await page.getByRole('button', { name: '执行整理', exact: true }).click();
  await expect(page.locator('.notice[role=status]')).toContainText('已安排 1 张图片整理');
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/v1/admin/images?search=e2e-image');
        return (await response.json()).items[0]?.classificationStatus;
      },
      { timeout: 15000 },
    )
    .toBe('completed');
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await expect(page.getByText('e2e-image.png', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: '手动任务', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('来源文件夹').selectOption({ label: '旅行' });
  await expect(page.getByText('e2e-image.png', { exact: true })).toBeVisible();
  await expect(page.locator('.desktop-sidebar')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/manual-classification-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: '上传中心', exact: true }).click();
  let held = false;
  let confirmedOffset = 0,
    resumeHeld = false;
  let release: () => void = () => {};
  let releaseResume: () => void = () => {};
  await page.evaluate(() => {
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      (window as any).__lastUploadXHR = this;
      return send.call(this, body);
    };
  });
  await page.route('**/api/v1/resumable/*', async (route) => {
    if (
      route.request().method() === 'PATCH' &&
      route.request().headers()['upload-offset'] !== '0' &&
      !held
    ) {
      held = true;
      confirmedOffset = Number(route.request().headers()['upload-offset']);
      await new Promise<void>((r) => (release = r));
      try {
        await route.abort();
      } catch {}
      return;
    }
    if (route.request().method() === 'PATCH' && held && !resumeHeld) {
      resumeHeld = true;
      await new Promise<void>((r) => (releaseResume = r));
      await route.abort().catch(() => {});
      return;
    }
    await route.continue();
  });
  await page.getByLabel('选择上传图片').setInputFiles(resolve('.cache/e2e-large.png'));
  await expect.poll(() => held).toBe(true);
  await page.evaluate(() =>
    (window as any).__lastUploadXHR.upload.dispatchEvent(
      new ProgressEvent('progress', {
        lengthComputable: true,
        loaded: 2 * 1024 * 1024,
        total: 4 * 1024 * 1024,
      }),
    ),
  );
  const fileLength = (await readFile('.cache/e2e-large.png')).length;
  await expect(page.getByRole('progressbar')).toHaveAttribute(
    'value',
    String(Math.round(((confirmedOffset + 2 * 1024 * 1024) / fileLength) * 100)),
  );
  const pausedProgress = await page.getByRole('progressbar').getAttribute('value');
  expect(Number(pausedProgress)).toBeGreaterThan(Math.round((confirmedOffset / fileLength) * 100));
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(page.getByText('已暂停', { exact: true })).toBeVisible();
  release();
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await expect.poll(() => resumeHeld).toBe(true);
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', pausedProgress!);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  releaseResume();
  await page.reload();
  await page.unroute('**/api/v1/resumable/*');
  await expect(page.getByRole('heading', { name: '可恢复的上传' })).toBeVisible();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: '恢复', exact: true }).click();
  const resumed = page.waitForRequest(
    (r) =>
      r.method() === 'PATCH' &&
      r.url().includes('/api/v1/resumable/') &&
      Number(r.headers()['upload-offset']) > 0,
  );
  let workerBlocked = false,
    releaseWorker: () => void = () => {};
  const workerGate = new Promise<void>((r) => (releaseWorker = r));
  await page.route('**/hash.worker-*.js', async (route) => {
    workerBlocked = true;
    await workerGate;
    await route.continue();
  });
  await (await picker).setFiles(resolve('.cache/e2e-large.png'));
  await expect.poll(() => workerBlocked).toBe(true);
  const confirmedProgress = Math.round((confirmedOffset / fileLength) * 100);
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', String(confirmedProgress));
  releaseWorker();
  expect((await resumed).headers()['upload-offset']).toBe(String(confirmedOffset));
  await expect(page.getByText('上传成功', { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await expect(page.getByText('e2e-large.webp', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('row')
      .filter({ has: page.getByText('e2e-large.webp', { exact: true }) })
      .getByRole('cell', { name: '已归档', exact: true }),
  ).toBeVisible();
  const session = await (await page.request.get('/api/v1/auth/me')).json();
  const images = await (await page.request.get('/api/v1/admin/images?search=e2e-large')).json();
  expect(images.total).toBe(1);
  expect(images.items[0].format).toBe('webp');
  expect(images.items[0].name).toBe('e2e-large.webp');
  expect(images.items[0].width).toBe(640);
  expect(images.items[0].hasOriginal).toBe(true);
  await page.getByLabel('选择 e2e-large.webp').check();
  await page.getByLabel('人工归档目标').selectOption('uncategorized');
  await page.getByRole('button', { name: '人工归档', exact: true }).click();
  await expect(page.locator('.notice[role=status]')).toContainText('已人工归档');
  await page.screenshot({ path: 'test-results/p1-organization-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.desktop-sidebar')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/p1-organization-mobile.png', fullPage: true });
  await page.request.put('/api/v1/admin/ai', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: { enabled: false },
  });
  await page.request.put('/api/v1/admin/processing', {
    headers: { 'X-CSRF-Token': session.csrf },
    data: { policy: { enabled: false }, maxUploadMB: 100 },
  });
  expect(errors).toEqual([]);
});

test('cancel freezes hashing and transfer progress and ignores late upload status responses', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { count: 0, terminated: [] as number[], mode: 'gated', late: () => {} };
    (window as any).__uploadHash = state;
    (window as any).Worker = class {
      onmessage: any;
      onerror: any;
      index = ++state.count;
      postMessage() {
        const receive = this.onmessage;
        if (state.mode === 'complete' || this.index === 2) {
          queueMicrotask(() => receive({ data: { hash: '0'.repeat(64) } }));
          return;
        }
        queueMicrotask(() => receive({ data: { progress: 0.2 } }));
        state.late = () => {
          receive({ data: { progress: 0.9 } });
          receive({ data: { hash: '0'.repeat(64) } });
        };
      }
      terminate() {
        state.terminated.push(this.index);
      }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const requests: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/resumable')) requests.push(r.method());
  });
  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('link', { name: '智能整理', exact: true }).click();
  await page.getByLabel('选择上传图片').setInputFiles(resolve('.cache/e2e-large.png'));
  const first = page
    .locator('.upload-queue > div')
    .filter({ has: page.getByText('e2e-large.png', { exact: true }) });
  await expect(first.getByText('校验文件指纹（20%）', { exact: true })).toBeVisible();
  await expect(first.getByRole('progressbar')).toHaveAttribute('value', '0');
  await first.getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => (window as any).__uploadHash.late());
  await expect(first.getByText('已取消', { exact: true })).toBeVisible();
  await expect(first.getByRole('progressbar')).toHaveAttribute('value', '0');
  expect(await page.evaluate(() => (window as any).__uploadHash.terminated)).toContain(1);
  expect(requests).toEqual([]);

  const created = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/resumable'),
  );
  await page.getByLabel('选择上传图片').setInputFiles(resolve('.cache/e2e-image.png'));
  const uploadUrl = (await created).headers().location!;
  await expect.poll(() => page.evaluate(() => (window as any).__uploadHash.count)).toBe(3);
  const second = page
    .locator('.upload-queue > div')
    .filter({ has: page.getByText('e2e-image.png', { exact: true }) });
  const frozen = await second.getByRole('progressbar').getAttribute('value');
  const canceled = page.waitForResponse(
    (r) => r.request().method() === 'DELETE' && r.url().includes('/api/v1/uploads/'),
  );
  await second.getByRole('button', { name: '取消', exact: true }).click();
  expect((await canceled).ok()).toBe(true);
  await page.evaluate(() => (window as any).__uploadHash.late());
  await expect(second.getByText('已取消', { exact: true })).toBeVisible();
  await expect(second.getByRole('progressbar')).toHaveAttribute('value', frozen!);
  expect(requests.filter((method) => method === 'PATCH')).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).__uploadHash.terminated)).toContain(3);
  expect(
    (await (await page.request.get(`/api/v1/uploads/${uploadUrl.split('/').pop()}`)).json()).state,
  ).toBe('canceled');

  await page.reload();
  await page.clock.install();
  await page.evaluate(() => ((window as any).__uploadHash.mode = 'complete'));
  const mockId = 'upl_' + 'a'.repeat(24);
  let length = 0,
    queries = 0,
    release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/resumable', async (route) => {
    length = Number(route.request().headers()['upload-length']);
    await route.fulfill({
      status: 201,
      headers: { 'Tus-Resumable': '1.0.0', Location: `/api/v1/resumable/${mockId}` },
    });
  });
  await page.route('**/api/v1/resumable/*', (route) =>
    route.fulfill({
      status: 204,
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(length) },
    }),
  );
  await page.route(`**/api/v1/uploads/${mockId}`, async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ json: { ok: true } });
      return;
    }
    queries++;
    await held;
    await route
      .fulfill({ json: { uploadId: mockId, state: 'processing', offset: length, length } })
      .catch(() => {});
  });
  await page.getByLabel('选择上传图片').setInputFiles(resolve('.cache/e2e-image.png'));
  await expect.poll(() => queries).toBe(1);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  release();
  await page.clock.runFor(2500);
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
  expect(queries).toBe(1);
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
  expect(errors).toEqual([]);
});

test('storage migration previews selected and filtered images, preserves access and cleans source copies only on confirmation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/login');
  await page.getByLabel('管理员用户名').fill('owner');
  await page.getByLabel('密码', { exact: true }).fill('browser-test-password-123');
  await page.getByRole('button', { name: '登录工作台' }).click();
  await page.getByRole('link', { name: '设置中心', exact: true }).click();
  await page.getByRole('button', { name: '添加存储', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('名称', { exact: true }).fill('迁移目的地');
  await dialog.getByLabel('存储类型').selectOption('local');
  await dialog.getByRole('button', { name: '保存存储', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const storages = (await (await page.request.get('/api/v1/admin/storage-backends')).json()).items,
    target = storages.find((s: any) => s.name === '迁移目的地');
  const before = (await (await page.request.get('/api/v1/admin/images?search=e2e-image')).json())
    .items[0];
  const bytes = await (await page.request.get(before.url)).body();
  await page.getByRole('link', { name: '资源文件夹', exact: true }).click();
  await page.getByRole('button', { name: /旅行/ }).click();
  await page.getByLabel('选择 e2e-image.png').check();
  await page.getByRole('button', { name: '迁移存储', exact: true }).click();
  await dialog.getByLabel('目标存储').selectOption(target.id);
  await dialog.getByRole('button', { name: '预览迁移清单', exact: true }).click();
  await expect(dialog.locator('.migration-preview')).toContainText('清单已冻结：1 张');
  await dialog.getByRole('button', { name: '确认执行迁移', exact: true }).click();
  await expect(page).toHaveURL(/tab=migrations/);
  const details = page.locator('.migration-details');
  await expect(details.getByText('已完成', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(details.getByText('源副本已保留', { exact: true })).toBeVisible();
  const after = (await (await page.request.get('/api/v1/admin/images?search=e2e-image')).json())
    .items[0];
  expect(after.storageId).toBe(target.id);
  expect(after.id).toBe(before.id);
  expect(after.name).toBe(before.name);
  expect(after.visibility).toBe(before.visibility);
  expect(after.url.split('?')[0]).toBe(before.url.split('?')[0]);
  expect(await (await page.request.get(before.url)).body()).toEqual(bytes);
  expect(await (await page.request.get(after.url)).body()).toEqual(bytes);
  const sourceBefore = (
    await (await page.request.get('/api/v1/admin/storage-backends')).json()
  ).items.find((s: any) => s.id === 'local');
  expect(sourceBefore.retainedMigrationObjects).toBeGreaterThan(0);
  expect(sourceBefore.is_default).toBe(1);
  await details.getByRole('button', { name: '清理源副本', exact: true }).click();
  await expect(dialog).toContainText('不能撤销');
  await dialog.getByRole('button', { name: '确认清理源副本', exact: true }).click();
  await expect(details.getByText('清理已完成', { exact: true })).toBeVisible({ timeout: 20000 });
  expect(await (await page.request.get(after.url)).body()).toEqual(bytes);
  await page.getByRole('button', { name: '创建迁移任务', exact: true }).click();
  await dialog.getByLabel('来源存储').selectOption('local');
  await dialog.getByLabel('目标存储').selectOption(target.id);
  await dialog.getByLabel('来源文件夹').selectOption(before.folderId);
  await expect(dialog.getByLabel('包含回收站图片（仍保留删除状态）')).not.toBeChecked();
  await dialog.getByRole('button', { name: '预览迁移清单', exact: true }).click();
  await expect(dialog.locator('.migration-preview')).toContainText('清单已冻结：0 张');
  await expect(dialog.getByRole('button', { name: '确认执行迁移', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.locator('.migration-task').filter({ hasText: '已完成' }).click();
  await expect(
    details.locator('.migration-items').getByText('e2e-image.png', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.desktop-sidebar')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/storage-migration-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.screenshot({ path: 'test-results/storage-migration-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('admin drawer, URL tabs, form failures and accessible destructive confirmation', async ({
  page,
}) => {
  await loginInteractions(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/settings?tab=unknown&task=obsolete');
  await expect(page).toHaveURL(/tab=storage$/);
  const trigger = page.getByRole('button', { name: '展开管理导航' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: '管理导航' });
  await expect(drawer).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.keyboard.press('Shift+Tab');
  expect(await drawer.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: 'test-results/admin-navigation-mobile.png', fullPage: true });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.locator('.navigation-overlay').click({ position: { x: 370, y: 400 } });
  await expect(drawer).toBeHidden();
  await trigger.click();
  await drawer.getByRole('link', { name: '智能整理', exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: '失败任务', exact: true }).click();
  await expect(page).toHaveURL(/tab=failed/);
  await page.reload();
  await expect(page.getByRole('button', { name: '失败任务', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.goto('/admin/settings?tab=migrations&task=not-selected');
  await page.getByRole('button', { name: '图片处理', exact: true }).click();
  await expect(page).toHaveURL(/tab=processing$/);
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click();
  await expect(page).toHaveURL(/tab=ai$/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: '图片处理', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'AI 视觉模型' })).toBeVisible();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/admin-settings-${width}.png`, fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.evaluate(() => {
    localStorage.setItem('theme', 'dark');
  });
  await page.reload();
  await page.screenshot({ path: 'test-results/admin-settings-dark.png', fullPage: true });
  await page.goto('/admin/folders');
  await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建文件夹' });
  await dialog.getByLabel('文件夹名称').fill('交互验证文件夹');
  const originalTitle = await dialog
    .getByLabel('自身权限', { exact: true })
    .getAttribute('aria-describedby');
  expect(originalTitle).toBeTruthy();
  let posts = 0;
  await page.route('**/api/v1/admin/folders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await new Promise((done) => setTimeout(done, 600));
    await route.fulfill({ status: 503, json: { error: { message: '受控保存失败，请重试' } } });
  });
  await dialog.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await dialog.locator('form').evaluate((form) => {
    (form as HTMLFormElement).requestSubmit();
    (form as HTMLFormElement).requestSubmit();
  });
  await expect(dialog.locator('.form-error')).toHaveText('受控保存失败，请重试');
  expect(posts).toBe(1);
  await expect(dialog.getByLabel('文件夹名称')).toHaveValue('交互验证文件夹');
  await page.waitForTimeout(6200);
  await expect(page.locator('.notice.error')).toContainText('受控保存失败');
  await page.unroute('**/api/v1/admin/folders');
  await dialog.getByRole('button', { name: '创建文件夹', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.notice.error')).toContainText('受控保存失败');
  await page.locator('.notice.error').getByRole('button', { name: '关闭提示' }).click();
  await page.getByRole('button', { name: /交互验证文件夹/ }).click();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '删除文件夹', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认操作' });
  await expect(confirmation.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(confirmation).toContainText('交互验证文件夹');
  await page.keyboard.press('Escape');
  await expect(confirmation).toBeHidden();
  await expect(page.getByRole('button', { name: '删除文件夹', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '删除文件夹', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(page.getByRole('heading', { name: '所有图片', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('admin refresh retains content and selection, ignores old searches and retries without data loss', async ({
  page,
}) => {
  await loginInteractions(page);
  await page.goto('/admin/folders');
  const image = (await (await page.request.get('/api/v1/admin/images')).json()).items[0];
  expect(image).toBeTruthy();
  await page.getByLabel(`选择 ${image.name}`, { exact: true }).check();
  const positionBeforeRefresh = await page.locator('.image-grid').boundingBox();
  let mode = 'failure',
    oldSeen = false;
  await page.route('**/api/v1/admin/images?**', async (route) => {
    const search = new URL(route.request().url()).searchParams.get('search');
    if (search === 'old-query') {
      oldSeen = true;
      await new Promise((done) => setTimeout(done, 1200));
      await route
        .fulfill({ json: { items: [{ ...image, name: '迟到旧结果.png' }], total: 1 } })
        .catch(() => {});
    } else if (search === 'new-query') {
      await route.fulfill({ json: { items: [{ ...image, name: '最新结果.png' }], total: 1 } });
    } else if (mode === 'failure') {
      await new Promise((done) => setTimeout(done, 600));
      await route.fulfill({ status: 503, json: { error: { message: '受控刷新失败' } } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '刷新图片', exact: true }).click();
  await expect(page.getByLabel(`选择 ${image.name}`, { exact: true })).toBeChecked();
  await expect(page.locator('.resource-content .refresh-status')).toBeVisible();
  const positionDuringRefresh = await page.locator('.image-grid').boundingBox();
  expect(positionDuringRefresh?.y).toBe(positionBeforeRefresh?.y);
  await expect(page.locator('.resource-content .query-error')).toContainText(
    '仍显示上次成功的数据',
  );
  await expect(page.getByLabel(`选择 ${image.name}`, { exact: true })).toBeChecked();
  mode = 'success';
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.resource-content .query-error')).toHaveCount(0);
  await expect(page.getByLabel(`选择 ${image.name}`, { exact: true })).toBeChecked();
  const search = page.getByRole('textbox', { name: '搜索当前图片' });
  await search.fill('old-query');
  await expect.poll(() => oldSeen).toBe(true);
  await expect(page.getByLabel(`选择 ${image.name}`, { exact: true })).toHaveCount(0);
  await search.fill('new-query');
  await expect(page.getByText('最新结果.png', { exact: true })).toBeVisible();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await page.waitForTimeout(1400);
  await expect(page.getByText('迟到旧结果.png', { exact: true })).toHaveCount(0);
  await expect(page.getByText('最新结果.png', { exact: true })).toBeVisible();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/admin-resources-${width}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.folder-tree')).toBeHidden();
  await page.locator('.folder-tree-toggle').click();
  await expect(page.locator('.folder-tree')).toBeVisible();
  await page.unroute('**/api/v1/admin/images?**');
  let firstLoad = true;
  await page.route('**/api/v1/admin/images?**', async (route) => {
    if (firstLoad) {
      firstLoad = false;
      await route.fulfill({ status: 503, json: { error: { message: '首次加载失败' } } });
    } else await route.continue();
  });
  await page.goto('/admin/trash');
  await expect(page.locator('.query-error')).toContainText('首次加载失败');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.query-error')).toHaveCount(0);
});

test('task polling is serial, pauses when hidden and stops after active tasks finish', async ({
  page,
}) => {
  await loginInteractions(page);
  let calls = 0,
    inFlight = 0,
    maximum = 0,
    completed = false;
  await page.route('**/api/v1/admin/classification?**', async (route) => {
    calls++;
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    if (calls > 1) await new Promise((done) => setTimeout(done, 3500));
    inFlight--;
    await route.fulfill({
      json: {
        items: [
          {
            id: 'polling-fixture',
            name: '长任务状态验证'.repeat(12) + '.png',
            folderId: 'uncategorized',
            classificationStatus: completed ? 'completed' : 'pending',
          },
        ],
        total: 1,
      },
    });
  });
  await page.goto('/admin/organize?tab=all');
  await expect(page.getByText('等待分类', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenCalls = calls;
  await page.waitForTimeout(3300);
  expect(calls).toBe(hiddenCalls);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => calls).toBe(hiddenCalls + 1);
  await page.waitForTimeout(3100);
  expect(calls).toBe(hiddenCalls + 1);
  completed = true;
  await expect(page.getByText('已归档', { exact: true })).toBeVisible({ timeout: 10000 });
  const finalCalls = calls;
  await page.waitForTimeout(3300);
  expect(calls).toBe(finalCalls);
  expect(maximum).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect
    .poll(() =>
      page.locator('.tabs .active').evaluate((el) => {
        const r = el.getBoundingClientRect(),
          p = el.parentElement!.getBoundingClientRect();
        return r.left >= p.left - 1 && r.right <= p.right + 1;
      }),
    )
    .toBe(true);
  await page.screenshot({ path: 'test-results/admin-organization-mobile.png', fullPage: true });
});

test('migration controls and key revocation use confirmations and retain retry actions', async ({
  page,
}) => {
  await loginInteractions(page);
  const csrf = (await (await page.request.get('/api/v1/auth/me')).json()).csrf;
  const headers = { origin: 'http://127.0.0.1:9522', 'x-csrf-token': csrf };
  const image = (await (await page.request.get('/api/v1/admin/images')).json()).items[0];
  const target = await (
    await page.request.post('/api/v1/admin/storage-backends', {
      headers,
      data: { name: '交互控制目标', type: 'local', config: {} },
    })
  ).json();
  const draft = await (
    await page.request.post('/api/v1/admin/storage-migrations', {
      headers,
      data: { targetStorageId: target.id, imageIds: [image.id] },
    })
  ).json();
  expect(draft.id).toBeTruthy();
  let state = 'running',
    failed = 0;
  const actions: string[] = [];
  await page.route(`**/api/v1/admin/storage-migrations/${draft.id}`, (route) =>
    route.fulfill({ json: { ...draft, state, failed_count: failed } }),
  );
  await page.route(`**/api/v1/admin/storage-migrations/${draft.id}/*`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const action = route.request().url().split('/').pop()!;
    actions.push(action);
    state = (
      { pause: 'paused', resume: 'running', cancel: 'canceled', retry: 'queued' } as Record<
        string,
        string
      >
    )[action];
    failed = 0;
    await route.fulfill({ json: { ...draft, state, failed_count: failed } });
  });
  await page.goto(`/admin/settings?tab=migrations&task=${draft.id}`);
  const details = page.locator('.migration-details');
  await details.getByRole('button', { name: '暂停迁移', exact: true }).click();
  await expect(details.getByRole('button', { name: '继续迁移', exact: true })).toBeVisible();
  await details.getByRole('button', { name: '继续迁移', exact: true }).click();
  await details.getByRole('button', { name: '取消迁移', exact: true }).click();
  const migrationConfirm = page.getByRole('dialog', { name: '确认取消迁移' });
  await migrationConfirm.getByRole('button', { name: '关闭', exact: true }).click();
  expect(actions).toEqual(['pause', 'resume']);
  await details.getByRole('button', { name: '取消迁移', exact: true }).click();
  await migrationConfirm.getByRole('button', { name: '确认取消迁移', exact: true }).click();
  await expect(
    details.locator('.section-heading .badge').filter({ hasText: '已取消' }),
  ).toBeVisible();
  state = 'failed';
  failed = 1;
  await details.getByRole('button', { name: '刷新任务', exact: true }).click();
  await details.getByRole('button', { name: '重试失败图片', exact: true }).click();
  await expect(details.getByRole('button', { name: '暂停迁移', exact: true })).toBeVisible();
  expect(actions).toEqual(['pause', 'resume', 'cancel', 'retry']);
  await page.goto('/admin/settings?tab=keys');
  const key = page.getByRole('row').filter({ hasText: '独立应用' });
  await key.getByRole('button', { name: '撤销', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '确认操作' });
  await expect(confirm).toContainText('独立应用');
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(key.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await key.getByRole('button', { name: '撤销', exact: true }).click();
  await confirm.getByRole('button', { name: '确认执行', exact: true }).click();
  await expect(key.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

test('S3 images load directly with valid signatures, copy both addresses and recover once through logical URLs', async ({
  page,
  browser,
}) => {
  await loginInteractions(page);
  const config = JSON.parse(await readFile('.cache/e2e-s3.json', 'utf8'));
  await page.goto('/admin/settings?tab=storage');
  await page.getByRole('button', { name: '添加存储', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '添加存储' });
  await dialog.getByLabel('名称', { exact: true }).fill('S3 直链夹具');
  await dialog.getByLabel('Endpoint', { exact: true }).fill(config.endpoint);
  await dialog.getByLabel('Region', { exact: true }).fill(config.region);
  await dialog.getByLabel('Bucket', { exact: true }).fill(config.bucket);
  await dialog.getByLabel('Access Key', { exact: true }).fill(config.accessKeyId);
  await dialog.getByLabel('Secret Key', { exact: true }).fill(config.secretAccessKey);
  const reloaded = page.waitForEvent('load');
  await dialog.getByRole('button', { name: '保存存储', exact: true }).click();
  await reloaded;
  await expect(page.getByRole('heading', { name: 'S3 直链夹具', exact: true })).toBeVisible();
  const csrf = (await (await page.request.get('/api/v1/auth/me')).json()).csrf;
  const headers = { origin: 'http://127.0.0.1:9522', 'x-csrf-token': csrf };
  const backend = (
    await (await page.request.get('/api/v1/admin/storage-backends')).json()
  ).items.find((item: any) => item.name === 'S3 直链夹具');
  const folder = await (
    await page.request.post('/api/v1/admin/folders', {
      headers,
      data: { name: 'S3 公开图片', visibility: 'public' },
    })
  ).json();
  const params = new URLSearchParams({
    storageId: backend.id,
    folderId: folder.id,
    visibility: 'public',
    processing: JSON.stringify({ enabled: false }),
    classify: 'false',
  });
  const upload = await page.request.post('/api/v1/upload?' + params, {
    headers,
    multipart: {
      file: {
        name: 's3-browser.png',
        mimeType: 'image/png',
        buffer: await readFile('.cache/e2e-image.png'),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const uploaded = await upload.json();
  expect(uploaded.urlExpiresAt).toBeTruthy();
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/admin/images?search=s3-browser')).json()).items[0]
          ?.thumbnailState,
    )
    .toBe('ready');
  const pageUrl = `/admin/folders?folder=${folder.id}`;
  await page.goto(pageUrl);
  const thumbnail = page.getByRole('button', { name: '查看 s3-browser.png', exact: true });
  await expect
    .poll(() => thumbnail.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  const thumbnailSource = await thumbnail.locator('img').getAttribute('src');
  expect(new URL(thumbnailSource!).origin).toBe(config.endpoint);
  expect(new URL(thumbnailSource!).searchParams.has('previewRetry')).toBe(false);
  expect((await page.request.get('/')).headers()['content-security-policy']).toContain(
    config.endpoint,
  );
  await thumbnail.click();
  const preview = page.getByRole('dialog', { name: 's3-browser.png' });
  await expect
    .poll(() =>
      preview.locator('.preview-image img').evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  const currentSource = await preview.locator('.preview-image img').getAttribute('src');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await preview.getByRole('button', { name: '复制 S3 临时地址', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(currentSource);
  await preview.getByRole('button', { name: '复制站内地址', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `http://127.0.0.1:9522/i/${uploaded.id}`,
  );
  await expect(preview).toContainText('最长有效 5 分钟');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/s3-preview-mobile.png', fullPage: true });
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await page.evaluate(() => localStorage.setItem('theme', 'dark'));
  await page.reload();
  await expect
    .poll(() => thumbnail.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/s3-gallery-dark.png', fullPage: true });
  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(`/gallery?folder=${folder.id}`);
  await expect
    .poll(() =>
      publicPage
        .getByRole('button', { name: '查看 s3-browser.png', exact: true })
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
  await visitor.close();
  // Expired metadata must use the site URL without mutating an S3 signature.
  await page.route('**/api/v1/admin/images?**', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      json: {
        ...data,
        items: data.items.map((item: any) => ({
          ...item,
          urlExpiresAt: Date.now() - 1,
          thumbnailUrlExpiresAt: Date.now() - 1,
        })),
      },
    });
  });
  await page.goto(pageUrl);
  await expect(thumbnail.locator('img')).toHaveAttribute('src', `/t/${uploaded.id}`);
  await expect
    .poll(() => thumbnail.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await thumbnail.click();
  await expect(
    preview.getByRole('button', { name: '复制 S3 临时地址', exact: true }),
  ).toBeDisabled();
  await expect(preview.locator('.preview-image img')).toHaveAttribute('src', `/i/${uploaded.id}`);
  await preview.getByRole('button', { name: '关闭', exact: true }).click();
  await page.unroute('**/api/v1/admin/images?**');
  // Fail both the direct request and its one automatic fallback. No retry loop.
  let directCalls = 0,
    logicalCalls = 0;
  await page.route(config.endpoint + '/**', (route) => {
    directCalls++;
    return route.fulfill({ status: 403, body: 'Expired fixture' });
  });
  await page.route(`**/t/${uploaded.id}*`, (route) => {
    logicalCalls++;
    return route.fulfill({ status: 404, body: 'Missing fixture' });
  });
  await page.goto(pageUrl);
  await expect(thumbnail).toContainText('加载失败，点击重试');
  await page.waitForTimeout(4200);
  expect(directCalls).toBe(1);
  expect(logicalCalls).toBe(1);
  await thumbnail.click();
  await expect.poll(() => logicalCalls).toBe(2);
  expect(directCalls).toBe(1);
});
