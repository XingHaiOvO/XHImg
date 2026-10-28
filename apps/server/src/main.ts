import { resolve } from 'node:path';
import { createApp } from './app.js';
const config = {
  dir: resolve(import.meta.dirname, '../../..', process.env.DATA_DIR ?? 'data'),
  masterKey: process.env.MASTER_KEY ?? '',
  publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:9521',
  secureCookie: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  logger: true,
};
try {
  const { app } = await createApp(config);
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 9521) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      void app.close().then(() => process.exit(0));
    });
} catch (error) {
  console.error('XHImg 启动失败：', error instanceof Error ? error.message : '配置或数据库错误');
  process.exit(1);
}
