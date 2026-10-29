import { useState, useEffect, lazy, Suspense } from 'react';
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
} from 'lucide-react';
import { api, json, useData, useAction, useNotice, bytes, copy, absolute } from './api';
import { Button, Field, Modal, Busy } from './components/ui';
import { Thumbnail, Preview } from './Public';
import { UploadCenter } from './components/UploadCenter';
import { ProcessingEditor, processingDefaults } from './components/ProcessingEditor';
import { Check } from './components/ui';
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {children}
    </div>
  );
}
export function Overview() {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useData('admin/overview'),
    action = useAction();
  if (loading) return <Busy />;
  if (error) return <p role="alert">{error}</p>;
  return (
    <>
      <PageHeading title="一切，井然有序。" description="从这里，开始今天的图片工作。">
        <Button asChild>
          <Link to="/admin/folders">
            <Upload size={17} />
            上传图片
          </Link>
        </Button>
      </PageHeading>
      <div className="metrics">
        {[
          ['图片总数', data.images.total ?? 0, '张图片'],
          ['存储占用', bytes(data.images.bytes), '当前结果与保留原图，不含缩略图'],
          ['公开图片', data.images.publicCount ?? 0, `私有 ${data.images.privateCount ?? 0} 张`],
          ['API 调用', data.services.calls, `${data.services.n} 个服务`],
        ].map(([title, value, detail]) => (
          <section key={title}>
            <span>{title}</span>
            <strong>{value}</strong>
            <small>{detail}</small>
          </section>
        ))}
      </div>
      <div className="panel overview-recent">
        <div className="section-heading">
          <h2>最近上传</h2>
          <Link to="/admin/folders">
            全部图片 <ArrowUpRight size={15} />
          </Link>
        </div>
        {data.recent.length ? (
          <div className="recent-grid">
            {data.recent.map((image: any) => (
              <div key={image.id}>
                <Thumbnail
                  image={image}
                  onClick={() => navigate(`/admin/folders?folder=${image.folderId}`)}
                />
                <Link to={`/admin/folders?folder=${image.folderId}`}>
                  <span>{image.name}</span>
                </Link>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <Images size={32} />
            <h3>为你的图库添加第一张图片</h3>
            <p>先创建文件夹，再上传并设置访问权限。</p>
            <Button asChild variant="secondary">
              <Link to="/admin/folders">打开资源文件夹</Link>
            </Button>
          </div>
        )}
      </div>
      {data.jobs.length > 0 && (
        <section className="panel">
          <h2>后台任务</h2>
          <p className="muted">缩略图和彻底删除任务会自动执行，失败后可重试。</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>图片</th>
                  <th>任务</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job: any) => (
                  <tr key={job.id}>
                    <td>{job.image_id}</td>
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
                      {job.state === 'failed'
                        ? '失败'
                        : job.state === 'running'
                          ? '处理中'
                          : '等待中'}
                      {job.error && <small>{job.error}</small>}
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
  const [migrationOpen, setMigrationOpen] = useState(false),
    navigate = useNavigate();
  const action = useAction();
  useEffect(() => {
    const t = setTimeout(() => {
      setFilter(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    setPage(1);
    setSelected([]);
    setTab('图片');
  }, [folderId]);
  const images = useData(
      `admin/images?${new URLSearchParams({ folderId, search: filter, page: String(page) })}`,
    ),
    folder = folders.data?.items.find((f: any) => f.id === folderId),
    allFolders = folders.data?.items ?? [];
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
            onClick={() => setSearchParams({ folder: f.id })}
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
    <>
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
      <div className="resource-layout">
        <aside className="folder-tree">
          <button
            className={'tree-item ' + (!folderId ? 'active' : '')}
            onClick={() => setSearchParams({})}
          >
            <Images size={17} />
            <span>所有图片</span>
          </button>
          <div className="tree-divider" />
          {tree(null)}
          {folders.error && <p role="alert">{folders.error}</p>}
        </aside>
        <section className="resource-content">
          <div className="folder-heading">
            <div className="folder-title">
              <FolderOpen size={24} />
              <div>
                <h2>{folder?.name ?? '所有图片'}</h2>
                <span className="muted">
                  {folder
                    ? `${folder.count} 张图片 · ${bytes(folder.size)}`
                    : `${images.data?.total ?? 0} 张图片`}
                </span>
              </div>
            </div>
            {folder && (
              <span className="badge">
                {folder.effective_visibility === 'public' ? (
                  <Globe size={13} />
                ) : (
                  <LockKeyhole size={13} />
                )}
                有效{folder.effective_visibility === 'public' ? '公开' : '私有'}
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
              </div>
              {selected.length > 0 && (
                <div className="selection-bar">
                  <span>已选 {selected.length} 项</span>
                  <Button
                    variant="secondary"
                    disabled={action.pending || selected.length > 100}
                    onClick={() => setMigrationOpen(true)}
                  >
                    迁移存储
                  </Button>
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
                    disabled={!moveTarget || action.pending}
                    onClick={() => void batch('move', { folderId: moveTarget })}
                  >
                    移动
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={action.pending}
                    onClick={() => void batch('visibility', { visibility: 'public' })}
                  >
                    公开
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={action.pending}
                    onClick={() => void batch('visibility', { visibility: 'private' })}
                  >
                    私有
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={action.pending}
                    onClick={() => void batch('delete')}
                  >
                    移入回收站
                  </Button>
                </div>
              )}
              {images.loading ? (
                <Busy />
              ) : images.error ? (
                <p role="alert">{images.error}</p>
              ) : images.data?.items.length ? (
                <div className="image-grid">
                  {images.data.items.map((image: any) => (
                    <article
                      className={'image-card ' + (selected.includes(image.id) ? 'selected' : '')}
                      key={image.id}
                    >
                      <div className="image-card-top">
                        <Thumbnail image={image} onClick={() => setPreview(image)} />
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
                      </div>
                      <div className="image-card-meta">
                        <strong title={image.name}>{image.name}</strong>
                        <small>
                          {image.width} × {image.height} · {bytes(image.size)}
                        </small>
                        <button className="text-link" onClick={() => setEditor(image)}>
                          编辑信息
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty">
                  <FolderOpen size={36} />
                  <h3>留一点空间，给新的图片。</h3>
                  <p>上传图片到这里，或从其他文件夹移动过来。</p>
                  <Button variant="secondary" onClick={() => setUploadOpen(true)}>
                    上传图片
                  </Button>
                </div>
              )}
              <div className="pagination">
                <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
                  上一页
                </Button>
                <span>第 {page} 页</span>
                <Button
                  variant="secondary"
                  disabled={!images.data || page * 40 >= images.data.total}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </div>
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
    </>
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
        <Button disabled={action.pending}>创建文件夹</Button>
      </form>
    </Modal>
  );
}
function FolderPanel({ folder, folders, storages, tab, reload, leave }: any) {
  const [draft, setDraft] = useState<any>({}),
    notice = useNotice(),
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
  const save = () =>
    action.run(async () => {
      await api(`admin/folders/${folder.id}`, json('PATCH', draft));
      await reload();
    });
  if (tab === 'API')
    return (
      <div className="folder-panel">
        <h3>文件夹即 API</h3>
        <p className="muted">上传自动归入此文件夹；私有资源始终需要明确授权。</p>
        {[
          ['专属上传', `/api/v1/folders/${folder.id}/upload`],
          ['图片列表', `/api/v1/folders/${folder.id}/images`],
          ['随机图片', `/api/v1/folders/${folder.id}/random`],
        ].map(([label, path]) => (
          <div className="api-row" key={label}>
            <strong>{label}</strong>
            <code>{path}</code>
            <Button
              variant="ghost"
              aria-label={`复制${label}接口`}
              onClick={() =>
                void copy(absolute(path!))
                  .then(() => notice('已复制'))
                  .catch(() => notice('复制失败', true))
              }
            >
              <Copy size={16} />
            </Button>
          </div>
        ))}
        <p>
          随机接口需先在随机图服务中创建并启用。上传接口使用具有此文件夹 upload 范围的 API Key。
        </p>
        <Button asChild variant="secondary">
          <Link to={`/admin/services?folder=${folder.id}`}>
            配置随机图服务 <ArrowUpRight size={15} />
          </Link>
        </Button>
        <p>
          <Link to="/docs">查看上传与鉴权示例</Link>
        </p>
        <p className="muted">文件夹 ID：{folder.id}</p>
      </div>
    );
  return (
    <div className="folder-panel">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {tab === '权限' ? (
          <>
            <h3>权限从上至下，始终一致。</h3>
            <p className="muted">
              自身权限不会覆盖上级限制。改为公开也不会覆盖单张图片的私有设置。
            </p>
            <Field label="文件夹自身权限">
              <select
                disabled={!!folder.system}
                value={draft.visibility ?? 'private'}
                onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}
              >
                <option value="private">私有</option>
                <option value="public">公开</option>
              </select>
            </Field>
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
          <>
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
          </>
        )}
        <Button
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
      </form>
      {tab === '设置' && !folder.system && (
        <div className="danger-zone">
          <h3>删除文件夹</h3>
          <p>仅可删除空文件夹，回收站中的图片也计入占用。</p>
          <Button
            variant="destructive"
            disabled={action.pending}
            onClick={() => {
              if (confirm(`删除空文件夹“${folder.name}”？`))
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
function ImageEditor({ image, close, folders, reload }: any) {
  const [processing, setProcessing] = useState<any>({ ...processingDefaults, enabled: true });
  const [draft, setDraft] = useState<any>({}),
    action = useAction();
  useEffect(() => {
    if (image)
      setDraft({
        name: image.name,
        folderId: image.folderId,
        visibility: image.visibility,
        tags: image.tags.join(', '),
        description: image.description,
      });
  }, [image]);
  return (
    <Modal
      open={!!image}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="编辑图片信息"
    >
      {image && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              await api(
                `admin/images/${image.id}`,
                json('PATCH', {
                  ...draft,
                  tags: draft.tags
                    .split(',')
                    .map((x: string) => x.trim())
                    .filter(Boolean),
                }),
              );
              await reload();
              close();
            });
          }}
        >
          <Field label="名称">
            <input
              value={draft.name ?? ''}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              required
            />
          </Field>
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
          <Field label="标签（英文逗号分隔）">
            <input
              value={draft.tags ?? ''}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            />
          </Field>
          <Field label="描述">
            <textarea
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <p className="muted">
            处理：{image.processingStatus} · 分类：{image.classificationStatus}
          </p>
          <div className="button-row">
            <Button type="button" variant="secondary" asChild>
              <a href={`/api/v1/admin/images/${image.id}/original`}>下载原始文件</a>
            </Button>
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
          </div>
          <details>
            <summary>重新处理图片</summary>
            <ProcessingEditor value={processing} onChange={setProcessing} />
            <Button
              type="button"
              variant="secondary"
              disabled={action.pending || !processing.enabled}
              onClick={() =>
                void action.run(async () => {
                  await api(`admin/images/${image.id}/reprocess`, json('POST', { processing }));
                  await reload();
                }, '已提交处理任务，当前可用版本保持可访问')
              }
            >
              提交处理任务
            </Button>
          </details>
          <p className="muted">图片 ID：{image.id}</p>
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
          <Button disabled={action.pending}>保存信息</Button>
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
  const [page, setPage] = useState(1),
    { data, error, loading, reload } = useData(`admin/images?trash=true&page=${page}`),
    action = useAction();
  return (
    <>
      <PageHeading
        title="回收站"
        description="删除后即停止对外提供访问。恢复前，请确认当前文件夹权限。"
      />
      {loading ? (
        <Busy />
      ) : error ? (
        <p role="alert">{error}</p>
      ) : data?.items.length ? (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>图片</th>
                <th>大小</th>
                <th>删除时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i: any) => (
                <tr key={i.id}>
                  <td>
                    <strong>{i.name}</strong>
                    <small>{i.id}</small>
                  </td>
                  <td>{bytes(i.size)}</td>
                  <td>{new Date(i.deletedAt).toLocaleString('zh-CN')}</td>
                  <td>
                    <div className="button-row">
                      <Button
                        variant="secondary"
                        disabled={action.pending || i.state === 'purging'}
                        onClick={() =>
                          void action.run(async () => {
                            await api(`admin/images/${i.id}/restore`, json('POST'));
                            await reload();
                          }, '已恢复')
                        }
                      >
                        恢复
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={action.pending || i.state === 'purging'}
                        onClick={() => {
                          if (confirm('彻底删除后无法恢复，确认删除？'))
                            void action.run(async () => {
                              await api(`admin/images/${i.id}/permanent`, json('DELETE'));
                              await reload();
                            }, '已安排彻底删除');
                        }}
                      >
                        {i.state === 'purging' ? '正在删除' : '彻底删除'}
                      </Button>
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
    </>
  );
}
