import { expect, test } from '@playwright/test';

const folders = [
  {
    id: 'mixed',
    parent_id: null,
    name: '混合文件夹',
    count: 42,
    size: 420,
    effective_visibility: 'public',
  },
  {
    id: 'other',
    parent_id: null,
    name: '另一个文件夹',
    count: 1,
    size: 10,
    effective_visibility: 'public',
  },
];
const resources = [
  ...Array.from({ length: 41 }, (_, index) => ({
    id: `image-${index + 1}`,
    folderId: 'mixed',
    name: `图片 ${index + 1}.png`,
    format: 'png',
    tags: [],
  })),
  { id: 'video-1', folderId: 'mixed', name: '海边.mp4', format: 'mp4', tags: ['风景'] },
  { id: 'video-2', folderId: 'other', name: '山谷.mp4', format: 'mp4', tags: [] },
];

test('resource media filtering combines with folder and search and clears old selections', async ({
  page,
}) => {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ json: { username: 'owner', csrf: 'test' } }),
  );
  await page.route('**/api/v1/admin/folders', (route) =>
    route.fulfill({ json: { items: folders } }),
  );
  await page.route('**/api/v1/admin/storage-backends', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route('**/resource-filter.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>',
    }),
  );
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const queries: URLSearchParams[] = [];
  let delayImages = false;
  await page.route('**/api/v1/admin/images?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get('trash') === 'true') return route.fulfill({ json: { items: [], total: 0 } });
    queries.push(query);
    const folder = query.get('folderId');
    const media = query.get('mediaType');
    const search = query.get('search') ?? '';
    const currentPage = Number(query.get('page'));
    const matches = resources.filter(
      (item) =>
        (!folder || item.folderId === folder) &&
        (!media || media === (item.format === 'mp4' ? 'video' : 'image')) &&
        (item.name.includes(search) || item.tags.some((tag) => tag.includes(search))),
    );
    const json = {
      total: matches.length,
      items: matches.slice((currentPage - 1) * 40, currentPage * 40).map((item) => ({
        ...item,
        width: 16,
        height: 16,
        size: 10,
        url: `/i/${item.id}`,
        thumbnailUrl: '/resource-filter.svg',
        thumbnailState: 'ready',
      })),
    };
    if (delayImages && media === 'image') {
      pending.resolve();
      await release.promise;
      await route.fulfill({ json }).catch(() => {});
      finished.resolve();
      return;
    }
    await route.fulfill({ json });
  });

  await page.goto('/admin/folders?folder=mixed');
  const media = page.getByRole('combobox', { name: '筛选媒体类型' });
  const search = page.getByRole('textbox', { name: '搜索当前图片' });
  const count = page.locator('.resource-count');
  await expect(media).toHaveValue('');
  await expect(count).toHaveText('共 42 项');
  expect(queries.at(-1)?.has('mediaType')).toBe(false);
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByRole('checkbox', { name: '选择 图片 41.png' }).check();
  await expect(page.getByText('已选 1 项')).toBeVisible();
  await media.selectOption('image');
  await expect(count).toHaveText('共 41 项');
  await expect(page.getByText('第 1 / 2 页')).toBeVisible();
  await expect(page.getByText('已选 1 项')).toHaveCount(0);
  await media.selectOption('video');
  await expect(count).toHaveText('共 1 项');
  await expect(page.getByRole('checkbox', { name: '选择 海边.mp4' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择 山谷.mp4' })).toHaveCount(0);
  const tagSearch = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get('search') === '风景',
  );
  await search.fill('风景');
  await tagSearch;
  await expect(page.getByRole('checkbox', { name: '选择 海边.mp4' })).toBeVisible();
  await search.fill('无匹配');
  await expect(page.getByRole('heading', { name: '没有符合条件的资源' })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(media).toHaveValue('');
  await expect(search).toHaveValue('');
  await expect(count).toHaveText('共 42 项');

  delayImages = true;
  await media.selectOption('image');
  await pending.promise;
  await media.selectOption('video');
  await expect(count).toHaveText('共 1 项');
  release.resolve();
  await finished.promise;
  await expect(page.getByRole('checkbox', { name: '选择 海边.mp4' })).toBeVisible();
  await page.getByRole('button', { name: /另一个文件夹/ }).click();
  await expect(media).toHaveValue('video');
  await expect(page.getByRole('checkbox', { name: '选择 山谷.mp4' })).toBeVisible();
  await page.getByRole('button', { name: '所有图片' }).click();
  await expect(count).toHaveText('共 2 项');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(media).toHaveValue('');
  delayImages = false;
  await search.focus();
  await page.keyboard.press('Tab');
  await expect(media).toBeFocused();
  await media.press('End');
  await expect(media).toHaveValue('video');
  await expect(count).toHaveText('共 2 项');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
