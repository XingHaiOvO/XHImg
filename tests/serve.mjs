import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
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
// The provider is an isolated local fixture; browser tests never call a paid model.
const model = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const list = JSON.parse(body.messages[0].content.split('候选文件夹：')[1]);
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ folderId: list[0]?.id ?? null }) } }],
    }),
  );
});
await new Promise((r) => model.listen(0, '127.0.0.1', r));
await writeFile(resolve('.cache/e2e-model.txt'), `http://127.0.0.1:${model.address().port}/v1`);
await sharp({ create: { width: 2400, height: 2000, channels: 3, background: '#66aabb' } })
  .png({ compressionLevel: 0 })
  .toFile(resolve('.cache/e2e-large.png'));
await runtime.app.listen({ host: '127.0.0.1', port: 9522 });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    model.close();
    void runtime.app
      .close()
      .then(() => rm(dir, { recursive: true, force: true }))
      .then(() => process.exit(0));
  });
