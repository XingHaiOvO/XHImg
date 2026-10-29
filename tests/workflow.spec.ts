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
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByRole('button', { name: 'AI 模型', exact: true }).click();
  await page
    .getByLabel('API Base URL')
    .fill((await readFile('.cache/e2e-model.txt', 'utf8')).trim());
  await page.getByLabel('模型名称').fill('fixture');
  await page.getByLabel('启用 AI 自动分类').check();
  await page.getByLabel('旅行（私有）', { exact: true }).check();
  await page.getByRole('button', { name: '保存并测试模型' }).click();
  await expect(page.getByRole('status')).toContainText('视觉输入和分类输出测试通过');
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
  await expect(page.getByRole('status')).toContainText('已安排 1 张图片整理');
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
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -235, 0)');
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
  await expect(page.getByRole('status')).toContainText('已人工归档');
  await page.screenshot({ path: 'test-results/p1-organization-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -235, 0)');
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
