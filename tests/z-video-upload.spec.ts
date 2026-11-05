import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { testVideo, videoToolsAvailable } from '../apps/server/test/video-fixture';

test('browser uploads MP4, then plays and seeks in the admin and public gallery', async ({
  page,
}) => {
  test.skip(!videoToolsAvailable(), 'FFmpeg and FFprobe are required');
  const credentials = { username: 'owner', password: 'browser-test-password-123' };
  const setup = await (await page.request.get('/api/v1/setup')).json();
  if (!setup.installed) {
    const installed = await page.request.post('/api/v1/setup', {
      data: { ...credentials, token: (await readFile('.cache/e2e-token.txt', 'utf8')).trim() },
    });
    expect(installed.status()).toBe(201);
  } else {
    const saved = await readFile('.cache/e2e-session.json', 'utf8').catch(() => undefined);
    if (saved) await page.context().addCookies(JSON.parse(saved).cookies);
  }
  let session = await page.request.get('/api/v1/auth/me');
  if (!session.ok()) session = await page.request.post('/api/v1/auth/login', { data: credentials });
  expect(session.ok()).toBe(true);
  const headers = { 'X-CSRF-Token': (await session.json()).csrf };
  const folder = await page.request.post('/api/v1/admin/folders', {
    headers,
    data: { name: 'MP4 上传验证', visibility: 'public' },
  });
  expect(folder.status()).toBe(201);
  const folderId = (await folder.json()).id;
  const file = testVideo();
  await page.goto(`/admin/folders?folder=${folderId}`);
  await page.getByRole('button', { name: '上传图片', exact: true }).first().click();
  const upload = page.getByRole('dialog');
  const input = upload.getByLabel('选择上传图片', { exact: true });
  await expect(input).toHaveAttribute('accept', /video\/mp4,\.mp4/);
  await expect(upload.getByLabel('选择原文件继续上传')).toHaveAttribute(
    'accept',
    /video\/mp4,\.mp4/,
  );
  await upload.getByRole('button', { name: '修改', exact: true }).click();
  await upload.getByRole('combobox', { name: '图片自身权限', exact: true }).selectOption('public');
  await input.setInputFiles({ name: 'motion-test.mp4', mimeType: 'video/mp4', buffer: file });
  await expect(upload.getByText('上传成功', { exact: true })).toBeVisible({ timeout: 20_000 });
  await upload.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看 motion-test.mp4', exact: true }).click();
  const player = page.getByRole('dialog', { name: 'motion-test.mp4' }).locator('video');
  await expect
    .poll(() => player.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  expect(await player.evaluate((element) => (element as HTMLVideoElement).paused)).toBe(true);
  const pictures = await page.request.get(
    `/api/v1/public/images?folderId=${folderId}&mediaType=image`,
  );
  expect((await pictures.json()).total).toBe(0);

  await page.goto('/admin/services');
  await page.getByRole('button', { name: '创建服务', exact: true }).click();
  const serviceForm = page.getByRole('dialog');
  await serviceForm.getByLabel('服务名称').fill('随机视频验证');
  await serviceForm.getByLabel('接口 slug').fill('random-motion');
  await serviceForm.getByLabel('服务类型').selectOption('folder');
  await serviceForm.getByLabel('来源文件夹').selectOption(folderId);
  await serviceForm.getByLabel('媒体类型').selectOption('mixed');
  await expect(serviceForm.getByLabel('默认响应')).toHaveValue('redirect');
  await serviceForm.getByLabel('访问策略').selectOption('public');
  await serviceForm.getByLabel('启用此服务').check();
  await serviceForm.getByRole('button', { name: '保存服务' }).click();
  await expect(serviceForm).toHaveCount(0);
  const serviceCard = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: '随机视频验证' }) });
  await serviceCard.getByRole('button', { name: '预览', exact: true }).click();
  const randomPlayer = page.getByRole('dialog', { name: '随机视频验证' }).locator('video');
  await expect
    .poll(() => randomPlayer.evaluate((element) => (element as HTMLVideoElement).readyState))
    .toBeGreaterThan(0);
  const address = await randomPlayer.getAttribute('src');
  expect(address).toMatch(/^\/i\//);
  const redirect = await page.request.get('/api/v1/random/random-motion', { maxRedirects: 0 });
  expect(redirect.status()).toBe(302);
  expect(redirect.headers().location).toBe(address);
  const direct = await page.context().newPage();
  try {
    const downloads: string[] = [];
    direct.on('download', (download) => downloads.push(download.suggestedFilename()));
    const response = await direct.goto('/api/v1/random/random-motion');
    expect(response?.headers()['content-type']).toBe('video/mp4');
    expect(response?.headers()['content-disposition']).toBe('inline');
    await expect(direct).toHaveURL(new URL(address!, page.url()).href);
    const video = direct.locator('video');
    await expect.poll(() => video.evaluate((element) => element.readyState)).toBeGreaterThan(1);
    await video.evaluate((element) => {
      element.currentTime = 1.7;
    });
    await expect.poll(() => video.evaluate((element) => element.seeking)).toBe(false);
    expect(await video.evaluate((element) => element.currentTime)).toBeGreaterThanOrEqual(1.65);
    expect(downloads).toEqual([]);
    await direct.goto('/');
    const card = direct.locator('.service-card').filter({ hasText: '随机视频验证' });
    await card.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        card.locator('[data-frame="current"] video').evaluate((media) => media.currentTime),
      )
      .toBeGreaterThan(0);
  } finally {
    await direct.close();
  }
  await expect
    .poll(
      async () =>
        (await (await page.request.get('/api/v1/random/random-motion?mode=json')).json())
          .thumbnailState,
    )
    .toBe('ready');

  const visitor = await page
    .context()
    .browser()!
    .newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const publicPage = await visitor.newPage();
    const randomApi = '**/api/v1/random/random-motion?mode=json';
    const slow = Promise.withResolvers<void>();
    await publicPage.route('**/i/*?card=slow', async (route) => {
      await slow.promise;
      await route.continue();
    });
    await publicPage.route('**/i/*?card=broken', (route) => route.fulfill({ status: 404 }));
    let draws = 0;
    await publicPage.route(randomApi, async (route) => {
      const response = await route.fetch();
      const image = await response.json();
      draws++;
      const url =
        draws === 2
          ? image.url + '?card=broken'
          : draws === 3
            ? image.url + '?card=slow'
            : image.url;
      await route.fulfill({
        response,
        json: { ...image, url, thumbnailState: draws === 1 ? 'pending' : image.thumbnailState },
      });
    });
    await publicPage.goto(new URL('/', page.url()).href);
    const card = publicPage.locator('.service-card').filter({ hasText: '随机视频验证' });
    await card.scrollIntoViewIfNeeded();
    const current = card.locator('[data-frame="current"] video');
    await expect(current).toHaveAttribute('src', address!);
    await expect(current).toHaveAttribute('playsinline', '');
    await expect(current).toHaveAttribute('loop', '');
    await expect.poll(() => current.evaluate((video) => video.currentTime)).toBeGreaterThan(0);
    expect(await current.evaluate((video) => video.muted)).toBe(true);
    await expect(card.locator('.thumbnail-video-badge')).toHaveText('视频');
    await card.getByRole('button', { name: '暂停视频' }).press('Enter');
    await expect.poll(() => current.evaluate((video) => video.paused)).toBe(true);
    await card.getByRole('button', { name: '播放视频' }).press('Enter');
    await expect.poll(() => current.evaluate((video) => video.paused)).toBe(false);

    const refresh = card.getByRole('button', { name: '刷新 随机视频验证 媒体' });
    await refresh.press('Enter');
    await expect(card.getByRole('status')).toHaveText('视频加载失败，请刷新重试');
    await expect(current).toHaveAttribute('src', address!);
    await refresh.press('Enter');
    const previous = await current.elementHandle();
    await expect(card.locator('[data-frame="incoming"] video')).toHaveAttribute(
      'src',
      /card=slow$/,
    );
    await expect(current).toHaveAttribute('src', address!);
    slow.resolve();
    await expect(current).toHaveAttribute('src', /card=slow$/);
    await expect.poll(() => previous!.evaluate((video) => video.paused)).toBe(true);
    await expect(refresh).toBeFocused();
    await publicPage.setViewportSize({ width: 390, height: 400 });
    await publicPage.evaluate(() => window.scrollTo(0, 0));
    await expect(current).not.toBeInViewport();
    await expect.poll(() => current.evaluate((video) => video.paused)).toBe(true);

    await publicPage.setViewportSize({ width: 390, height: 844 });
    await publicPage.emulateMedia({ reducedMotion: 'reduce' });
    await publicPage.reload();
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole('button', { name: '播放视频' })).toBeVisible();
    expect(await current.evaluate((video) => video.currentTime)).toBe(0);
    await card.getByRole('button', { name: '播放视频' }).press('Enter');
    await expect.poll(() => current.evaluate((video) => video.currentTime)).toBeGreaterThan(0);
    await publicPage.goto(new URL(`/gallery?folderId=${folderId}`, page.url()).href);
    await publicPage.getByRole('combobox', { name: '筛选媒体类型' }).selectOption('video');
    await publicPage.getByRole('button', { name: '播放视频：motion-test.mp4' }).click();
    const video = publicPage.getByRole('dialog', { name: 'motion-test.mp4' }).locator('video');
    await expect(video).toHaveAttribute('playsinline', '');
    await expect(video).toHaveAttribute('controls', '');
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState))
      .toBeGreaterThan(0);
    await video.evaluate((element) => {
      const media = element as HTMLVideoElement;
      media.currentTime = 1.7;
    });
    await expect
      .poll(() =>
        video.evaluate((element) => {
          const media = element as HTMLVideoElement;
          return !media.seeking && media.currentTime >= 1.65;
        }),
      )
      .toBe(true);
    await video.evaluate(async (element) => {
      const media = element as HTMLVideoElement;
      media.muted = true;
      await media.play();
    });
    await expect
      .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
      .toBeGreaterThan(1.8);
    await publicPage.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(video).toHaveCount(0);
  } finally {
    await visitor.close();
  }
});
