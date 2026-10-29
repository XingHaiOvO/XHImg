import { DefaultHttpStack, type HttpStack } from 'tus-js-client';
export interface ResumeRecord {
  url: string;
  hash: string;
  name: string;
  size: number;
  options: Record<string, string>;
  createdAt: number;
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('xhimg-uploads', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('uploads', { keyPath: 'url' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法访问续传记录'));
  });
}
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('uploads', mode),
      request = work(tx.objectStore('uploads'));
    tx.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    tx.onerror = () => {
      db.close();
      reject(new Error('续传记录保存失败'));
    };
  });
}
export const resumeRecords = () =>
  transaction<ResumeRecord[]>('readonly', (store) => store.getAll());
export const saveResume = (record: ResumeRecord) =>
  transaction('readwrite', (store) => store.put(record));
export const removeResume = (url: string) => transaction('readwrite', (store) => store.delete(url));
export function hashBlob(
  blob: Blob,
  onProgress?: (n: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('校验已取消', 'AbortError'));
      return;
    }
    const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
    let settled = false;
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      done();
    };
    const abort = () => finish(() => reject(new DOMException('校验已取消', 'AbortError')));
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event) => {
      if (settled) return;
      if (event.data.error) {
        finish(() => reject(new Error(event.data.error)));
      } else if (event.data.hash) {
        finish(() => resolve(event.data.hash));
      } else onProgress?.(Math.round(event.data.progress * 100));
    };
    worker.onerror = () => {
      finish(() => reject(new Error('文件校验失败')));
    };
    worker.postMessage(blob);
  });
}
export function checkedHttpStack(): HttpStack {
  const stack = new DefaultHttpStack({});
  return {
    getName: () => stack.getName(),
    createRequest: (method, url) => {
      const request = stack.createRequest(method, url),
        send = request.send.bind(request),
        abort = request.abort.bind(request),
        controller = new AbortController();
      request.abort = () => {
        controller.abort();
        return abort();
      };
      request.send = async (body: any) => {
        controller.signal.throwIfAborted();
        if (method === 'PATCH') {
          const blob = body instanceof Blob ? body : new Blob(body == null ? [] : [body]);
          request.setHeader('X-Chunk-SHA256', await hashBlob(blob, undefined, controller.signal));
        }
        controller.signal.throwIfAborted();
        return send(body);
      };
      return request;
    },
  };
}
