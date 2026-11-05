import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Two 1×1 frames, with different colors and frame delays.
const gif = Buffer.from(
  '474946383961010001008000004c6971ff000021ff0b4e45545343415045322e30030101000021f90405090000002c00000000010001000002024c010021f90405110000002c0000000001000100804c69710000ff02024c01003b',
  'hex',
);

test('browser uploads an animated GIF and previews the unprocessed original', async ({ page }) => {
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
  expect(session.status()).toBe(200);
  const headers = { 'X-CSRF-Token': (await session.json()).csrf };
  const folder = await page.request.post('/api/v1/admin/folders', {
    headers,
    data: { name: 'GIF 上传验证', visibility: 'public' },
  });
  expect(folder.status()).toBe(201);
  const folderId = (await folder.json()).id;
  const configured = await page.request.patch(`/api/v1/admin/folders/${folderId}`, {
    headers,
    data: { processingPolicy: { enabled: true, targetFormat: 'jpg' } },
  });
  expect(configured.ok()).toBe(true);
  await page.goto(`/admin/folders?folder=${folderId}`);
  await page.getByRole('button', { name: '上传图片', exact: true }).first().click();
  const upload = page.getByRole('dialog');
  const input = upload.getByLabel('选择上传图片', { exact: true });
  await expect(input).toHaveAttribute('accept', /image\/gif,\.gif/);
  await expect(upload.getByLabel('选择原文件继续上传')).toHaveAttribute(
    'accept',
    /image\/gif,\.gif/,
  );
  await upload.getByRole('button', { name: '修改', exact: true }).click();
  await upload.getByRole('combobox', { name: '图片自身权限', exact: true }).selectOption('public');
  await input.setInputFiles({ name: 'animated-upload.gif', mimeType: 'image/gif', buffer: gif });
  await expect(upload.getByText('上传成功', { exact: true })).toBeVisible({ timeout: 20_000 });
  await upload.getByRole('button', { name: '关闭', exact: true }).click();

  const result = await page.request.get(`/api/v1/public/images?folderId=${folderId}`);
  const [{ id, logicalUrl, format, processingStatus }] = (await result.json()).items;
  expect({ format, processingStatus }).toEqual({ format: 'gif', processingStatus: 'skipped' });
  const original = await page.request.get(logicalUrl);
  expect(original.headers()['content-type']).toBe('image/gif');
  expect(await original.body()).toEqual(gif);
  await page.goto(`/gallery?folderId=${folderId}`);
  const choice = page.getByRole('button', { name: '查看图片', exact: true });
  await expect
    .poll(() =>
      choice.locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  await choice.click();
  const preview = page.getByRole('dialog', { name: 'animated-upload.gif' });
  await expect(preview.getByRole('img')).toHaveAttribute('src', new RegExp(`/i/${id}$`));
  await expect
    .poll(() =>
      preview.getByRole('img').evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
});
