import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('slug form saves, edits and clears aliases used by admin and public actions', async ({
  page,
}) => {
  const setup = await (await page.request.get('/api/v1/setup')).json();
  if (setup.installed) {
    // Reuse the existing workflow session when running the complete browser suite.
    const state = JSON.parse(await readFile('.cache/e2e-session.json', 'utf8'));
    await page.context().addCookies(state.cookies);
  } else {
    const installed = await page.request.post('/api/v1/setup', {
      data: {
        token: (await readFile('.cache/e2e-token.txt', 'utf8')).trim(),
        username: 'owner',
        password: 'browser-test-password-123',
      },
    });
    expect(installed.status()).toBe(201);
    const login = await page.request.post('/api/v1/auth/login', {
      data: { username: 'owner', password: 'browser-test-password-123' },
    });
    expect(login.status()).toBe(200);
  }
  const session = await page.request.get('/api/v1/auth/me');
  expect(session.status()).toBe(200);
  const headers = { 'X-CSRF-Token': (await session.json()).csrf };
  const folder = await page.request.post('/api/v1/admin/folders', {
    headers,
    data: { name: 'slug sources', visibility: 'public' },
  });
  expect(folder.status()).toBe(201);
  const uploaded = await page.request.post(
    `/api/v1/upload?folderId=${(await folder.json()).id}&visibility=public`,
    {
      headers,
      multipart: {
        file: {
          name: 'slug.png',
          mimeType: 'image/png',
          buffer: await readFile('.cache/e2e-image.png'),
        },
      },
    },
  );
  expect(uploaded.status()).toBe(201);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/admin/services');
  await page.getByRole('button', { name: '创建服务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('服务名称').fill('Slug 随机图');
  await dialog.getByLabel('接口 slug').fill(' Wallpaper ');
  await expect(dialog.getByText('/api/v1/random/wallpaper', { exact: true })).toBeVisible();
  await dialog.getByLabel('访问策略').selectOption('public');
  await dialog.getByLabel('每分钟调用上限（每调用者）').fill('0');
  await dialog.getByLabel('启用此服务').check();
  await dialog.getByRole('button', { name: '保存服务' }).click();
  await expect(dialog).not.toBeVisible();
  const card = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Slug 随机图', exact: true }) });
  await expect(card.locator('code')).toHaveText('/api/v1/random/wallpaper');
  await card.getByRole('button', { name: '复制 Slug 随机图 接口', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('/api/v1/random/wallpaper');
  await card.getByRole('button', { name: '配置', exact: true }).click();
  await expect(dialog.getByLabel('接口 slug')).toHaveValue('wallpaper');
  await dialog.getByLabel('接口 slug').fill('travel');
  await dialog.getByRole('button', { name: '保存服务' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(card.locator('code')).toHaveText('/api/v1/random/travel');
  const services = await (await page.request.get('/api/v1/admin/random-services')).json();
  const service = services.items.find((s: any) => s.slug === 'travel');
  expect((await page.request.get('/api/v1/random/wallpaper?mode=json')).status()).toBe(404);
  expect((await page.request.get(`/api/v1/random/${service.id}?mode=json`)).status()).toBe(200);

  const visitor = await page.context().browser()!.newContext();
  try {
    await visitor.grantPermissions(['clipboard-read', 'clipboard-write']);
    const publicPage = await visitor.newPage();
    await publicPage.goto('http://127.0.0.1:9522/');
    await expect(
      publicPage.getByRole('heading', { name: 'Slug 随机图', exact: true }),
    ).toBeVisible();
    const refreshed = publicPage.waitForResponse((r) =>
      r.url().includes('/api/v1/random/travel?mode=json'),
    );
    await publicPage.getByRole('button', { name: '刷新 Slug 随机图 图片', exact: true }).click();
    expect((await refreshed).status()).toBe(200);
    await publicPage
      .getByRole('button', { name: '复制 Slug 随机图 API 地址', exact: true })
      .click();
    await expect
      .poll(() => publicPage.evaluate(() => navigator.clipboard.readText()))
      .toContain('/api/v1/random/travel');
  } finally {
    await visitor.close();
  }
  await card.getByRole('button', { name: '配置', exact: true }).click();
  await dialog.getByLabel('接口 slug').fill('');
  await dialog.getByRole('button', { name: '保存服务' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(card.locator('code')).toHaveText(`/api/v1/random/${service.id}`);
  expect((await page.request.get('/api/v1/random/travel?mode=json')).status()).toBe(404);
  expect((await page.request.get(`/api/v1/random/${service.id}?mode=json`)).status()).toBe(200);
});
