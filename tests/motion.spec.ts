import { expect, test } from '@playwright/test';

const picture =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#5087a2"/></svg>';
const image = {
  id: 'motion-image',
  name: '动效测试图片',
  description: '测试图片',
  width: 800,
  height: 500,
  url: '/motion-picture.svg',
  thumbnailUrl: '/motion-picture.svg',
};

test('random previews keep the current image through slow, failed and superseded replacements', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/motion-picture.svg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: picture }),
  );
  await page.route('**/api/v1/public/settings', (route) =>
    route.fulfill({
      json: { title: '动效图库', description: '动效预览', homeBackgroundUrl: image.url },
    }),
  );
  await page.route('**/api/v1/public/services', (route) =>
    route.fulfill({
      json: { items: [{ id: 'motion', name: '测试服务', url: '/api/v1/random/motion' }] },
    }),
  );
  const refresh = Promise.withResolvers<void>();
  const slowImage = Promise.withResolvers<void>();
  const staleImage = Promise.withResolvers<void>();
  const staleStarted = Promise.withResolvers<void>();
  const staleFinished = Promise.withResolvers<void>();
  let requests = 0;
  await page.route('**/motion-slow.svg', async (route) => {
    await slowImage.promise;
    await route.fulfill({ contentType: 'image/svg+xml', body: picture });
  });
  await page.route('**/motion-stale.svg', async (route) => {
    staleStarted.resolve();
    await staleImage.promise;
    await route.fulfill({ contentType: 'image/svg+xml', body: picture });
    staleFinished.resolve();
  });
  await page.route('**/motion-missing.svg', (route) => route.fulfill({ status: 404 }));
  await page.route('**/t/motion-image', (route) => route.fulfill({ status: 404 }));
  await page.route('**/api/v1/random/motion?mode=json', async (route) => {
    requests++;
    if (requests === 2) {
      await refresh.promise;
      await route.fulfill({ json: { ...image, thumbnailUrl: '/motion-slow.svg' } });
    } else if (requests === 3) {
      await route.fulfill({ json: { ...image, thumbnailUrl: '/motion-stale.svg' } });
    } else if (requests === 6) {
      await route.fulfill({ status: 503, json: { error: { message: '暂时无法换图' } } });
    } else if (requests === 5) {
      await route.fulfill({
        json: {
          ...image,
          thumbnailUrl: '/motion-missing.svg',
          thumbnailUrlExpiresAt: Date.now() + 60_000,
        },
      });
    } else {
      await route.fulfill({ json: image });
    }
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '动效图库' })).toBeVisible();
  await expect(page.locator('.home-banner-image')).toHaveCSS('animation-name', 'image-reveal');
  const card = page.locator('.service-preview');
  const photo = card.locator('[data-frame="current"] img');
  const candidate = card.locator('[data-frame="incoming"]');
  const trigger = card.getByRole('button', { name: '刷新 测试服务 图片' });
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  const size = () => card.evaluate((element) => [element.clientWidth, element.clientHeight]);
  const originalSize = await size();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Enter');
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  expect(requests).toBe(2);
  refresh.resolve();
  await expect(candidate.locator('img')).toHaveAttribute('src', '/motion-slow.svg');
  await expect(candidate).toHaveCSS('opacity', '0');
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  await expect(photo).toHaveCSS('opacity', '1');
  expect(await size()).toEqual(originalSize);
  slowImage.resolve();
  await expect(photo).toHaveAttribute('src', '/motion-slow.svg');
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(candidate.locator('img')).toHaveAttribute('src', '/motion-stale.svg');
  await staleStarted.promise;
  await page.keyboard.press('Enter');
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  staleImage.resolve();
  await staleFinished.promise;
  await expect(candidate).toHaveCount(0);
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  await page.keyboard.press('Enter');
  await expect(card.getByRole('status')).toHaveText('预览图片加载失败，请刷新重试');
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('status')).toHaveText('暂时无法换图');
  await expect(photo).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.keyboard.press('Enter');
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  const previous = await photo.elementHandle();
  await page.keyboard.press('Enter');
  await expect.poll(() => previous!.evaluate((element) => element.isConnected)).toBe(false);
  await expect(photo).toHaveAttribute('src', image.thumbnailUrl);
  expect(await size()).toEqual(originalSize);
});

test('gallery and admin overlays preserve keyboard focus with and without motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference', colorScheme: 'dark' });
  await page.route('**/motion-picture.svg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: picture }),
  );
  await page.route('**/api/v1/public/images?*', (route) =>
    route.fulfill({ json: { items: [image], total: 1 } }),
  );
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ json: { username: 'owner', csrf: 'test' } }),
  );
  await page.goto('/gallery');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const thumbnail = page.getByRole('button', { name: '查看图片：测试图片' });
  await thumbnail.focus();
  await expect(thumbnail.getByText('查看大图')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  const preview = page.getByRole('dialog', { name: image.name });
  await expect(preview).toHaveCSS('animation-name', 'dialog-in');
  await expect(preview.getByRole('img')).toHaveCSS('animation-name', 'image-reveal');
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(thumbnail).toBeFocused();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/services');
  const trigger = page.getByRole('button', { name: '展开管理导航' });
  const drawer = page.locator('.mobile-sidebar');
  await trigger.click();
  await expect(drawer).toHaveCSS('animation-name', 'drawer-in');
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCSS('animation-name', 'drawer-out');
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await trigger.click();
  await expect(drawer).toHaveCSS('animation-name', 'none');
  await page.locator('.navigation-overlay').click({ position: { x: 370, y: 400 } });
  await expect(drawer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.goto('/admin/settings');
  const processing = page.getByRole('button', { name: '图片处理', exact: true });
  await processing.click();
  await expect(processing).toHaveAttribute('aria-current', 'page');
  await expect(processing).toHaveCSS('transition-property', 'none');
  await page.goto('/');
  await expect(page.locator('.home-identity')).toHaveCSS('animation-name', 'none');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('route, selection and notice motion leaves navigation and controls available', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const animate = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (...args: Parameters<typeof animate>) {
      if (this.matches('.public-route, .workspace')) {
        this.dataset.routeAnimations = String(Number(this.dataset.routeAnimations ?? 0) + 1);
      }
      if (this.matches('.notice[data-closing="true"]')) {
        const root = document.documentElement;
        root.dataset.noticeExits = String(Number(root.dataset.noticeExits ?? 0) + 1);
      }
      return animate.apply(this, args);
    };
  });
  await page.route('**/motion-picture.svg', (route) =>
    route.fulfill({ contentType: 'image/svg+xml', body: picture }),
  );
  await page.route('**/api/v1/public/images?*', (route) =>
    route.fulfill({ json: { items: [image], total: 1 } }),
  );
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({ json: { username: 'owner', csrf: 'test' } }),
  );
  await page.route('**/api/v1/admin/images?*', (route) =>
    route.fulfill({ json: { items: [image], total: 1 } }),
  );
  await page.route('**/api/v1/public/services', (route) =>
    route.fulfill({
      json: { items: [{ id: 'motion', name: '测试服务', url: '/api/v1/random/motion' }] },
    }),
  );
  await page.route('**/api/v1/random/motion?mode=json', (route) => route.fulfill({ json: image }));
  await page.goto('/');
  const copy = page.getByRole('button', { name: '复制 测试服务 API 地址' });
  const notice = page.locator('.notice');
  await copy.click();
  await expect(notice).toHaveText('API 地址已复制');
  await notice.getByRole('button', { name: '关闭提示' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-notice-exits', '1');
  await expect(notice).toHaveCount(0);
  await copy.click();
  await expect(notice).toHaveText('API 地址已复制');
  await expect(notice).toHaveCount(0, { timeout: 6000 });
  await expect(page.locator('html')).toHaveAttribute('data-notice-exits', '2');
  const gallery = page
    .getByRole('navigation', { name: '网站导航' })
    .getByRole('link', { name: '图库' });
  await gallery.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.public-route')).toHaveAttribute('data-route-animations', '1');
  await expect(gallery).toBeFocused();
  await page.getByRole('combobox', { name: '图片排序' }).selectOption('oldest');
  await expect(page).toHaveURL(/sort=oldest/);
  await expect(page.locator('.public-route')).toHaveAttribute('data-route-animations', '1');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.public-route')).toHaveAttribute('data-route-animations', '2');

  await page.goto('/admin/folders');
  const checkbox = page.getByRole('checkbox', { name: `选择 ${image.name}` });
  await checkbox.check();
  await expect(page.locator('.selection-bar')).toHaveCSS('animation-name', 'selection-in');
  await expect(page.locator('.image-card.selected')).toHaveCSS(
    'background-color',
    'rgb(234, 243, 255)',
  );
  await checkbox.uncheck();
  await expect(page.locator('.selection-bar')).toHaveCount(0);
  await page
    .getByRole('navigation', { name: '管理导航' })
    .getByRole('link', { name: '随机图服务' })
    .click();
  await expect(page.locator('.workspace')).toHaveAttribute('data-route-animations', '1');
});
