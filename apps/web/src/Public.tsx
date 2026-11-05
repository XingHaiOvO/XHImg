import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
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
  Play,
} from 'lucide-react';
import { api, useData, useNotice, copy, absolute, bytes } from './api';
import { Pagination, Button, Busy, Modal } from './components/ui';
import type { ImageInfo } from '../../../packages/shared/src/index';
import { useImageSource } from './image-links';
import { useSiteSettings } from './site-settings';
import { animateEntrance } from './motion';

function useThumbnailSource(image: Partial<ImageInfo>, retryUnavailable = true) {
  const link = useImageSource(image, true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const pending = !!image.thumbnailState && image.thumbnailState !== 'ready';
  useEffect(() => {
    setFailed(false);
    setAttempt(0);
    setLoaded(false);
  }, [image.thumbnailUrl, image.thumbnailState]);
  useEffect(() => {
    if (retryUnavailable && !link.direct && !loaded && (pending || failed) && attempt < 6) {
      const timer = setTimeout(() => {
        setFailed(false);
        setAttempt((n) => n + 1);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [loaded, pending, failed, attempt, link.direct, retryUnavailable]);
  return {
    source:
      link.source +
      (!link.direct && attempt
        ? `${link.source.includes('?') ? '&' : '?'}previewRetry=${attempt}`
        : ''),
    unavailable: link.failed || (!link.direct && failed) || (pending && attempt === 0),
    failed: link.failed || (failed && attempt >= 6),
    canRetry: link.failed,
    retry: link.retry,
    onLoad: () => setLoaded(true),
    onError: () => {
      if (link.direct) link.onError();
      else setFailed(true);
    },
  };
}

export function Thumbnail({
  image,
  onClick,
  actionLabel,
  disabled,
  previewHint = false,
}: {
  image: Partial<ImageInfo>;
  onClick?: () => void;
  actionLabel?: string;
  disabled?: boolean;
  previewHint?: boolean;
}) {
  const thumbnail = useThumbnailSource(image);
  const video = image.format === 'mp4';
  return (
    <button
      className="image-thumb"
      aria-label={actionLabel ?? `查看 ${image.name ?? '图片'}`}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return;
        if (!video && thumbnail.canRetry) thumbnail.retry();
        else onClick?.();
      }}
      style={
        image.width && image.height
          ? { aspectRatio: `${image.width}/${image.height}` }
          : { aspectRatio: '4/3' }
      }
    >
      {thumbnail.unavailable ? (
        <span className="thumb-placeholder">
          {video ? <Play size={24} /> : <ImageOff size={24} />}
          <small>
            {video ? '播放视频' : thumbnail.canRetry ? '加载失败，点击重试' : '预览暂未就绪'}
          </small>
        </span>
      ) : (
        <img
          src={thumbnail.source}
          alt={image.name ?? '随机图片预览'}
          loading="lazy"
          onError={thumbnail.onError}
          onLoad={thumbnail.onLoad}
        />
      )}
      {video && (
        <span className="thumbnail-video-badge" aria-hidden="true">
          <Play size={12} /> 视频
        </span>
      )}
      {previewHint && !thumbnail.unavailable && (
        <span className="thumbnail-preview-hint" aria-hidden="true">
          {video ? '播放视频' : '查看大图'}
        </span>
      )}
    </button>
  );
}
function VideoPreview({ source, image }: { source: string; image: Partial<ImageInfo> }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div className="empty" role="alert">
        <p>视频加载失败</p>
        <Button variant="secondary" onClick={() => setFailed(false)}>
          重试播放
        </Button>
      </div>
    );
  return (
    <video
      src={source}
      poster={image.thumbnailState === 'ready' ? image.thumbnailUrl : undefined}
      controls
      playsInline
      preload="metadata"
      aria-label={image.name ?? '视频预览'}
      onError={() => setFailed(true)}
    />
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
  const link = useImageSource(image ?? {});
  const video = image?.format === 'mp4';
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
            {video ? (
              <VideoPreview key={link.source} source={link.source} image={image} />
            ) : link.failed ? (
              <div className="empty" role="alert">
                <ImageOff size={28} />
                <p>图片加载失败</p>
                <Button variant="secondary" onClick={link.retry}>
                  重试图片
                </Button>
              </div>
            ) : (
              <img
                key={link.source}
                src={link.source}
                onError={link.onError}
                onLoad={(event) => {
                  event.currentTarget.dataset.loaded = 'true';
                }}
                alt={image.name ?? '图片'}
              />
            )}
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
              disabled={!!image.urlExpiresAt && image.urlExpiresAt <= Date.now()}
              onClick={() =>
                void copy(absolute(image.url ?? `/i/${image.id}`))
                  .then(() => notice(video ? '视频地址已复制' : '图片地址已复制'))
                  .catch(() => notice('复制失败，请手动复制', true))
              }
            >
              <Copy size={16} />
              {link.direct ? '复制 S3 临时地址' : '复制直链'}
            </Button>
            {link.direct && (
              <Button
                variant="secondary"
                onClick={() =>
                  void copy(absolute(link.logical))
                    .then(() => notice('站内地址已复制'))
                    .catch(() => notice('复制失败，请手动复制', true))
                }
              >
                复制站内地址
              </Button>
            )}
            <Button asChild variant="ghost">
              <a href={link.source} target="_blank" rel="noreferrer">
                {video ? '打开视频' : '打开原图'} <ArrowUpRight size={15} />
              </a>
            </Button>
          </div>
          {link.direct && (
            <p className="muted">
              {image.urlExpiresAt && image.urlExpiresAt <= Date.now()
                ? 'S3 临时地址已过期，当前通过站内地址重新加载。'
                : 'S3 临时地址最长有效 5 分钟。'}{' '}
              长期引用请复制站内地址。
            </p>
          )}
          {extra}
        </>
      )}
    </Modal>
  );
}
type ServiceFrame = { image: Partial<ImageInfo>; revision: number };

function ServiceImage({
  frame,
  incoming,
  onReady,
  onFailure,
}: {
  frame: ServiceFrame;
  incoming: boolean;
  onReady: (frame: ServiceFrame) => void;
  onFailure: (frame: ServiceFrame) => void;
}) {
  const video = frame.image.format === 'mp4';
  const thumbnail = useThumbnailSource(frame.image, !video);
  const layer = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState('');
  const placeholder = video && (frame.image.thumbnailState !== 'ready' || thumbnail.unavailable);
  const ready = placeholder || (loaded === thumbnail.source && !thumbnail.unavailable);
  useEffect(() => {
    if (!video && incoming && thumbnail.failed) onFailure(frame);
  }, [video, incoming, thumbnail.failed, frame, onFailure]);
  useLayoutEffect(() => {
    if (!incoming || !ready || !layer.current) return;
    const animation = animateEntrance(layer.current, [{ opacity: 0 }, { opacity: 1 }], 240);
    if (!animation) {
      onReady(frame);
      return;
    }
    void animation.finished.then(
      () => onReady(frame),
      () => {},
    );
    return () => animation.cancel();
  }, [frame, incoming, onReady, ready]);
  return (
    <span
      ref={layer}
      className="service-image-layer"
      data-frame={incoming ? 'incoming' : 'current'}
      data-ready={ready}
      aria-hidden={incoming || undefined}
    >
      {placeholder ? (
        <span className="service-empty service-video-placeholder">
          <Play size={28} />
          <span>暂无视频封面</span>
        </span>
      ) : (
        (!thumbnail.unavailable || !incoming) && (
          <img
            src={incoming ? thumbnail.source : loaded}
            alt={frame.image.name ?? (video ? '随机视频封面' : '随机图片预览')}
            loading="lazy"
            onLoad={() => {
              thumbnail.onLoad();
              if (incoming) setLoaded(thumbnail.source);
            }}
            onError={thumbnail.onError}
          />
        )
      )}
      {video && (
        <span className="thumbnail-video-badge">
          <Play size={12} /> 视频
        </span>
      )}
    </span>
  );
}

function ServiceCard({ service }: { service: any }) {
  const notice = useNotice(),
    [current, setCurrent] = useState<ServiceFrame>(),
    [incoming, setIncoming] = useState<ServiceFrame>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const previewRevision = useRef(0);
  const request = useRef<AbortController | undefined>(undefined);
  const url = service.url as string;
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    const revision = ++previewRevision.current;
    setIncoming(undefined);
    setError('');
    setBusy(true);
    try {
      const image = await api<Partial<ImageInfo>>(url + '?mode=json', {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setIncoming({ image, revision });
    } catch (e: any) {
      if (!controller.signal.aborted) {
        setCurrent(undefined);
        setError(e.message);
      }
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  }, [url]);
  useEffect(() => {
    let disposed = false;
    setCurrent(undefined);
    setIncoming(undefined);
    queueMicrotask(() => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
      previewRevision.current++;
      request.current?.abort();
      request.current = undefined;
    };
  }, [refresh]);
  const onReady = useCallback((frame: ServiceFrame) => {
    if (frame.revision !== previewRevision.current) return;
    setCurrent(frame);
    setIncoming(undefined);
  }, []);
  const onFailure = useCallback((frame: ServiceFrame) => {
    if (frame.revision !== previewRevision.current) return;
    setIncoming(undefined);
    setError('预览图片加载失败，请刷新重试');
  }, []);
  const kind =
    service.kind === 'global' ? '全站图片' : service.kind === 'folder' ? '文件夹服务' : '精选来源';
  const mediaLabel =
    service.mediaType === 'video' ? '视频' : service.mediaType === 'mixed' ? '媒体' : '图片';
  return (
    <article className="service-card" aria-busy={busy || !!incoming}>
      <div className="service-preview">
        <button
          type="button"
          className="image-thumb"
          aria-label={`刷新 ${service.name} ${mediaLabel}`}
          aria-disabled={busy || undefined}
          onClick={() => void refresh()}
        >
          {!current && (
            <span className="service-empty">
              <Images size={28} />
            </span>
          )}
          {[current, incoming].map(
            (frame) =>
              frame && (
                <ServiceImage
                  key={frame.revision}
                  frame={frame}
                  incoming={frame === incoming}
                  onReady={onReady}
                  onFailure={onFailure}
                />
              ),
          )}
        </button>
        {(error || (!current && !incoming)) && (
          <span className="service-preview-status" role="status">
            {busy ? `正在选择${mediaLabel}…` : error || `暂无可用${mediaLabel}`}
          </span>
        )}
        <h3 className="service-name">{service.name}</h3>
        <button
          className="refresh-button"
          aria-label={`刷新 ${service.name} 预览`}
          aria-disabled={busy || undefined}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} className={busy || incoming ? 'spin' : ''} />
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
            点击封面刷新预览
          </span>
          <Link to={`/docs?endpoint=${encodeURIComponent(service.url)}`}>
            接口文档 <ArrowUpRight size={13} />
          </Link>
        </div>
      </div>
    </article>
  );
}
function ServiceGrid({ services }: { services: any[] }) {
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const visible = Array.from(grid.current!.querySelectorAll<HTMLElement>('.service-card'))
      .filter((card) => {
        const bounds = card.getBoundingClientRect();
        return bounds.top < innerHeight && bounds.bottom > 0;
      })
      .slice(0, 6);
    const animations = visible.map((card, index) =>
      animateEntrance(
        card,
        [
          { opacity: 0, transform: 'translateY(12px)' },
          { opacity: 1, transform: 'none' },
        ],
        240,
        index * 35,
      ),
    );
    return () => animations.forEach((animation) => animation?.cancel());
  }, []);
  return (
    <div ref={grid} className="service-grid">
      {services.map((service) => (
        <ServiceCard key={service.id} service={service} />
      ))}
    </div>
  );
}

export function Home() {
  const { data, error, loading } = useData('public/services');
  const site = useSiteSettings();
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => setLogoFailed(false), [site?.logoUrl]);
  const backgroundUrl = site?.homeBackgroundUrl;
  useEffect(() => setBackgroundFailed(false), [backgroundUrl]);
  return (
    <main className="home-page">
      <section className="home-banner" aria-labelledby="home-title">
        {backgroundUrl && !backgroundFailed && (
          <img
            key={backgroundUrl}
            className="home-banner-image"
            src={backgroundUrl}
            alt=""
            fetchPriority="high"
            onLoad={(event) => {
              event.currentTarget.dataset.loaded = 'true';
            }}
            onError={() => setBackgroundFailed(true)}
          />
        )}
        <div className="home-banner-content">
          <div className="home-identity">
            <span className="home-logo">
              {site?.logoUrl && !logoFailed ? (
                <img src={site.logoUrl} alt="" onError={() => setLogoFailed(true)} />
              ) : (
                <Aperture size={37} strokeWidth={1.5} />
              )}
            </span>
            <h1 id="home-title">{site?.title ?? 'XHImg'}</h1>
          </div>
          <div className="home-copy">
            {site?.description && <p className="home-description">{site.description}</p>}
          </div>
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
          <ServiceGrid services={data.items} />
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
  const folders = useData('public/folders');
  const [params, setParams] = useSearchParams();
  const folder = params.get('folderId') ?? '';
  const requestedType = params.get('mediaType');
  const mediaType = requestedType === 'image' || requestedType === 'video' ? requestedType : '';
  const filter = params.get('search') ?? '';
  const requestedSort = params.get('sort') ?? 'newest';
  const sort = ['newest', 'oldest', 'name'].includes(requestedSort) ? requestedSort : 'newest';
  const requestedPage = Number(params.get('page') ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const [search, setSearch] = useState(filter);
  const [preview, setPreview] = useState<any>();
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    setSearch(params.get('search') ?? '');
    return () => clearTimeout(searchTimer.current);
  }, [params]);
  const updateParams = (changes: Record<string, string>) => {
    clearTimeout(searchTimer.current);
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (!value || (key === 'page' && value === '1') || (key === 'sort' && value === 'newest'))
            next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };
  const { data, error, loading } = useData(
    `public/images?${new URLSearchParams({ folderId: folder, search: filter, sort, page: String(page), ...(mediaType ? { mediaType } : {}) })}`,
  );
  return (
    <main className="public-main gallery-page">
      <div className="section-heading">
        <div>
          <h1>公开图库</h1>
          <p className="muted">一些图片，一点灵感。</p>
        </div>
        <span className="count">{data?.total ?? 0} 项资源</span>
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索图片名称或标签"
            placeholder="搜索图片名称或标签"
            value={search}
            onChange={(e) => {
              const value = e.target.value;
              setSearch(value);
              clearTimeout(searchTimer.current);
              searchTimer.current = setTimeout(
                () => updateParams({ search: value, page: '1' }),
                300,
              );
            }}
          />
        </label>
        <select
          aria-label="筛选文件夹"
          value={folder}
          onChange={(e) => {
            updateParams({ folderId: e.target.value, search, page: '1' });
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
          aria-label="筛选媒体类型"
          value={mediaType}
          onChange={(e) => updateParams({ mediaType: e.target.value, search, page: '1' })}
        >
          <option value="">图片和视频</option>
          <option value="image">仅图片</option>
          <option value="video">仅视频</option>
        </select>
        <select
          aria-label="图片排序"
          value={sort}
          onChange={(e) => {
            updateParams({ sort: e.target.value, search, page: '1' });
          }}
        >
          <option value="newest">最新上传</option>
          <option value="oldest">最早上传</option>
          <option value="name">按名称</option>
        </select>
        {(folder || search || filter || mediaType) && (
          <Button
            variant="ghost"
            onClick={() => {
              setSearch('');
              updateParams({ search: '', folderId: '', mediaType: '', sort: 'newest', page: '1' });
            }}
          >
            清除筛选
          </Button>
        )}
      </div>
      {loading ? (
        <Busy />
      ) : error ? (
        <p role="alert">{error}</p>
      ) : data?.items.length ? (
        <div className="masonry">
          {data.items.map((image: any) => (
            <article key={image.id} className="gallery-item">
              <Thumbnail
                image={{ ...image, name: image.description || '图片预览' }}
                actionLabel={
                  image.format === 'mp4'
                    ? `播放视频：${image.description || image.name}`
                    : image.description
                      ? `查看图片：${image.description}`
                      : '查看图片'
                }
                previewHint
                onClick={() => setPreview(image)}
              />
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Images size={36} />
          <h3>还没有符合条件的资源</h3>
          <p>换个文件夹，或稍后再来看看。</p>
        </div>
      )}
      {data?.total > 40 && (
        <Pagination
          total={data?.total ?? 0}
          page={page}
          onChange={(next) => updateParams({ page: String(next) })}
        />
      )}
      <Preview image={preview} close={() => setPreview(undefined)} />
    </main>
  );
}
export function Docs() {
  const endpoint = new URLSearchParams(location.search).get('endpoint') ?? '/api/v1/random';
  const safeEndpoint = endpoint.startsWith('/api/v1/') ? endpoint : '/api/v1/random';
  const bodyRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<{ id: string; title: string }[]>([]);
  const [activeSection, setActiveSection] = useState('');
  useEffect(() => {
    const sections = Array.from(
      bodyRef.current?.querySelectorAll<HTMLElement>('section[id]') ?? [],
    );
    setToc(
      sections.map((section) => ({
        id: section.id,
        title: section.querySelector('h2')?.textContent ?? '',
      })),
    );
    setActiveSection(sections[0]?.id ?? '');
    const observer = new IntersectionObserver(
      () => {
        const offset = window.matchMedia('(max-width: 900px)').matches ? 96 : 32;
        const current = sections.find((section) => {
          const bounds = section.getBoundingClientRect();
          return bounds.bottom > offset && bounds.top < window.innerHeight * 0.45;
        });
        if (current) setActiveSection(current.id);
        else if (sections[0] && sections[0].getBoundingClientRect().top >= offset)
          setActiveSection(sections[0].id);
      },
      { rootMargin: '-32px 0px -55% 0px', threshold: 0 },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const link = document.querySelector<HTMLElement>('.docs-toc [aria-current="location"]');
    const nav = link?.parentElement;
    if (!link || !nav) return;
    if (link.offsetLeft < nav.scrollLeft) nav.scrollLeft = link.offsetLeft;
    else if (link.offsetLeft + link.offsetWidth > nav.scrollLeft + nav.clientWidth)
      nav.scrollLeft = link.offsetLeft + link.offsetWidth - nav.clientWidth;
  }, [activeSection]);
  return (
    <div className="public-main docs-layout">
      <main className="docs-page">
        <nav className="docs-toc" aria-label="文档目录">
          {toc.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              aria-current={activeSection === item.id ? 'location' : undefined}
              onClick={() => setActiveSection(item.id)}
            >
              {item.title}
            </a>
          ))}
        </nav>
        <div className="docs-body" ref={bodyRef}>
          <h1>让图片，接入你的作品。</h1>
          <p className="muted">随机图片、资源列表与授权上传。所有访问都遵循同一套权限规则。</p>
          <dl className="docs-meta">
            <div>
              <dt>Base URL</dt>
              <dd>
                <code>{absolute('/api/v1')}</code>
              </dd>
            </div>
            <div>
              <dt>Auth</dt>
              <dd>
                <code>Authorization: Bearer &lt;API_KEY&gt;</code>
              </dd>
            </div>
            <div>
              <dt>Response</dt>
              <dd>
                <code>image/* · 302 · application/json</code>
              </dd>
            </div>
          </dl>
          <section id="random-images">
            <h2>随机图片</h2>
            <p>
              公开服务无需密钥。图片可直接返回二进制，图片和视频均可通过 302 或 JSON
              返回地址。默认响应由服务配置决定。
            </p>
            <Code
              text={`# 直接返回图片\nGET ${safeEndpoint}?mode=image\n\n# 302 跳转\nGET ${safeEndpoint}?mode=redirect\n\n# 返回 JSON\nGET ${safeEndpoint}?mode=json`}
            />
            <h3>用作网页图片</h3>
            <Code text={`<img src="${absolute(safeEndpoint)}?mode=image" alt="随机图片" />`} />
            <h3>播放随机视频</h3>
            <p>仅视频或混合服务可返回 MP4。先抽取一次，再用返回的固定地址播放或拖动进度。</p>
            <Code
              text={`const response = await fetch('${safeEndpoint}?mode=json&mediaType=video');\nif (!response.ok) throw new Error('视频暂不可用');\nconst video = await response.json();\ndocument.querySelector('video').src = video.url;`}
            />
            <h3>JavaScript</h3>
            <Code
              text={`const response = await fetch('${safeEndpoint}?mode=json');\nif (!response.ok) throw new Error('图片暂不可用');\nconst image = await response.json();\nconsole.log(image.url, image.width, image.height);`}
            />
            <h3>Python</h3>
            <Code
              text={`import requests\nresponse = requests.get('${absolute(safeEndpoint)}', params={'mode': 'json'})\nresponse.raise_for_status()\nprint(response.json()['url'])`}
            />
          </section>
          <section id="authorized-upload">
            <h2>授权上传</h2>
            <p>
              每次请求一个文件。支持静态 JPG、PNG、WebP，以及静态和动态 GIF，默认上限 100
              MiB（后台可调低）。GIF 原样保存，最多 500 帧，所有帧合计最多 4000
              万像素。启用适用的图片处理或 AI 分类时，返回 202 及状态查询地址。
            </p>
            <Code
              text={`curl -X POST '${absolute('/api/v1/upload')}?folderId=YOUR_FOLDER_ID&visibility=private' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -F 'file=@photo.jpg'\n\nPOST /api/v1/folders/{folderId}/upload\nGET /api/v1/folders/{folderId}/images?page=1&limit=40`}
            />
          </section>
          <section id="private-resources">
            <h2>私有资源与签名链接</h2>
            <p>
              使用 Authorization 请求头传递 API Key。私有图片读取需要 read、private:read
              及对应文件夹范围。私有随机服务还需要 random
              及服务范围。图片标签不便传递请求头时，使用授权 JSON
              返回的短期签名地址；默认五分钟有效。
            </p>
            <Code
              text={`curl '${absolute(safeEndpoint)}?mode=json' \\\n  -H 'Authorization: Bearer YOUR_API_KEY'`}
            />
            <p>
              撤销密钥、修改权限或停用服务后，相关私有签名链接会失效。签名链接属于临时访问凭证，请勿公开分享。
            </p>
          </section>
          <section id="errors-and-limits">
            <h2>错误与限流</h2>
            <div className="docs-table" role="region" aria-label="错误状态码" tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">状态码</th>
                    <th scope="col">含义</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [400, '参数无效'],
                    [401, '未授权'],
                    [403, '权限不足'],
                    [404, '不存在或无候选图片'],
                    [413, '文件过大'],
                    [415, '格式不支持'],
                    [429, '请求过频'],
                    [503, '存储暂不可用'],
                  ].map(([status, meaning]) => (
                    <tr key={status}>
                      <td>{status}</td>
                      <td>{meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Code
              text={
                '{"error":{"code":"NO_CANDIDATES","message":"没有符合条件的可用图片","requestId":"req-1"}}'
              }
            />
            <Button asChild variant="secondary">
              <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">
                查看 OpenAPI 接口清单 <ArrowUpRight size={15} />
              </a>
            </Button>
          </section>
        </div>
      </main>
    </div>
  );
}
function Code({ text }: { text: string }) {
  const notice = useNotice();
  const isUrl = (token: string) => /^(?:https?:\/\/|\/api\/v1\/)/.test(token);
  const tokens = text.split(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|https?:\/\/[^\s"'<>\\]+|\/api\/v1\/[^\s"'<>\\]+|\b(?:GET|POST|PUT|DELETE)\b)/g,
  );
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
      <pre tabIndex={0} aria-label="示例代码">
        <code>
          {tokens.map((token, index) => {
            if (isUrl(token))
              return (
                <span className="tok-url" key={index}>
                  {token}
                </span>
              );
            if (/^["']/.test(token))
              return (
                <span className="tok-str" key={index}>
                  {token
                    .split(/(https?:\/\/[^\s"'<>\\]+|\/api\/v1\/[^\s"'<>\\]+)/g)
                    .map((part, i) =>
                      isUrl(part) ? (
                        <span className="tok-url" key={i}>
                          {part}
                        </span>
                      ) : (
                        part
                      ),
                    )}
                </span>
              );
            if (/^(GET|POST|PUT|DELETE)$/.test(token))
              return (
                <span className="tok-method" key={index}>
                  {token}
                </span>
              );
            return token;
          })}
        </code>
      </pre>
    </div>
  );
}
