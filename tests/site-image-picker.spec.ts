import { expect, test, type Page } from '@playwright/test';

const images = Array.from({ length: 85 }, (_, index) => ({
  id: `picker-${index + 1}`,
  name: index === 84 ? '存档封面.png' : `图库图片 ${index + 1}.png`,
  folderId: index >= 40 ? 'archive' : 'recent',
  tags: index === 84 ? ['旧壁纸'] : [],
  url: 'https://s3.example.invalid/temporary-image',
  logicalUrl: `/i/picker-${index + 1}`,
  thumbnailUrl: '/picker-thumbnail.svg',
}));

async function mockSettings(page: Page) {
  const writes: { logoUrl: string; homeBackgroundUrl: string }[] = [];
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ json: { username: 'owner', csrf: 'test' } }),
  );
  await page.route('**/api/v1/admin/settings', (route) => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { title: '图库', allowedOrigins: [] } });
  });
  await page.route('**/picker-thumbnail.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  );
  return writes;
}

function response(query: URLSearchParams, library = images) {
  const page = Number(query.get('page'));
  const limit = Number(query.get('limit'));
  const folder = query.get('folderId');
  const search = query.get('search');
  const matches = library.filter(
    (image) =>
      (!folder || image.folderId === folder) &&
      (!search || image.name.includes(search) || image.tags.some((tag) => tag.includes(search))),
  );
  return {
    items: matches.slice((page - 1) * limit, page * limit),
    total: matches.length,
    page,
    limit,
  };
}

const backgroundPicker = (page: Page) =>
  page.locator('.settings-background').getByRole('button', { name: '从图库选择' });
const logoPicker = (page: Page) =>
  page.locator('.settings-logo').getByRole('button', { name: '从图库选择' });

test('site background and logo can use images beyond the first 40', async ({ page }) => {
  const writes = await mockSettings(page);
  await page.route('**/api/v1/public/folders', (route) => route.fulfill({ json: { items: [] } }));
  const queries: URLSearchParams[] = [];
  const adminListRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/admin/images' && url.searchParams.get('trash') !== 'true')
      adminListRequests.push(url.href);
  });
  await page.route('**/api/v1/public/images?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    return route.fulfill({ json: response(query) });
  });
  await page.goto('/admin/settings?tab=site');
  await backgroundPicker(page).click();
  const background = page.getByRole('dialog', { name: '从图库选择' });
  await expect(background.getByText('共 85 张图片')).toBeVisible();
  await expect(background.getByRole('button', { name: /^选择图片：/ })).toHaveCount(40);
  await background.getByRole('button', { name: '下一页' }).click();
  await expect(background.getByText('第 2 / 3 页')).toBeVisible();
  await expect(background.getByRole('region', { name: '选图结果' })).toBeFocused();
  await background.getByRole('button', { name: '下一页' }).click();
  await expect(background.getByText('第 3 / 3 页')).toBeVisible();
  await background.getByRole('button', { name: '选择图片：存档封面.png' }).click();
  await expect(background).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '首页背景图片' })).toHaveValue(
    new URL('/i/picker-85', page.url()).href,
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await logoPicker(page).click();
  const logo = page.getByRole('dialog', { name: '选择站点图标' });
  await expect(logo.getByText('第 1 / 3 页')).toBeVisible();
  const next = logo.getByRole('button', { name: '下一页' });
  await next.scrollIntoViewIfNeeded();
  await next.focus();
  await page.keyboard.press('Enter');
  const choice = logo.getByRole('button', { name: '选择图片：图库图片 41.png', exact: true });
  await expect(choice).toBeInViewport();
  await choice.focus();
  await page.keyboard.press('Enter');
  await expect(logo).toHaveCount(0);
  await expect(logoPicker(page)).toBeFocused();
  await expect(page.getByRole('textbox', { name: '站点图标' })).toHaveValue(
    new URL('/i/picker-41', page.url()).href,
  );
  expect(writes).toHaveLength(0);
  await page
    .locator('.settings-action-buttons')
    .getByRole('button', { name: '保存站点设置' })
    .click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({
    homeBackgroundUrl: new URL('/i/picker-85', page.url()).href,
    logoUrl: new URL('/i/picker-41', page.url()).href,
  });
  expect(queries.map((query) => query.get('page'))).toEqual(['1', '2', '3', '1', '2']);
  expect(
    queries.every((query) => query.get('limit') === '40' && query.get('sort') === 'newest'),
  ).toBe(true);
  expect(adminListRequests).toEqual([]);
});

test('picker filters, retries and ignores a superseded search', async ({ page }) => {
  await mockSettings(page);
  let foldersFailed = false;
  await page.route('**/api/v1/public/folders', (route) => {
    if (!foldersFailed) {
      foldersFailed = true;
      return route.fulfill({ status: 503, json: { error: { message: '文件夹暂不可用' } } });
    }
    return route.fulfill({
      json: {
        items: [
          { id: 'archive', name: '旧图库' },
          { id: 'recent', name: '近期' },
        ],
      },
    });
  });
  let searchFailed = false;
  const slowStarted = Promise.withResolvers<void>();
  const releaseSlow = Promise.withResolvers<void>();
  const slowFinished = Promise.withResolvers<void>();
  await page.route('**/api/v1/public/images?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('search') === '慢查询') {
      slowStarted.resolve();
      await releaseSlow.promise;
      try {
        await route.fulfill({ json: { items: [images[0]], total: 1 } });
      } finally {
        slowFinished.resolve();
      }
      return;
    }
    if (query.get('search') === '旧壁纸' && !searchFailed) {
      searchFailed = true;
      await route.fulfill({ status: 503, json: { error: { message: '图片暂不可用' } } });
      return;
    }
    await route.fulfill({ json: response(query) });
  });
  await page.goto('/admin/settings?tab=site');
  await backgroundPicker(page).click();
  const dialog = page.getByRole('dialog', { name: '从图库选择' });
  const search = dialog.getByRole('searchbox', { name: '搜索图片名称或标签' });
  const folder = dialog.getByRole('combobox', { name: '筛选文件夹' });
  const results = dialog.getByRole('region', { name: '选图结果' });
  await expect(dialog.getByText('文件夹暂不可用')).toBeVisible();
  await dialog.getByRole('button', { name: '下一页' }).click();
  await expect(dialog.getByText('第 2 / 3 页')).toBeVisible();
  await dialog
    .getByRole('group', { name: '公开文件夹' })
    .getByRole('button', { name: '重试' })
    .click();
  await folder.selectOption('archive');
  await expect(dialog.getByText('第 1 / 2 页')).toBeVisible();
  await expect(dialog.getByText('共 45 张图片')).toBeVisible();
  await search.fill('旧壁纸');
  await expect(results.getByText('图片暂不可用')).toBeVisible();
  await results.getByRole('button', { name: '重试' }).click();
  await expect(search).toHaveValue('旧壁纸');
  await expect(folder).toHaveValue('archive');
  await expect(results.getByRole('button', { name: '选择图片：存档封面.png' })).toBeVisible();
  await folder.selectOption('recent');
  await expect(results.getByText('没有符合条件的公开图片')).toBeVisible();
  await folder.selectOption('');
  await search.fill('慢查询');
  await slowStarted.promise;
  await search.fill('存档封面');
  await expect(results.getByRole('button', { name: '选择图片：存档封面.png' })).toBeVisible();
  releaseSlow.resolve();
  await slowFinished.promise;
  await expect(results.getByRole('button', { name: /^选择图片：/ })).toHaveCount(1);
  await expect(results.getByRole('button', { name: '选择图片：存档封面.png' })).toBeVisible();
  await page.keyboard.press('Escape');
  await backgroundPicker(page).click();
  await expect(search).toHaveValue('');
  await expect(folder).toHaveValue('');
  await expect(dialog.getByText('第 1 / 3 页')).toBeVisible();
});

test('picker corrects a page that disappears and handles an empty public library', async ({
  page,
}) => {
  await mockSettings(page);
  let library = images;
  await page.route('**/api/v1/public/folders', (route) => route.fulfill({ json: { items: [] } }));
  await page.route('**/api/v1/public/images?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('page') === '3') library = library.slice(0, 41);
    return route.fulfill({ json: response(query, library) });
  });
  await page.goto('/admin/settings?tab=site');
  await backgroundPicker(page).click();
  const dialog = page.getByRole('dialog', { name: '从图库选择' });
  const next = dialog.getByRole('button', { name: '下一页' });
  await next.click();
  await expect(dialog.getByText('第 2 / 3 页')).toBeVisible();
  await next.click();
  await expect(dialog.getByText('第 2 / 2 页')).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^选择图片：/ })).toHaveCount(1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  library = [];
  await backgroundPicker(page).click();
  await expect(dialog.getByText('图库中还没有公开图片')).toBeVisible();
});
