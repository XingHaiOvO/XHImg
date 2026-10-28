import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { createApp } = await import('../apps/server/dist/app.js');
const sharp = require('sharp');
const dir = await mkdtemp(join(tmpdir(), 'xhimg-browser-'));
const runtime = await createApp({
  dir,
  masterKey: '12'.repeat(32),
  // Deliberately different from the test server, matching a local Vite PUBLIC_URL.
  publicUrl: 'http://localhost:3801',
  logger: false,
});
await mkdir(resolve('.cache'), { recursive: true });
await writeFile(resolve('.cache/e2e-token.txt'), runtime.setupToken);
await writeFile(
  resolve('.cache/e2e-image.png'),
  await sharp({ create: { width: 800, height: 500, channels: 3, background: '#64a5bd' } })
    .png()
    .toBuffer(),
);
await runtime.app.listen({ host: '127.0.0.1', port: 9522 });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void runtime.app
      .close()
      .then(() => rm(dir, { recursive: true, force: true }))
      .then(() => process.exit(0));
  });
