import { test, expect } from '@playwright/test';

test('public pages share site settings and refresh them once after a settings change', async ({
  page,
}) => {
  let title = '共享站点设置';
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/v1/public/settings') requests++;
  });
  await page.route('**/api/v1/public/settings', (route) =>
    route.fulfill({ json: { title, description: '', logoUrl: '', homeBackgroundUrl: '' } }),
  );
  await page.goto('/');
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('link', { name: `${title} 首页` })).toHaveCount(2);
  await expect(page.locator('.footer-legal')).toContainText(title);
  expect(requests).toBe(1);

  await page
    .getByRole('navigation', { name: '网站导航' })
    .getByRole('link', { name: '图库' })
    .click();
  await expect(page).toHaveURL(/\/gallery$/);
  await page
    .getByRole('navigation', { name: '网站导航' })
    .getByRole('link', { name: '首页' })
    .click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  expect(requests).toBe(1);

  title = '更新后的站点设置';
  await page.evaluate(() => window.dispatchEvent(new Event('site-settings')));
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('link', { name: `${title} 首页` })).toHaveCount(2);
  await expect(page.locator('.footer-legal')).toContainText(title);
  await expect(page).toHaveTitle(`${title} · 一次整理，随处调用`);
  expect(requests).toBe(2);
});
