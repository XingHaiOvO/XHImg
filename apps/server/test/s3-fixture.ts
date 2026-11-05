import { createServer } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();

// An independent verifier: the SDK generates signatures, this HTTP fixture checks them.
export async function s3Fixture() {
  const accessKeyId = 'isolated-access',
    secretAccessKey = 'isolated-secret';
  const objects = new Map<string, { bytes: Buffer; mime: string }>();
  const counts = { get: 0, head: 0, put: 0, delete: 0, signed: 0 };
  const state = {
    unavailable: false,
    now: () => Date.now(),
    holdRange: undefined as ((closed: Promise<void>) => void) | undefined,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const deny = (code = 'SignatureDoesNotMatch') => {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end(`<Error><Code>${code}</Code></Error>`);
    };
    if (state.unavailable) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (url.searchParams.has('X-Amz-Signature')) {
      const credential = url.searchParams.get('X-Amz-Credential')?.split('/') ?? [];
      const date = url.searchParams.get('X-Amz-Date') ?? '';
      const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
      const algorithm = url.searchParams.get('X-Amz-Algorithm');
      const expiry = Number(url.searchParams.get('X-Amz-Expires'));
      const issued = Date.parse(
        date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'),
      );
      if (
        credential[0] !== accessKeyId ||
        algorithm !== 'AWS4-HMAC-SHA256' ||
        signedHeaders !== 'host' ||
        !Number.isFinite(issued) ||
        expiry < 1 ||
        expiry > 300
      ) {
        deny();
        return;
      }
      if (state.now() >= issued + expiry * 1000) {
        deny('ExpiredToken');
        return;
      }
      const pairs = [...url.searchParams]
        .filter(([key]) => key !== 'X-Amz-Signature')
        .map(([key, value]) => [encode(key), encode(value)])
        .sort(([ak, av], [bk, bv]) =>
          ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
        );
      const query = pairs.map(([key, value]) => key + '=' + value).join('&');
      const canonical = [
        req.method,
        url.pathname,
        query,
        `host:${req.headers.host}\n`,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const scope = credential.slice(1).join('/');
      const toSign = ['AWS4-HMAC-SHA256', date, scope, digest(canonical)].join('\n');
      const signingKey = hmac(
        hmac(hmac(hmac('AWS4' + secretAccessKey, credential[1]), credential[2]), 's3'),
        'aws4_request',
      );
      const expected = hmac(signingKey, toSign).toString('hex');
      const provided = url.searchParams.get('X-Amz-Signature')!;
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
      ) {
        deny();
        return;
      }
      counts.signed++;
    } else if (
      !req.headers.authorization?.startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`)
    ) {
      deny('AccessDenied');
      return;
    }
    const key = url.pathname;
    if (key === '/bucket' || key === '/bucket/') {
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'PUT') {
      counts.put++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(key, {
        bytes: Buffer.concat(chunks),
        mime: String(req.headers['content-type'] ?? 'application/octet-stream'),
      });
      res.writeHead(200, { etag: '"not-a-content-hash"' });
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      counts.delete++;
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'HEAD') counts.head++;
    else counts.get++;
    const value = objects.get(key);
    if (!value) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end('<Error><Code>NoSuchKey</Code></Error>');
      return;
    }
    const headers: Record<string, string | number> = {
      'content-length': value.bytes.length,
      'content-type': url.searchParams.get('response-content-type') ?? value.mime,
    };
    for (const [parameter, header] of [
      ['response-cache-control', 'cache-control'],
      ['response-content-disposition', 'content-disposition'],
    ])
      if (url.searchParams.has(parameter)) headers[header] = url.searchParams.get(parameter)!;
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (req.method === 'GET' && range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end || end >= value.bytes.length) {
        res.writeHead(416, { 'content-range': `bytes */${value.bytes.length}` });
        return res.end();
      }
      const slice = value.bytes.subarray(start, end + 1);
      res.writeHead(206, {
        ...headers,
        'content-length': slice.length,
        'content-range': `bytes ${start}-${end}/${value.bytes.length}`,
      });
      if (state.holdRange) {
        state.holdRange(new Promise<void>((resolve) => res.once('close', resolve)));
        return res.write(slice.subarray(0, 1));
      }
      return res.end(slice);
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : value.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    endpoint,
    config: {
      endpoint,
      accessKeyId,
      secretAccessKey,
      bucket: 'bucket',
      region: 'us-east-1',
      forcePathStyle: true,
    },
    objects,
    counts,
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
