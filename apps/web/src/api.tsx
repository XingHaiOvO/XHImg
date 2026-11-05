import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import { animateEntrance } from './motion';
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
  const [state, setState] = useState<{ path: string; data?: T; error: string; pending: boolean }>({
    path,
    error: '',
    pending: true,
  });
  const currentPath = useRef(path),
    sequence = useRef(0);
  const request = useRef<
    { path: string; controller: AbortController; promise: Promise<void> } | undefined
  >(undefined);
  currentPath.current = path;
  const reload = useCallback(() => {
    if (currentPath.current !== path) return Promise.resolve();
    if (request.current?.path === path) return request.current.promise;
    request.current?.controller.abort();
    const controller = new AbortController(),
      version = ++sequence.current;
    setState((previous) => ({
      path,
      data: previous.path === path ? previous.data : undefined,
      error: '',
      pending: true,
    }));
    const promise = api<T>(path, { signal: controller.signal })
      .then((data) => {
        if (
          !controller.signal.aborted &&
          version === sequence.current &&
          currentPath.current === path
        )
          setState({ path, data, error: '', pending: false });
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          version === sequence.current &&
          currentPath.current === path
        )
          setState((previous) => ({ ...previous, error: error.message, pending: false }));
      })
      .finally(() => {
        if (version === sequence.current) request.current = undefined;
      });
    request.current = { path, controller, promise };
    return promise;
  }, [path]);
  useEffect(() => {
    let disposed = false;
    // Let StrictMode clean up its first effect before starting a request.
    queueMicrotask(() => {
      if (!disposed) void reload();
    });
    return () => {
      disposed = true;
      request.current?.controller.abort();
      request.current = undefined;
      sequence.current++;
    };
  }, [reload]);
  const matches = state.path === path;
  const data = matches ? state.data : undefined;
  return {
    data,
    error: matches && !data ? state.error : '',
    refreshError: matches && data ? state.error : '',
    loading: !matches || (!data && state.pending),
    refreshing: !!data && state.pending,
    reload,
  };
}

// The next timer starts only after the previous refresh settles.
export function usePolling(reload: () => Promise<void>, active: boolean) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    let stopped = false,
      running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!stopped && active && !document.hidden) timer = setTimeout(tick, 3000);
    };
    const tick = async () => {
      if (stopped || running || document.hidden) return;
      running = true;
      try {
        await latest.current();
      } finally {
        running = false;
        schedule();
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    schedule();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [active]);
}
const MAX_NOTICES = 3;
const NoticeContext = createContext<(text: string, error?: boolean) => void>(() => {});
type Notice = { id: number; text: string; error: boolean };
function NoticeItem({ notice, dismiss }: { notice: Notice; dismiss: (id: number) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (closing) return;
    const timer = setTimeout(() => setClosing(true), notice.error ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [closing, notice.error]);
  useLayoutEffect(() => {
    if (!closing || !element.current) return;
    const animation = animateEntrance(element.current, [{ opacity: 1 }, { opacity: 0 }], 140);
    if (!animation) {
      dismiss(notice.id);
      return;
    }
    void animation.finished.then(
      () => dismiss(notice.id),
      () => {},
    );
    return () => animation.cancel();
  }, [closing, dismiss, notice.id]);
  return (
    <div
      ref={element}
      className={'notice ' + (notice.error ? 'error' : '')}
      data-closing={closing || undefined}
      inert={closing}
      role={closing ? undefined : notice.error ? 'alert' : 'status'}
    >
      <span>{notice.text}</span>
      <button className="icon-button" aria-label="关闭提示" onClick={() => setClosing(true)}>
        <X size={16} />
      </button>
    </div>
  );
}
export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback(
    (id: number) => setNotices((items) => items.filter((item) => item.id !== id)),
    [],
  );
  return (
    <NoticeContext.Provider
      value={(text, error = false) => {
        const id = ++nextId.current;
        setNotices((items) =>
          [
            ...items.filter((item) => item.text !== text || item.error !== error),
            { id, text, error },
          ].slice(-MAX_NOTICES),
        );
      }}
    >
      {children}
      <div className="notice-stack">
        {notices.map((notice) => (
          <NoticeItem key={notice.id} notice={notice} dismiss={dismiss} />
        ))}
      </div>
    </NoticeContext.Provider>
  );
}
export const useNotice = () => useContext(NoticeContext);
export function useAction() {
  const notice = useNotice(),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    locked = useRef(false);
  return {
    pending,
    error,
    run: async (fn: () => Promise<unknown>, success = '已保存') => {
      if (locked.current) return false;
      locked.current = true;
      setError('');
      setPending(true);
      try {
        await fn();
        if (success) notice(success);
        return true;
      } catch (e: any) {
        setError(e.message);
        notice(e.message, true);
        return false;
      } finally {
        locked.current = false;
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
