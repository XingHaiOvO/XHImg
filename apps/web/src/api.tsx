import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
let csrf = '';
export const csrfToken = () => csrf;
export function setCsrf(value: string) {
  csrf = value;
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith('/api/') ? path : '/api/v1/' + path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-CSRF-Token': csrf,
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `请求失败 (${response.status})`);
  return body as T;
}
export const json = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
export function useData<T = any>(path: string) {
  const [data, setData] = useState<T>(),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    return api<T>(path)
      .then((x) => {
        setData(x);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload };
}
const NoticeContext = createContext<(text: string, error?: boolean) => void>(() => {});
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(null), 6000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  return (
    <NoticeContext.Provider value={(text, error = false) => setNotice({ text, error })}>
      {children}
      {notice && (
        <div
          className={'notice ' + (notice.error ? 'error' : '')}
          role={notice.error ? 'alert' : 'status'}
          onClick={() => setNotice(null)}
        >
          {notice.text}
        </div>
      )}
    </NoticeContext.Provider>
  );
}
export const useNotice = () => useContext(NoticeContext);
export function useAction() {
  const notice = useNotice(),
    [pending, setPending] = useState(false);
  return {
    pending,
    run: async (fn: () => Promise<unknown>, success = '已保存') => {
      setPending(true);
      try {
        await fn();
        if (success) notice(success);
        return true;
      } catch (e: any) {
        notice(e.message, true);
        return false;
      } finally {
        setPending(false);
      }
    },
  };
}
export const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : `${(n / 1024).toFixed(0)} KB`;
export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
export const absolute = (path: string) => new URL(path, location.origin).href;
export function upload(file: File, query: string, onProgress: (n: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/v1/upload?' + query);
    xhr.setRequestHeader('X-CSRF-Token', csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      try {
        const result = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(result);
        else reject(new Error(result.error?.message ?? '上传失败'));
      } catch {
        reject(new Error('服务器响应无效'));
      }
    };
    xhr.onerror = () => reject(new Error('网络中断，上传未确认成功'));
    const data = new FormData();
    data.append('file', file);
    xhr.send(data);
  });
}
