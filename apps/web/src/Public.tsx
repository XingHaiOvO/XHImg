import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Shuffle,
  Copy,
  ArrowUpRight,
  Images,
  Search,
  RefreshCw,
  Code2,
  FolderOpen,
  ImageOff,
  Aperture,
} from 'lucide-react';
import { api, useData, useNotice, copy, absolute, bytes } from './api';
import { Button, Busy, Modal } from './components/ui';
import type { ImageInfo } from '../../../packages/shared/src/index';
export function Thumbnail({
  image,
  onClick,
  actionLabel,
  disabled,
}: {
  image: Partial<ImageInfo> & { previewRevision?: number };
  onClick?: () => void;
  actionLabel?: string;
  disabled?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0),
    [loaded, setLoaded] = useState(false);
  const pending = !!image.thumbnailState && image.thumbnailState !== 'ready';
  useEffect(() => {
    setFailed(false);
    setAttempt(0);
    setLoaded(false);
  }, [image.thumbnailUrl, image.thumbnailState, image.previewRevision]);
  useEffect(() => {
    if (!loaded && (pending || failed) && attempt < 6) {
      const timer = setTimeout(() => {
        setFailed(false);
        setAttempt((n) => n + 1);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [loaded, pending, failed, attempt]);
  const source = image.thumbnailUrl ?? `/t/${image.id}`;
  return (
    <button
      className="image-thumb"
      aria-label={actionLabel ?? `查看 ${image.name ?? '图片'}`}
      disabled={disabled}
      onClick={onClick}
      style={
        image.width && image.height
          ? { aspectRatio: `${image.width}/${image.height}` }
          : { aspectRatio: '4/3' }
      }
    >
      {failed || (pending && attempt === 0) ? (
        <span className="thumb-placeholder">
          <ImageOff size={24} />
          <small>预览暂未就绪</small>
        </span>
      ) : (
        <img
          src={
            source + (attempt ? `${source.includes('?') ? '&' : '?'}previewRetry=${attempt}` : '')
          }
          alt={image.name ?? '随机图片预览'}
          loading="lazy"
          onError={() => setFailed(true)}
          onLoad={() => setLoaded(true)}
        />
      )}
    </button>
  );
}
export function Preview({
  image,
  close,
  extra,
}: {
  image: any;
  close: () => void;
  extra?: React.ReactNode;
}) {
  const notice = useNotice();
  return (
    <Modal
      open={!!image}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={image?.name ?? '图片预览'}
    >
      {image && (
        <>
          <div className="preview-image">
            <img src={image.url ?? `/i/${image.id}`} alt={image.name ?? '图片'} />
          </div>
          <div className="image-facts">
            <span>
              {image.width} × {image.height}
            </span>
            <span>{image.format?.toUpperCase()}</span>
            <span>{bytes(image.size ?? 0)}</span>
          </div>
          {image.description && <p>{image.description}</p>}
          {image.tags?.length > 0 && (
            <div className="tags">
              {image.tags.map((t: string) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          )}
          <div className="button-row">
            <Button
              variant="secondary"
              onClick={() =>
                void copy(absolute(image.url ?? `/i/${image.id}`))
                  .then(() => notice('图片地址已复制'))
                  .catch(() => notice('复制失败，请手动复制', true))
              }
            >
              <Copy size={16} />
              复制直链
            </Button>
            <Button asChild variant="ghost">
              <a href={image.url ?? `/i/${image.id}`} target="_blank" rel="noreferrer">
                打开原图 <ArrowUpRight size={15} />
              </a>
            </Button>
          </div>
          {extra}
        </>
      )}
    </Modal>
  );
}
function ServiceCard({ service }: { service: any }) {
  const notice = useNotice(),
    [image, setImage] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setImage({ ...(await api(service.url + '?mode=json')), previewRevision: Date.now() });
      setError('');
    } catch (e: any) {
      setImage(undefined);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [service.id]);
  const kind =
    service.kind === 'global' ? '全站图片' : service.kind === 'folder' ? '文件夹服务' : '精选来源';
  return (
    <article className="service-card" aria-busy={busy}>
      <div className="service-preview">
        {image ? (
          <Thumbnail
            image={image}
            actionLabel={`刷新 ${service.name} 图片`}
            disabled={busy}
            onClick={() => void refresh()}
          />
        ) : (
          <div className="service-empty" role="status">
            <Images size={28} />
            <span>{busy ? '正在选择图片…' : error || '暂无可用图片'}</span>
          </div>
        )}
        <h3 className="service-name">{service.name}</h3>
        <button
          className="refresh-button"
          aria-label={`刷新 ${service.name} 预览`}
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
        </button>
      </div>
      <div className="service-card-content">
        <div className="endpoint">
          <code title={absolute(service.url)}>{service.url}</code>
          <button
            className="icon-button"
            aria-label={`复制 ${service.name} API 地址`}
            onClick={() =>
              void copy(absolute(service.url))
                .then(() => notice('API 地址已复制'))
                .catch(() => notice('复制失败', true))
            }
          >
            <Copy size={16} />
          </button>
        </div>
        <p>{service.description || '一个随时可用的图片资源入口。'}</p>
        <div className="service-kind">
          <FolderOpen size={12} />
          {kind}
        </div>
        <div className="service-card-footer">
          <span>
            <RefreshCw size={12} />
            点击图片刷新预览
          </span>
          <Link to={`/docs?endpoint=${encodeURIComponent(service.url)}`}>
            接口文档 <ArrowUpRight size={13} />
          </Link>
        </div>
      </div>
    </article>
  );
}
export function Home() {
  const { data, error, loading } = useData('public/services');
  const site = useData('public/settings');
  const gallery = useData('public/images?limit=1');
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  const [backgroundAttempts, setBackgroundAttempts] = useState(0);
  const background = gallery.data?.items?.[0];
  const backgroundUrl =
    background?.thumbnailState === 'ready' ? background.thumbnailUrl : undefined;
  useEffect(() => setBackgroundFailed(false), [backgroundUrl]);
  useEffect(() => {
    if (background?.thumbnailState !== 'pending' || backgroundAttempts >= 6) return;
    const timer = setTimeout(() => {
      setBackgroundAttempts((attempts) => attempts + 1);
      void gallery.reload();
    }, 2000);
    return () => clearTimeout(timer);
  }, [background?.thumbnailState, backgroundAttempts, gallery.reload]);
  return (
    <main className="home-page">
      <section className="home-banner" aria-labelledby="home-title">
        {backgroundUrl && !backgroundFailed && (
          <img
            className="home-banner-image"
            src={backgroundUrl}
            alt=""
            fetchPriority="high"
            onError={() => setBackgroundFailed(true)}
          />
        )}
        <div className="home-banner-content">
          <div className="home-identity">
            <span className="home-logo">
              <Aperture size={37} strokeWidth={1.5} />
            </span>
            <h1 id="home-title">{site.data?.title ?? 'XHImg'}</h1>
          </div>
          <p className="home-tagline">Organize Once. Serve Anywhere.</p>
          <p className="home-description">
            {site.data?.description ?? '一次整理，随处调用。'}
            <br />
            让每一个文件夹，成为随时可用的图片资源。
          </p>
          <div className="home-links">
            <Button asChild>
              <Link to="/gallery">
                <Images size={16} />
                图库预览
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link to="/docs">
                <Code2 size={16} />
                API 文档
              </Link>
            </Button>
          </div>
        </div>
      </section>
      <section id="services" className="home-services" aria-labelledby="services-title">
        <div className="home-services-heading">
          <h2 id="services-title">随机图片 API</h2>
          <span>{loading ? '正在加载服务' : `${data?.items.length ?? 0} 个公开服务`}</span>
        </div>
        {loading ? (
          <Busy />
        ) : error ? (
          <div role="alert" className="empty">
            {error}
          </div>
        ) : data?.items.length ? (
          <div className="service-grid">
            {data.items.map((service: any) => (
              <ServiceCard key={service.id} service={service} />
            ))}
          </div>
        ) : (
          <div className="empty bordered">
            <Shuffle size={32} />
            <h3>图片服务，即将在这里就绪。</h3>
            <p>管理员启用公开随机图服务后，会自动展示在这里。</p>
          </div>
        )}
      </section>
    </main>
  );
}
export function Gallery() {
  const folders = useData('public/folders'),
    [folder, setFolder] = useState(''),
    [search, setSearch] = useState(''),
    [sort, setSort] = useState('newest'),
    [page, setPage] = useState(1),
    [preview, setPreview] = useState<any>();
  const [filter, setFilter] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setFilter(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const { data, error, loading } = useData(
    `public/images?${new URLSearchParams({ folderId: folder, search: filter, sort, page: String(page) })}`,
  );
  return (
    <main className="public-main gallery-page">
      <div className="section-heading">
        <div>
          <h1>公开图库</h1>
          <p className="muted">一些图片，一点灵感。</p>
        </div>
        <span className="count">{data?.total ?? 0} 张图片</span>
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索图片名称或标签"
            placeholder="搜索图片名称或标签"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <select
          aria-label="筛选文件夹"
          value={folder}
          onChange={(e) => {
            setFolder(e.target.value);
            setPage(1);
          }}
        >
          <option value="">所有文件夹</option>
          {folders.data?.items.map((f: any) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <select
          aria-label="图片排序"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            setPage(1);
          }}
        >
          <option value="newest">最新上传</option>
          <option value="oldest">最早上传</option>
          <option value="name">按名称</option>
        </select>
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <p role="alert">{error}</p>
      ) : data?.items.length ? (
        <div className="masonry">
          {data.items.map((image: any) => (
            <article key={image.id} className="gallery-item">
              <Thumbnail image={image} onClick={() => setPreview(image)} />
              <div>
                <strong>{image.name}</strong>
                <span>
                  {image.width} × {image.height}
                </span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Images size={36} />
          <h3>还没有符合条件的图片</h3>
          <p>换个文件夹，或稍后再来看看。</p>
        </div>
      )}
      <div className="pagination">
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page} 页</span>
        <Button
          variant="secondary"
          disabled={!data || page * 40 >= data.total}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </div>
      <Preview image={preview} close={() => setPreview(undefined)} />
    </main>
  );
}
export function Docs() {
  const endpoint = new URLSearchParams(location.search).get('endpoint') ?? '/api/v1/random';
  const safeEndpoint = endpoint.startsWith('/api/v1/') ? endpoint : '/api/v1/random';
  return (
    <main className="public-main docs-page">
      <Code2 size={32} />
      <h1>让图片，接入你的作品。</h1>
      <p className="muted">随机图片、资源列表与授权上传。所有访问都遵循同一套权限规则。</p>
      <section>
        <h2>随机图片</h2>
        <p>公开服务无需密钥。支持直接图片、302 跳转与 JSON 三种响应，默认直接返回图片。</p>
        <Code
          text={`GET ${safeEndpoint}?mode=image\nGET ${safeEndpoint}?mode=redirect\nGET ${safeEndpoint}?mode=json`}
        />
        <h3>用作网页图片</h3>
        <Code text={`<img src="${absolute(safeEndpoint)}" alt="随机图片" />`} />
        <h3>JavaScript</h3>
        <Code
          text={`const response = await fetch('${safeEndpoint}?mode=json');\nif (!response.ok) throw new Error('图片暂不可用');\nconst image = await response.json();\nconsole.log(image.url, image.width, image.height);`}
        />
        <h3>Python</h3>
        <Code
          text={`import requests\nresponse = requests.get('${absolute(safeEndpoint)}', params={'mode': 'json'})\nresponse.raise_for_status()\nprint(response.json()['url'])`}
        />
      </section>
      <section>
        <h2>授权上传</h2>
        <p>
          每次请求一个文件。仅接受 JPG、PNG、WebP，最大
          100MB（后台可调低），不接受动画。批量上传请分别提交；文件夹专属接口会固定目标文件夹。启用处理或分类时返回202及状态查询地址。
        </p>
        <Code
          text={`curl -X POST '${absolute('/api/v1/upload')}?folderId=YOUR_FOLDER_ID&visibility=private' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -F 'file=@photo.jpg'\n\nPOST /api/v1/folders/{folderId}/upload\nGET /api/v1/folders/{folderId}/images?page=1&limit=40`}
        />
      </section>
      <section>
        <h2>私有资源与签名链接</h2>
        <p>
          使用 Authorization 请求头传递 API Key。私有图片读取需要 read、private:read
          及对应文件夹范围。私有随机服务还需要 random 及服务范围。图片标签不便传递请求头时，使用授权
          JSON 返回的短期签名地址；默认五分钟有效。
        </p>
        <Code
          text={`curl '${absolute(safeEndpoint)}?mode=json' \\\n  -H 'Authorization: Bearer YOUR_API_KEY'`}
        />
        <p>
          撤销密钥、修改权限或停用服务后，相关私有签名链接会失效。签名链接属于临时访问凭证，请勿公开分享。
        </p>
      </section>
      <section>
        <h2>错误与限流</h2>
        <p>
          400 参数无效 · 401 未授权 · 403 权限不足 · 404 不存在或无候选图片 · 413 文件过大 · 415
          格式不支持 · 429 请求过频 · 503 存储暂不可用。
        </p>
        <Code
          text={
            '{"error":{"code":"NO_CANDIDATES","message":"没有符合条件的可用图片","requestId":"req-1"}}'
          }
        />
        <a className="text-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
          查看 OpenAPI 接口清单 <ArrowUpRight size={15} />
        </a>
      </section>
    </main>
  );
}
function Code({ text }: { text: string }) {
  const notice = useNotice();
  return (
    <div className="code-block">
      <button
        className="icon-button"
        aria-label="复制代码"
        onClick={() =>
          void copy(text)
            .then(() => notice('已复制'))
            .catch(() => notice('复制失败', true))
        }
      >
        <Copy size={16} />
      </button>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
