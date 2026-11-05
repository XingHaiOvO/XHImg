import { useState, useEffect, useRef, useId, lazy, Suspense } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
const MigrationCreateDialog = lazy(() =>
  import('./StorageMigrations').then((module) => ({ default: module.MigrationCreateDialog })),
);
import {
  FolderPlus,
  FolderOpen,
  Upload,
  Images,
  LockKeyhole,
  Globe,
  Trash2,
  Copy,
  RefreshCw,
  ArrowUpRight,
  AlertTriangle,
  X,
  Pencil,
} from 'lucide-react';
import { api, json, useData, useAction, useNotice, bytes, copy, absolute } from './api';
import {
  Pagination,
  QueryFeedback,
  useConfirm,
  ActionFeedback,
  Button,
  Field,
  Modal,
  Busy,
} from './components/ui';
import { Thumbnail, Preview } from './Public';
import { useImageSource } from './image-links';
import { UploadCenter } from './components/UploadCenter';
import { ProcessingEditor, processingDefaults } from './components/ProcessingEditor';
import { Check } from './components/ui';
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
function relativeTime(timestamp: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 43200) return `${Math.floor(minutes / 1440)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}
export function Overview() {
  const navigate = useNavigate();
  const { data, error, loading, reload, refreshError, refreshing } = useData('admin/overview'),
    action = useAction();
  if (loading) return <Busy />;
  if (error) return <QueryFeedback query={{ error, reload }} />;
  // The overview endpoint returns only the latest 20 jobs; this count covers that subset.
  const failed = data.jobs.filter((job: any) => job.state === 'failed').length;
  return (
    <>
      <PageHeading title="概览">
        <div className="button-row">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void reload()}
            disabled={refreshing}
            aria-label="刷新数据"
          >
            <RefreshCw size={16} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
          </Button>
          <Button asChild>
            <Link to="/admin/folders">
              <Upload size={17} />
              上传图片
            </Link>
          </Button>
        </div>
      </PageHeading>
      {failed > 0 && (
        <Link className="overview-alert" to="/admin/organize?tab=failed">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>{failed} 个任务失败</span>
          <span className="overview-alert-link">查看</span>
        </Link>
      )}
      {(refreshError || refreshing) && (
        <QueryFeedback query={{ error: refreshError, refreshing, reload }} />
      )}
      {data.images.total !== 0 && (
        <div className="metrics overview-metrics">
          <section className="metrics-item">
            <Link className="metrics-item-link" to="/admin/folders">
              <span>图片总数</span>
              <strong>{data.images.total ?? 0}</strong>
            </Link>
          </section>
          <section className="metrics-item">
            <Link className="metrics-item-link" to="/admin/settings?tab=storage">
              <span>存储占用</span>
              <strong>{bytes(data.images.bytes)}</strong>
            </Link>
          </section>
          <section className="metrics-item">
            <Link className="metrics-item-link" to="/admin/folders">
              <span>文件夹</span>
              <strong>{data.folders}</strong>
            </Link>
          </section>
          <section>
            <span>公开 / 私有</span>
            <strong>
              {data.images.publicCount ?? 0}
              <span className="metrics-pair"> / {data.images.privateCount ?? 0}</span>
            </strong>
          </section>
          <section className="metrics-item">
            <Link className="metrics-item-link" to="/admin/services">
              <span>累计调用</span>
              <strong>{data.services.calls ?? 0}</strong>
            </Link>
          </section>
        </div>
      )}
      <div className="panel overview-recent">
        <div className="section-heading">
          <h2>最近上传</h2>
          <Link to="/admin/folders">
            全部图片 <ArrowUpRight size={15} />
          </Link>
        </div>
        {data.recent.length ? (
          <div className="recent-grid">
            {data.recent.slice(0, 6).map((image: any) => (
              <div key={image.id}>
                <div className="overview-thumbnail" title="在文件夹中打开">
                  <Thumbnail
                    image={image}
                    onClick={() => navigate(`/admin/folders?folder=${image.folderId}`)}
                  />
                </div>
                <Link
                  to={`/admin/folders?folder=${image.folderId}`}
                  title={
                    image.name?.includes('-') ? image.name : `${image.width} × ${image.height}`
                  }
                >
                  <span>
                    {image.width} × {image.height}
                    {image.createdAt ? ` · ${relativeTime(image.createdAt)}` : ''}
                  </span>
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <Images size={32} />
            <h3>为你的图库添加第一张图片</h3>
            <p>创建文件夹后上传图片</p>
            <Button asChild variant="secondary">
              <Link to="/admin/folders">打开资源文件夹</Link>
            </Button>
          </div>
        )}
      </div>
      {data.jobs.length > 0 && (
        <section className="panel">
          <h2 title="缩略图和彻底删除任务会自动执行，失败后可重试。">后台任务</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 160 }}>图片</th>
                  <th>任务</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job: any) => (
                  <tr key={job.id}>
                    <td title={job.image_id}>
                      {job.width && job.height ? (
                        <span>
                          {job.width} × {job.height}
                          {job.image_deleted ? '（已删除）' : ''}
                        </span>
                      ) : (
                        <span className="muted">已清除</span>
                      )}
                    </td>
                    <td>
                      {{
                        purge: '彻底删除',
                        thumbnail: '生成缩略图',
                        process: '图片处理',
                        classify: 'AI 分类',
                        finalize: '上传校验',
                      }[job.kind as string] ?? job.kind}
                    </td>
                    <td>
                      {job.state === 'failed' ? (
                        '失败'
                      ) : job.state === 'running' ? (
                        '处理中'
                      ) : (
                        <span className="badge">等待中</span>
                      )}
                      {job.error && (
                        <small
                          title={job.error}
                          style={{
                            display: 'block',
                            maxWidth: 240,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {job.error}
                        </small>
                      )}
                    </td>
                    <td>
                      {job.state === 'failed' && (
                        <Button
                          variant="secondary"
                          disabled={action.pending}
                          onClick={() =>
                            void action.run(async () => {
                              await api(`admin/jobs/${job.id}/retry`, json('POST'));
                              await reload();
                            }, '已安排重试')
                          }
                        >
                          重试
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
function FolderOptions({ folders, exclude }: { folders: any[]; exclude?: string }) {
  const depth = (f: any, seen = new Set<string>()): number => {
    if (!f.parent_id || seen.has(f.id)) return 0;
    seen.add(f.id);
    const p = folders.find((x) => x.id === f.parent_id);
    return p ? 1 + depth(p, seen) : 0;
  };
  return (
    <>
      {folders
        .filter((f) => f.id !== exclude)
        .map((f) => (
          <option key={f.id} value={f.id}>
            {'　'.repeat(depth(f))}
            {f.name}
          </option>
        ))}
    </>
  );
}
export function Resources() {
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams(),
    folderId = searchParams.get('folder') ?? '',
    folders = useData('admin/folders'),
    storages = useData('admin/storage-backends'),
    [tab, setTab] = useState('图片'),
    [page, setPage] = useState(1),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState(''),
    [selected, setSelected] = useState<string[]>([]),
    [createOpen, setCreateOpen] = useState(false),
    [uploadOpen, setUploadOpen] = useState(false),
    [preview, setPreview] = useState<any>(),
    [editor, setEditor] = useState<any>(),
    [moveTarget, setMoveTarget] = useState('');
  const [treeOpen, setTreeOpen] = useState(false);
  const [migrationOpen, setMigrationOpen] = useState(false),
    navigate = useNavigate();
  const action = useAction();
  useEffect(() => {
    const t = setTimeout(() => {
      if (search !== filter) {
        setFilter(search);
        setSelected([]);
        setPage(1);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    setPage(1);
    setSelected([]);
    setTab('图片');
    setTreeOpen(false);
  }, [folderId]);
  const images = useData(
      `admin/images?${new URLSearchParams({ folderId, search: filter, page: String(page) })}`,
    ),
    folder = folders.data?.items.find((f: any) => f.id === folderId),
    allFolders = folders.data?.items ?? [];
  const previousPage = useRef<{ key: string; ids: string[] } | undefined>(undefined);
  useEffect(() => {
    if (!images.data) return;
    const key = JSON.stringify([folderId, filter, page]);
    const ids = images.data.items.map((image: any) => image.id as string);
    const previous = previousPage.current;
    if (previous?.key === key)
      setSelected((selected) =>
        selected.filter((id) => !previous.ids.includes(id) || ids.includes(id)),
      );
    previousPage.current = { key, ids };
  }, [images.data, folderId, filter, page]);
  const reload = async () => {
    await Promise.all([folders.reload(), images.reload()]);
  };
  const batch = async (actionName: string, extra = {}) => {
    await action.run(async () => {
      await api(
        'admin/images/batch',
        json('POST', { ids: selected, action: actionName, ...extra }),
      );
      setSelected([]);
      await reload();
      window.dispatchEvent(new Event('trash-changed'));
    });
  };
  const tree = (parent: string | null, depth = 0): React.ReactNode =>
    allFolders
      .filter((f: any) => f.parent_id === parent)
      .map((f: any) => (
        <div key={f.id}>
          <button
            className={'tree-item ' + (f.id === folderId ? 'active' : '')}
            style={{ paddingLeft: 12 + depth * 16 }}
            onClick={() => {
              setSearchParams({ folder: f.id });
              setTreeOpen(false);
            }}
          >
            <FolderOpen size={16} />
            <span>{f.name}</span>
            {f.effective_visibility === 'private' && <LockKeyhole size={12} />}
            <small>{f.count}</small>
          </button>
          {tree(f.id, depth + 1)}
        </div>
      ));
  return (
    <div className="resources-page">
      <PageHeading title="资源文件夹" description="把图片整理好，让每一个文件夹成为服务。">
        <div className="button-row">
          <Button variant="secondary" onClick={() => setCreateOpen(true)}>
            <FolderPlus size={17} />
            新建文件夹
          </Button>
          <Button onClick={() => setUploadOpen(true)}>
            <Upload size={17} />
            上传图片
          </Button>
        </div>
      </PageHeading>
      <button
        className="folder-tree-toggle secondary button"
        aria-expanded={treeOpen}
        aria-controls="resource-folder-tree"
        onClick={() => setTreeOpen(!treeOpen)}
      >
        <FolderOpen size={17} />
        {folder?.name ?? '所有图片'} · {treeOpen ? '收起文件夹' : '选择文件夹'}
      </button>
      <div className="resource-layout">
        <aside id="resource-folder-tree" className={'folder-tree ' + (treeOpen ? 'tree-open' : '')}>
          <button
            className={'tree-item ' + (!folderId ? 'active' : '')}
            onClick={() => {
              setSearchParams({});
              setTreeOpen(false);
            }}
          >
            <Images size={17} />
            <span>所有图片</span>
          </button>
          <div className="tree-divider" />
          {tree(null)}
          {folders.error && <QueryFeedback query={folders} />}
        </aside>
        <section className="resource-content">
          <div className="folder-heading">
            <div className="folder-title">
              <FolderOpen size={24} />
              <div>
                <h2>{folder?.name ?? '所有图片'}</h2>
                {folder && (
                  <span className="muted">
                    {folder.count} 张图片 · {bytes(folder.size)}
                  </span>
                )}
              </div>
            </div>
            {folder && (
              <span className="badge">
                {folder.effective_visibility === 'public' ? (
                  <Globe size={13} />
                ) : (
                  <LockKeyhole size={13} />
                )}
                {folder.effective_visibility === 'public' ? '公开' : '私有'}
              </span>
            )}
          </div>
          {folder && (
            <div className="tabs" role="tablist">
              {['图片', 'API', '权限', '存储', '设置'].map((t) => (
                <button
                  role="tab"
                  aria-selected={tab === t}
                  key={t}
                  className={tab === t ? 'active' : ''}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          {tab === '图片' || !folder ? (
            <>
              <div className="toolbar">
                <input
                  aria-label="搜索当前图片"
                  placeholder="搜索图片名称或标签"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <Button variant="ghost" onClick={() => void reload()} aria-label="刷新图片">
                  <RefreshCw size={16} />
                </Button>
                {selected.length > 0 && (
                  <Button
                    variant="ghost"
                    className="resource-migrate"
                    disabled={!selected.length || selected.length > 100 || action.pending}
                    onClick={() => setMigrationOpen(true)}
                  >
                    迁移存储
                  </Button>
                )}
                <span className="resource-count muted">共 {images.data?.total ?? 0} 张</span>
              </div>
              <div className="selection-slot">
                {selected.length > 0 ? (
                  <div className="selection-bar">
                    <span>已选 {selected.length} 项</span>
                    <button
                      className="text-link"
                      disabled={action.pending}
                      onClick={() =>
                        setSelected(
                          Array.from(
                            new Set([
                              ...selected,
                              ...(images.data?.items ?? []).map((image: any) => image.id),
                            ]),
                          ),
                        )
                      }
                    >
                      全选本页
                    </button>
                    <button
                      className="text-link"
                      disabled={action.pending}
                      onClick={() => setSelected([])}
                    >
                      清除
                    </button>
                    <select
                      aria-label="批量移动目标"
                      value={moveTarget}
                      onChange={(e) => setMoveTarget(e.target.value)}
                    >
                      <option value="">目标文件夹</option>
                      <FolderOptions folders={allFolders} />
                    </select>
                    <Button
                      variant="secondary"
                      disabled={!moveTarget || action.pending || selected.length > 100}
                      onClick={() => void batch('move', { folderId: moveTarget })}
                    >
                      移动
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={action.pending || selected.length > 100}
                      onClick={() => void batch('visibility', { visibility: 'public' })}
                    >
                      公开
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={action.pending || selected.length > 100}
                      onClick={() => void batch('visibility', { visibility: 'private' })}
                    >
                      私有
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={action.pending || selected.length > 100}
                      onClick={async () => {
                        if (
                          await confirm(`将 ${selected.length} 张图片移入回收站？可在回收站恢复。`)
                        )
                          void batch('delete');
                      }}
                    >
                      移入回收站
                    </Button>
                  </div>
                ) : (
                  <div className="selection-empty">
                    <button
                      className="text-link"
                      disabled={!images.data?.items.length}
                      onClick={() =>
                        setSelected((images.data?.items ?? []).map((image: any) => image.id))
                      }
                    >
                      全选本页
                    </button>
                  </div>
                )}
                {selected.length > 100 && (
                  <p className="form-error" role="alert">
                    每次最多操作 100 张图片，请减少选中数量。
                  </p>
                )}
              </div>
              <QueryFeedback query={images} backgroundOnly />
              {images.loading ? (
                <Busy />
              ) : images.error ? (
                <QueryFeedback query={images} />
              ) : images.data?.items.length ? (
                <div className="image-grid">
                  {images.data.items.map((image: any) => (
                    <article
                      className={'image-card ' + (selected.includes(image.id) ? 'selected' : '')}
                      key={image.id}
                      onClickCapture={(e) => {
                        if (
                          (e.ctrlKey || e.metaKey) &&
                          (e.target as HTMLElement).closest('.image-thumb')
                        ) {
                          e.preventDefault();
                          e.stopPropagation();
                          setSelected((current) =>
                            current.includes(image.id)
                              ? current.filter((id) => id !== image.id)
                              : [...current, image.id],
                          );
                        }
                      }}
                    >
                      <div className="image-card-top">
                        <Thumbnail
                          image={{ ...image, width: 4, height: 3 }}
                          onClick={() => setPreview(image)}
                        />
                        <input
                          type="checkbox"
                          aria-label={`选择 ${image.name}`}
                          checked={selected.includes(image.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, image.id]
                                : selected.filter((x) => x !== image.id),
                            )
                          }
                        />
                      </div>
                      <div className="image-card-meta">
                        <strong title={image.name}>{image.name}</strong>
                        <div className="image-card-details">
                          <small>
                            {image.width} × {image.height} · {bytes(image.size)}
                          </small>
                          <div className="image-card-actions">
                            <span
                              className="visibility-dot"
                              title={image.effectiveVisibility === 'public' ? '公开' : '私有'}
                            >
                              {image.effectiveVisibility === 'public' ? (
                                <Globe size={13} />
                              ) : (
                                <LockKeyhole size={13} />
                              )}
                            </span>
                            <button
                              className="icon-button image-edit"
                              aria-label="编辑信息"
                              onClick={() => setEditor(image)}
                            >
                              <Pencil size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <FolderOpen size={36} />
                  <h3>{filter ? '没有找到匹配的图片。' : '留一点空间，给新的图片。'}</h3>
                  <p>
                    {filter
                      ? '调整名称或标签，再试一次。'
                      : '上传图片到这里，或从其他文件夹移动过来。'}
                  </p>
                  <Button variant="secondary" onClick={() => setUploadOpen(true)}>
                    上传图片
                  </Button>
                </div>
              )}
              {images.data?.total > 40 && (
                <Pagination total={images.data?.total ?? 0} page={page} onChange={setPage} />
              )}
            </>
          ) : (
            <FolderPanel
              folder={folder}
              folders={allFolders}
              storages={storages.data?.items ?? []}
              tab={tab}
              reload={reload}
              leave={() => setSearchParams({})}
            />
          )}
        </section>
      </div>
      <FolderCreate
        open={createOpen}
        close={() => setCreateOpen(false)}
        folders={allFolders}
        parentId={folderId}
        reload={reload}
      />
      <UploadModal
        open={uploadOpen}
        close={() => setUploadOpen(false)}
        folders={allFolders}
        current={folderId}
        reload={reload}
      />
      <Preview image={preview} close={() => setPreview(undefined)} />
      {migrationOpen && (
        <Suspense fallback={<Busy />}>
          <MigrationCreateDialog
            imageIds={selected}
            close={() => setMigrationOpen(false)}
            onStarted={(task) => {
              setSelected([]);
              navigate(`/admin/settings?tab=migrations&task=${task.id}`);
            }}
          />
        </Suspense>
      )}
      <ImageEditor
        image={editor}
        close={() => setEditor(undefined)}
        folders={allFolders}
        reload={reload}
      />
    </div>
  );
}
function FolderCreate({ open, close, folders, parentId, reload }: any) {
  const [title, setTitle] = useState(''),
    [parent, setParent] = useState(parentId),
    [vis, setVis] = useState('private'),
    action = useAction();
  useEffect(() => setParent(parentId), [parentId, open]);
  return (
    <Modal
      busy={action.pending}
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="新建文件夹"
      description="先整理资源，再决定如何对外提供服务。"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              'admin/folders',
              json('POST', { name: title, parentId: parent || null, visibility: vis }),
            );
            await reload();
            setTitle('');
            close();
          });
        }}
      >
        <Field label="文件夹名称">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={120}
          />
        </Field>
        <Field label="上级文件夹">
          <select value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">顶级文件夹</option>
            <FolderOptions folders={folders} />
          </select>
        </Field>
        <Field label="自身权限" hint="任意上级为私有时，此文件夹最终仍为私有。">
          <select value={vis} onChange={(e) => setVis(e.target.value)}>
            <option value="private">私有</option>
            <option value="public">公开</option>
          </select>
        </Field>
        <Button disabled={action.pending}>{action.pending ? '正在提交…' : '创建文件夹'}</Button>
        <ActionFeedback action={action} />
      </form>
    </Modal>
  );
}
function FolderApiPanel({ folder }: { folder: any }) {
  const services = useData('admin/random-services');
  const notice = useNotice();
  const service = services.data?.items.find(
    (item: any) => item.kind === 'folder' && (item.folder_id ?? item.folderId) === folder.id,
  );
  const base = `/api/v1/folders/${folder.id}/`;
  const copyUrl = (path: string) =>
    void copy(absolute(path))
      .then(() => notice('已复制'))
      .catch(() => notice('复制失败', true));
  return (
    <div className="folder-api">
      <h3>文件夹即 API</h3>
      <p className="muted">上传自动归入此文件夹；私有资源始终需要明确授权。</p>
      <div className="api-prefix">
        <code>{base}</code>
        <button
          type="button"
          className="icon-button api-copy"
          aria-label="复制 API 公共前缀"
          onClick={() => copyUrl(base)}
        >
          <span className="api-copy-label">复制</span>
          <Copy size={16} />
        </button>
      </div>
      {[
        ['专属上传', 'POST', 'upload'],
        ['图片列表', 'GET', 'images'],
        ['随机图片', 'GET', 'random'],
      ].map(([label, method, path]) => (
        <div className="api-row" key={path}>
          <strong>{label}</strong>
          <code>
            {method} {path}
          </code>
          {path === 'random' && (
            <div className="api-service-state">
              {service && <span className="badge">{service.enabled ? '已启用' : '未启用'}</span>}
              {!service?.enabled && (
                <Link className="text-link" to={`/admin/services?folder=${folder.id}`}>
                  去配置
                </Link>
              )}
            </div>
          )}
          <button
            type="button"
            className="icon-button api-copy"
            aria-label={`复制${label}接口`}
            onClick={() => copyUrl(base + path)}
          >
            <span className="api-copy-label">复制</span>
            <Copy size={16} />
          </button>
        </div>
      ))}
      <p className="muted">上传接口使用具有此文件夹 upload 范围的 API Key。</p>
      <Link className="text-link" to="/docs">
        查看上传与鉴权示例 <ArrowUpRight size={15} />
      </Link>
    </div>
  );
}
function FolderPanel({ folder, folders, storages, tab, reload, leave }: any) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<any>({}),
    action = useAction();
  useEffect(() => {
    setDraft({
      name: folder.name,
      description: folder.description,
      parentId: folder.parent_id,
      visibility: folder.visibility,
      storageId: folder.storage_id,
      sortOrder: folder.sort_order,
      coverId: folder.cover_id,
      processingPolicy: folder.processing_policy ? JSON.parse(folder.processing_policy) : null,
      aiEnabled: !!folder.ai_enabled,
    });
  }, [folder]);
  const permissionChain = [folder];
  const seen = new Set([folder.id]);
  while (permissionChain.length < 3 && permissionChain[0].parent_id) {
    const parent = folders.find((item: any) => item.id === permissionChain[0].parent_id);
    if (!parent || seen.has(parent.id)) {
      permissionChain.splice(0, permissionChain.length, folder);
      break;
    }
    seen.add(parent.id);
    permissionChain.unshift(parent);
  }
  const save = () =>
    action.run(async () => {
      await api(`admin/folders/${folder.id}`, json('PATCH', draft));
      await reload();
    });
  return (
    <div className="folder-panel">
      <form
        className="panel-card"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="folder-panel-body">
          {tab === 'API' ? (
            <FolderApiPanel folder={folder} />
          ) : tab === '权限' ? (
            <>
              <h3>权限从上至下，始终一致。</h3>
              <p className="muted">
                自身权限不会覆盖上级限制。改为公开也不会覆盖单张图片的私有设置。
              </p>
              <div className="permission-chain">
                <span>{permissionChain.map((item: any) => item.name).join(' › ')}</span>
                <span>此层权限：{draft.visibility === 'public' ? '公开' : '私有'}</span>
              </div>
              <div className="permission-field">
                <Field label="文件夹自身权限">
                  <select
                    disabled={!!folder.system}
                    value={draft.visibility ?? 'private'}
                    onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}
                  >
                    <option value="private">私有（仅授权访问）</option>
                    <option value="public">公开（任何人可访问）</option>
                  </select>
                </Field>
              </div>
              {folder.count != null && (
                <p className="permission-note">此文件夹 {folder.count} 张图片</p>
              )}
              {draft.visibility === 'public' && folder.visibility !== 'public' && (
                <p className="permission-note">保存后，此文件夹下的图片将对匿名请求可见。</p>
              )}
              <p>当前有效权限：{folder.effective_visibility === 'public' ? '公开' : '私有'}</p>
            </>
          ) : tab === '存储' ? (
            <>
              <h3>默认上传存储</h3>
              <p className="muted">
                只影响后续上传，不移动已有图片。授权的请求显式指定存储时优先使用请求值。
              </p>
              <Field label="文件夹默认存储">
                <select
                  value={draft.storageId ?? ''}
                  onChange={(e) => setDraft({ ...draft, storageId: e.target.value || null })}
                >
                  <option value="">使用系统默认</option>
                  {storages
                    .filter((s: any) => s.enabled)
                    .map((s: any) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </Field>
            </>
          ) : (
            <div className="folder-settings-grid">
              <div>
                <Field label="名称">
                  <input
                    disabled={!!folder.system}
                    value={draft.name ?? ''}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    required
                  />
                </Field>
                <Check
                  label="参与 AI 自动分类"
                  disabled={!!folder.system}
                  checked={!!draft.aiEnabled}
                  onChange={(e) => setDraft({ ...draft, aiEnabled: e.target.checked })}
                />
                <Check
                  label="继承系统图片处理策略"
                  checked={draft.processingPolicy == null}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      processingPolicy: e.target.checked ? null : { ...processingDefaults },
                    })
                  }
                />
                {draft.processingPolicy != null && (
                  <ProcessingEditor
                    value={draft.processingPolicy}
                    onChange={(value) => setDraft({ ...draft, processingPolicy: value })}
                  />
                )}
                <Field label="描述">
                  <textarea
                    value={draft.description ?? ''}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    maxLength={1000}
                  />
                </Field>
              </div>
              <div>
                <Field label="上级文件夹">
                  <select
                    disabled={!!folder.system}
                    value={draft.parentId ?? ''}
                    onChange={(e) => setDraft({ ...draft, parentId: e.target.value || null })}
                  >
                    <option value="">顶级文件夹</option>
                    <FolderOptions folders={folders} exclude={folder.id} />
                  </select>
                </Field>
                <Field label="排序值">
                  <input
                    type="number"
                    value={draft.sortOrder ?? 0}
                    onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
                  />
                </Field>
                <Field label="封面图片 ID（可选）" hint="必须是当前文件夹内未删除图片的 ID。">
                  <input
                    value={draft.coverId ?? ''}
                    onChange={(e) => setDraft({ ...draft, coverId: e.target.value || null })}
                  />
                </Field>
              </div>
            </div>
          )}
        </div>
        <footer className="panel-actions">
          <ActionFeedback action={action} />
          <Button
            className="panel-save"
            disabled={action.pending}
            onClick={(e) => {
              if (folder.system) {
                e.preventDefault();
                const safe = { ...draft };
                delete safe.name;
                delete safe.parentId;
                delete safe.visibility;
                void action.run(async () => {
                  await api(`admin/folders/${folder.id}`, json('PATCH', safe));
                  await reload();
                });
              }
            }}
          >
            保存设置
          </Button>
        </footer>
      </form>
      {tab === '设置' && !folder.system && (
        <div className="danger-zone">
          <h3>删除文件夹</h3>
          <p>仅可删除空文件夹，回收站中的图片也计入占用。</p>
          <Button
            variant="destructive"
            disabled={action.pending}
            onClick={async () => {
              if (await confirm(`删除空文件夹“${folder.name}”？`))
                void action.run(async () => {
                  await api(`admin/folders/${folder.id}`, json('DELETE'));
                  leave();
                  await reload();
                });
            }}
          >
            删除文件夹
          </Button>
        </div>
      )}
    </div>
  );
}
const imageDraft = (image: any) => ({
  name: image.name ?? '',
  folderId: image.folderId ?? '',
  visibility: image.visibility ?? 'private',
  tags: image.tags ?? [],
  description: image.description ?? '',
});
const imageStatus: Record<string, string> = {
  pending: '处理中',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  skipped: '未启用',
};
function ImageEditor({ image, close, folders, reload }: any) {
  const confirm = useConfirm();
  const closing = useRef(false);
  const tagId = useId();
  const thumbnail = useImageSource(image ?? {}, true);
  const [processing, setProcessing] = useState<any>({ ...processingDefaults, enabled: true });
  const [draft, setDraft] = useState<any>({});
  const [tagInput, setTagInput] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const generatedName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
    image?.name ?? '',
  );
  const action = useAction();
  useEffect(() => {
    if (image) {
      setDraft(imageDraft(image));
      setTagInput('');
      setNameEdited(false);
      setProcessing({ ...processingDefaults, enabled: true });
    }
  }, [image]);
  const tagsWith = (value: string) =>
    Array.from(
      new Set([
        ...(draft.tags ?? []),
        ...value
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
      ]),
    );
  const addTags = () => {
    setDraft({ ...draft, tags: tagsWith(tagInput) });
    setTagInput('');
  };
  const dirty =
    !!image && (JSON.stringify(draft) !== JSON.stringify(imageDraft(image)) || !!tagInput.trim());
  const requestClose = async () => {
    if (action.pending || closing.current) return;
    closing.current = true;
    try {
      if (!dirty || (await confirm('修改尚未保存，确认放弃？'))) close();
    } finally {
      closing.current = false;
    }
  };
  return (
    <Modal
      busy={action.pending}
      open={!!image}
      onOpenChange={(open) => {
        if (!open) void requestClose();
      }}
      title="编辑图片信息"
    >
      {image && (
        <form
          className="image-editor"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(
                `admin/images/${image.id}`,
                json('PATCH', { ...draft, tags: tagsWith(tagInput) }),
              );
              await reload();
              close();
            });
          }}
        >
          <div className="image-editor-fields">
            <div className="image-editor-preview">
              <div className="image-editor-thumbnail">
                {thumbnail.failed ? (
                  <Images size={24} />
                ) : (
                  <img src={thumbnail.source} alt="图片缩略图" onError={thumbnail.onError} />
                )}
              </div>
              <div className="image-editor-facts">
                <strong>{generatedName ? '图片预览' : image.name}</strong>
                <small>
                  {image.width} × {image.height} · {bytes(image.size)} ·{' '}
                  {image.format?.toUpperCase()}
                </small>
              </div>
              <div className="image-editor-status">
                {[
                  ['处理', image.processingStatus],
                  ['分类', image.classificationStatus],
                ].map(([label, status]) => (
                  <span
                    key={label}
                    className={
                      'status-pill ' +
                      (status === 'completed'
                        ? 'completed'
                        : status === 'failed'
                          ? 'failed'
                          : status === 'pending' || status === 'processing'
                            ? 'processing'
                            : '')
                    }
                  >
                    <i aria-hidden="true" />
                    {label} · {imageStatus[status] ?? status}
                  </span>
                ))}
              </div>
            </div>

            <h4 className="form-section">归属与权限</h4>
            <div className="form-grid">
              <Field label="所属文件夹">
                <select
                  value={draft.folderId ?? ''}
                  onChange={(e) => setDraft({ ...draft, folderId: e.target.value })}
                >
                  <FolderOptions folders={folders} />
                </select>
              </Field>
              <Field label="自身权限">
                <select
                  value={draft.visibility ?? 'private'}
                  onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}
                >
                  <option value="private">私有</option>
                  <option value="public">公开</option>
                </select>
              </Field>
            </div>
            <h4 className="form-section">内容</h4>
            <Field label="名称">
              <input
                required={!generatedName || nameEdited}
                placeholder={generatedName ? '未命名' : undefined}
                title={image.name}
                value={generatedName && !nameEdited ? '' : (draft.name ?? '')}
                onChange={(e) => {
                  setNameEdited(true);
                  setDraft({ ...draft, name: e.target.value });
                }}
              />
            </Field>
            <div className="field">
              <label htmlFor={tagId}>标签</label>
              <div className="image-tag-input">
                {(draft.tags ?? []).map((tag: string) => (
                  <span className="image-tag" key={tag}>
                    {tag}
                    <button
                      type="button"
                      aria-label={`删除标签 ${tag}`}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          tags: draft.tags.filter((value: string) => value !== tag),
                        })
                      }
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
                <input
                  id={tagId}
                  value={tagInput}
                  placeholder="输入标签，按回车或逗号添加"
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (!e.nativeEvent.isComposing && (e.key === 'Enter' || e.key === ',')) {
                      e.preventDefault();
                      addTags();
                    }
                  }}
                />
              </div>
            </div>
            <Field label="描述">
              <textarea
                value={draft.description ?? ''}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>
            {image.publicationHold && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void action.run(async () => {
                    await api(`admin/images/${image.id}/use-original`, json('POST'));
                    await reload();
                    close();
                  }, '已使用原文件，按当前权限发布')
                }
              >
                {image.state === 'processing' ? '使用原图并结束处理' : '使用当前版本并结束整理'}
              </Button>
            )}

            {image.state === 'missing' && (
              <Button
                type="button"
                variant="secondary"
                onClick={() =>
                  void action.run(async () => {
                    await api(`admin/images/${image.id}/check`, json('POST'));
                    await reload();
                  }, '文件已恢复可用')
                }
              >
                检查并恢复文件
              </Button>
            )}

            <ActionFeedback action={action} />
          </div>
          <footer className="image-editor-footer">
            <div className="image-editor-tools">
              <details className="image-technical">
                <summary>技术信息</summary>
                <p className="muted">图片 ID：{image.id}</p>
              </details>
              <Button type="button" variant="ghost" asChild>
                <a href={`/api/v1/admin/images/${image.id}/original`}>下载原始文件</a>
              </Button>
              {image.format === 'gif' ? (
                <p className="muted">GIF 原样保存，不能重新处理。</p>
              ) : (
                <details className="image-reprocess">
                  <summary>重新处理图片</summary>
                  <div className="image-reprocess-panel">
                    <ProcessingEditor value={processing} onChange={setProcessing} />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={action.pending || !processing.enabled}
                      onClick={() =>
                        void action.run(async () => {
                          await api(
                            `admin/images/${image.id}/reprocess`,
                            json('POST', { processing }),
                          );
                          await reload();
                        }, '已提交处理任务，当前可用版本保持可访问')
                      }
                    >
                      提交处理任务
                    </Button>
                  </div>
                </details>
              )}
            </div>
            <div className="image-editor-save">
              <Button
                type="button"
                variant="secondary"
                disabled={action.pending}
                onClick={() => void requestClose()}
              >
                取消
              </Button>
              <Button disabled={action.pending}>{action.pending ? '正在提交…' : '保存信息'}</Button>
            </div>
          </footer>
        </form>
      )}
    </Modal>
  );
}
function UploadModal({ open, close, folders, current, reload }: any) {
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title="把图片，放到对的位置。"
      description="支持分片续传，关闭窗口后可重新选择原文件恢复。"
    >
      <UploadCenter folders={folders} current={current} onComplete={reload} />
    </Modal>
  );
}
export function Trash() {
  const confirm = useConfirm();
  const notice = useNotice();
  const [page, setPage] = useState(1);
  const { data, error, loading, reload, refreshError, refreshing } = useData(
    `admin/images?trash=true&page=${page}`,
  );
  const folders = useData('admin/folders');
  const action = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<any>();
  const [clearProgress, setClearProgress] = useState<{ done: number; total: number }>();
  const selectAll = useRef<HTMLInputElement>(null);
  const items: any[] = data?.items ?? [];
  const eligible = items.filter((image) => image.state !== 'purging');
  const selectedItems = items.filter((image) => selected.includes(image.id));
  const selectedSize = selectedItems.reduce((size, image) => size + image.size, 0);
  const allSelected = eligible.length > 0 && eligible.every((image) => selected.includes(image.id));
  const busy = action.pending || !!clearProgress;
  useEffect(() => {
    setSelected([]);
  }, [page, data]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selected.length > 0 && !allSelected;
  }, [selected.length, allSelected, data]);
  useEffect(() => {
    if (data && page > Math.max(1, Math.ceil(data.total / 40)))
      setPage(Math.max(1, Math.ceil(data.total / 40)));
  }, [data, page]);
  const refresh = async () => {
    setSelected([]);
    await reload();
    window.dispatchEvent(new Event('trash-changed'));
  };
  const relativeTime = (ts: number) => {
    const now = new Date(),
      date = new Date(ts);
    const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const days = Math.round((today - day) / 86400000);
    if (days === 1) return '昨天';
    if (days > 1) return `${days} 天前`;
    return `${Math.floor(minutes / 60)} 小时前`;
  };
  const folderName = (image: any) => {
    if (!image.folderId || image.folderId === 'uncategorized') return '未分类';
    if (folders.loading) return '加载中…';
    if (folders.error) return '文件夹信息不可用';
    return (
      folders.data?.items.find((folder: any) => folder.id === image.folderId)?.name ??
      '已删除的文件夹'
    );
  };
  const trashImage = (image: any) => {
    const url = `/api/v1/admin/images/${image.id}/trash-preview`;
    return {
      ...image,
      name: image.name,
      url,
      logicalUrl: url,
      thumbnailUrl: url + '?thumbnail=true',
      logicalThumbnailUrl: url + '?thumbnail=true',
      thumbnailState: 'ready',
      urlExpiresAt: undefined,
      thumbnailUrlExpiresAt: undefined,
    };
  };
  const batch = async (permanent: boolean) => {
    const count = selected.length;
    const message = permanent
      ? `彻底删除 ${count} 张图片（合计 ${bytes(selectedSize)}）后无法恢复，确认删除？`
      : `恢复 ${count} 张图片？恢复前请确认目标文件夹权限。`;
    if (!(await confirm(message))) return;
    void action.run(
      async () => {
        const receipt = await api(
          'admin/images/batch',
          json('POST', { ids: selected, action: permanent ? 'permanent' : 'restore' }),
        );
        await refresh();
        if (permanent)
          notice(
            `已安排彻底删除 ${count - (receipt.skipped ?? 0)} 张${receipt.skipped ? `，跳过 ${receipt.skipped} 张不在回收站或已不存在的图片` : ''}`,
          );
      },
      permanent ? '' : `已恢复 ${count} 张`,
    );
  };
  const emptyTrash = async () => {
    if (
      !data ||
      !(await confirm(
        `将彻底删除回收站内全部 ${data.total} 张图片（合计 ${bytes(data.totalSize)}），此操作无法撤销。`,
      ))
    )
      return;
    void action.run(async () => {
      let total = data.total,
        done = 0,
        previousTotal = total,
        lastProgress = Date.now();
      setClearProgress({ done, total });
      setSelected([]);
      try {
        for (;;) {
          let list = await api('admin/images?trash=true&page=1&limit=100');
          if (list.total < previousTotal) lastProgress = Date.now();
          total = Math.max(total, done + list.total);
          done = Math.max(done, total - list.total);
          previousTotal = list.total;
          setClearProgress({ done, total });
          if (list.total === 0) break;
          let ids = list.items
            .filter((image: any) => image.state !== 'purging')
            .map((image: any) => image.id);
          for (let nextPage = 2; !ids.length && (nextPage - 1) * 100 < list.total; nextPage++) {
            list = await api(`admin/images?trash=true&page=${nextPage}&limit=100`);
            ids = list.items
              .filter((image: any) => image.state !== 'purging')
              .map((image: any) => image.id);
          }
          if (ids.length) {
            const receipt = await api(
              'admin/images/batch',
              json('POST', { ids, action: 'permanent' }),
            );
            if ((receipt.skipped ?? 0) < ids.length) lastProgress = Date.now();
            await refresh();
          }
          if (Date.now() - lastProgress > 120000)
            throw new Error('删除任务已提交，但仍有图片未完成删除。请稍后刷新回收站。');
          if (!ids.length) {
            await refresh();
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      } finally {
        await refresh();
        setClearProgress(undefined);
      }
    }, '已清空回收站');
  };
  return (
    <div className="trash-page">
      <PageHeading
        title="回收站"
        description="删除后即停止对外提供访问，但继续占用存储。恢复前请确认目标文件夹权限。"
      />
      <QueryFeedback query={{ error: refreshError, refreshing, reload: refresh }} />
      <ActionFeedback action={action} />
      {!!items.length && data?.total != null && data?.totalSize != null && data.total > 0 && (
        <div className="trash-summary">
          <span>
            共 {data.total} 张 · 合计 {bytes(data.totalSize)} · 不会自动清理，需手动彻底删除
          </span>
          <Button variant="ghost" disabled={busy} onClick={() => void emptyTrash()}>
            {clearProgress ? `正在删除 ${clearProgress.done}/${clearProgress.total}` : '清空回收站'}
          </Button>
        </div>
      )}
      {selected.length > 0 && (
        <div className="selection-bar">
          <span>已选 {selected.length} 张</span>
          <Button
            variant="secondary"
            disabled={busy || selected.length > 100}
            onClick={() => void batch(false)}
          >
            恢复
          </Button>
          <Button
            variant="destructive"
            disabled={busy || selected.length > 100}
            onClick={() => void batch(true)}
          >
            彻底删除
          </Button>
          <Button
            className="trash-clear-selection"
            variant="ghost"
            disabled={busy}
            onClick={() => setSelected([])}
          >
            取消选择
          </Button>
        </div>
      )}
      {loading ? (
        <Busy />
      ) : error ? (
        <QueryFeedback query={{ error, reload: refresh }} />
      ) : items.length ? (
        <div className="panel table-wrap">
          <table className="trash-table">
            <thead>
              <tr>
                <th>
                  <input
                    ref={selectAll}
                    type="checkbox"
                    aria-label="全选本页回收站图片"
                    checked={allSelected}
                    disabled={busy || !eligible.length}
                    onChange={(e) =>
                      setSelected(e.target.checked ? eligible.map((image) => image.id) : [])
                    }
                  />
                </th>
                <th>图片</th>
                <th>原文件夹</th>
                <th>大小</th>
                <th>删除时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((image) => (
                <tr key={image.id} className={image.state === 'purging' ? 'purging' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${image.name}`}
                      disabled={busy || image.state === 'purging'}
                      checked={selected.includes(image.id)}
                      onChange={(e) =>
                        setSelected((current) =>
                          e.target.checked
                            ? [...current, image.id]
                            : current.filter((id) => id !== image.id),
                        )
                      }
                    />
                  </td>
                  <td>
                    <div className="trash-image">
                      <div className="trash-thumbnail">
                        <Thumbnail
                          image={{ ...trashImage(image), width: 1, height: 1 }}
                          disabled={image.state === 'purging'}
                          actionLabel={`预览 ${image.name}`}
                          onClick={() => setPreview(trashImage(image))}
                        />
                      </div>
                      <div className="trash-name">
                        <strong title={image.name}>{image.name}</strong>
                        {image.state === 'purging' && <span className="badge">正在删除</span>}
                      </div>
                    </div>
                  </td>
                  <td>{folderName(image)}</td>
                  <td>{bytes(image.size)}</td>
                  <td title={new Date(image.deletedAt).toLocaleString('zh-CN')}>
                    {relativeTime(image.deletedAt)}
                  </td>
                  <td>
                    <div className="button-row">
                      <Button
                        variant="ghost"
                        disabled={action.pending || image.state === 'purging'}
                        onClick={() =>
                          void action.run(async () => {
                            await api(`admin/images/${image.id}/restore`, json('POST'));
                            await refresh();
                          }, '已恢复')
                        }
                      >
                        恢复
                      </Button>
                      <button
                        className="icon-button trash-permanent"
                        aria-label="彻底删除"
                        title="彻底删除"
                        disabled={action.pending || image.state === 'purging'}
                        onClick={async () => {
                          if (
                            await confirm(
                              `彻底删除图片“${image.name}”（${bytes(image.size)}）后无法恢复，确认删除？`,
                            )
                          )
                            void action.run(async () => {
                              await api(`admin/images/${image.id}/permanent`, json('DELETE'));
                              await refresh();
                            }, '已安排彻底删除');
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <Trash2 size={36} />
          <h3>回收站是空的。</h3>
          <p>删除的图片会先保留在这里。</p>
          <Button asChild variant="secondary">
            <Link to="/admin/folders">去资源文件夹</Link>
          </Button>
        </div>
      )}
      {(data?.total ?? 0) > 40 && (
        <fieldset className="trash-pagination" disabled={busy}>
          <Pagination total={data.total} page={page} onChange={setPage} />
        </fieldset>
      )}
      <Preview image={preview} close={() => setPreview(undefined)} />
    </div>
  );
}
