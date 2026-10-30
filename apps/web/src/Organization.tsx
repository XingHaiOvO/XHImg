import { useUrlTab } from './navigation';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api, json, useData, useAction, usePolling } from './api';
import { Pagination, QueryFeedback, Button, Busy } from './components/ui';
import { PageHeading } from './Resources';
import { UploadCenter } from './components/UploadCenter';
import { Thumbnail, Preview } from './Public';
import { ManualClassification } from './ManualClassification';
export function Organization() {
  const [tab, setTab] = useUrlTab(
      ['upload', 'manual', 'pending', 'running', 'completed', 'unmatched', 'failed', 'all'],
      'upload',
    ),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState(''),
    [page, setPage] = useState(1),
    folders = useData('admin/folders'),
    config = useData('admin/ai'),
    [preview, setPreview] = useState<any>(),
    action = useAction();
  const result = useData(
    `admin/classification?status=${['upload', 'manual'].includes(tab) ? 'all' : tab}&page=${page}`,
  );
  const stats = useData<{ counts: Record<string, number>; total: number }>(
    'admin/classification/stats',
  );
  const reloadAll = useCallback(async () => {
    await Promise.all([result.reload(), stats.reload()]);
  }, [result.reload, stats.reload]);
  const isEntry = ['upload', 'manual'].includes(tab);
  const statusClass = (status: string) =>
    ({
      completed: 'organization-status-completed',
      failed: 'organization-status-failed',
      pending: 'organization-status-active',
      running: 'organization-status-active',
      canceled: 'organization-status-neutral',
      skipped: 'organization-status-neutral',
    })[status] ?? 'organization-status-neutral';
  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [tab]);
  usePolling(
    reloadAll,
    !['upload', 'manual'].includes(tab) &&
      !!result.data?.items.some((item: any) =>
        ['pending', 'running'].includes(item.classificationStatus),
      ),
  );
  const labels: Record<string, string> = {
    pending: '待分类',
    running: '进行中',
    completed: '已完成',
    unmatched: '无法匹配',
    failed: '失败',
    canceled: '已取消',
    skipped: '未分类',
  };
  const pageSelection = useRef<HTMLInputElement>(null);
  const mobileSelection = useRef<HTMLInputElement>(null);
  const items = result.data?.items ?? [];
  const selectedOnPage = items.filter((image: any) => selected.includes(image.id)).length;
  const allSelected = items.length > 0 && selectedOnPage === items.length;
  useEffect(() => {
    for (const checkbox of [pageSelection.current, mobileSelection.current])
      if (checkbox) checkbox.indeterminate = selectedOnPage > 0 && !allSelected;
  }, [selectedOnPage, allSelected, result.data]);
  const selectPage = (checked: boolean) =>
    setSelected((current) =>
      checked
        ? Array.from(new Set([...current, ...items.map((image: any) => image.id)]))
        : current.filter((id) => !items.some((image: any) => image.id === id)),
    );
  const imageName = (name: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(name)
      ? '未命名'
      : name.replace(/\.[^/.]+$/, '') || '未命名';
  return (
    <div className="organization-page">
      <PageHeading title="智能整理" description="上传图片，整理到对应的资源文件夹。">
        <Button asChild variant="secondary">
          <Link to="/admin/settings?tab=ai">模型配置</Link>
        </Button>
      </PageHeading>
      {config.data &&
        (!config.data.enabled ||
          !config.data.hasKey ||
          !config.data.model ||
          !config.data.baseUrl) && (
          <div className="organization-model-note" role="status">
            <span>尚未配置模型，整理任务不会自动执行</span>
            <Link className="text-link" to="/admin/settings?tab=ai">
              去配置
            </Link>
          </div>
        )}
      <div className="organization-navigation">
        <div className="organization-switch" role="group" aria-label="整理入口">
          {[
            ['upload', '上传'],
            ['manual', '手动整理'],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              aria-current={tab === key ? 'page' : undefined}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        {isEntry && (stats.data?.total ?? 0) > 0 && (
          <div className="organization-records">
            <span>已有 {stats.data!.total} 张整理记录</span>
            <button type="button" className="text-link" onClick={() => setTab('all')}>
              查看
            </button>
          </div>
        )}
      </div>
      {!isEntry && (
        <nav className="tabs organization-filters" role="tablist" aria-label="整理任务状态">
          {['pending', 'running', 'completed', 'unmatched', 'failed', 'all'].map((key) => {
            const count =
              stats.error || stats.refreshError
                ? undefined
                : key === 'all'
                  ? stats.data?.total
                  : stats.data?.counts?.[key];
            return (
              <button
                key={key}
                className={tab === key ? 'active' : ''}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
              >
                {key === 'all' ? '全部' : labels[key]}
                {count != null && (
                  <span
                    className={
                      'organization-count ' + (key === 'failed' && count > 0 ? 'failed' : '')
                    }
                    aria-label={`${count} 项`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      )}
      {tab === 'upload' ? (
        <UploadCenter panel folders={folders.data?.items ?? []} onComplete={reloadAll} />
      ) : tab === 'manual' ? (
        folders.error ? (
          <QueryFeedback query={folders} />
        ) : folders.loading ? (
          <Busy />
        ) : (
          <ManualClassification
            folders={folders.data?.items ?? []}
            config={config}
            onQueued={() => {
              void reloadAll();
              setTab('pending');
            }}
          />
        )
      ) : (
        <>
          {selected.length > 0 && (
            <div className="selection-bar">
              <span>已选 {selected.length} 张</span>
              <Button
                variant="secondary"
                disabled={action.pending}
                onClick={() =>
                  void action.run(async () => {
                    await api('admin/classification', json('POST', { ids: selected }));
                    await reloadAll();
                    setSelected([]);
                  }, '已安排重新整理')
                }
              >
                重新整理
              </Button>
              <select
                aria-label="人工整理目标"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择整理目标文件夹</option>
                {folders.data?.items.map((f: any) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <Button
                variant="secondary"
                disabled={!target || action.pending}
                onClick={() =>
                  void action.run(async () => {
                    await api(
                      'admin/images/batch',
                      json('POST', { ids: selected, action: 'move', folderId: target }),
                    );
                    await reloadAll();
                    setSelected([]);
                  }, '已人工整理')
                }
              >
                人工整理
              </Button>
            </div>
          )}
          <QueryFeedback query={{ ...result, reload: reloadAll }} backgroundOnly />
          {result.loading && !result.data ? (
            <Busy />
          ) : result.error ? (
            <QueryFeedback query={{ ...result, reload: reloadAll }} />
          ) : result.data?.items.length ? (
            <div className="panel table-wrap">
              <label className="organization-select-mobile">
                <input
                  ref={mobileSelection}
                  type="checkbox"
                  aria-label="全选本页整理任务"
                  checked={allSelected}
                  onChange={(e) => selectPage(e.target.checked)}
                />
                全选本页
              </label>
              <table className="organization-table organization-task-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        ref={pageSelection}
                        type="checkbox"
                        aria-label="全选本页整理任务"
                        checked={allSelected}
                        onChange={(e) => selectPage(e.target.checked)}
                      />
                    </th>
                    <th>图片</th>
                    <th>状态</th>

                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.items.map((image: any) => (
                    <tr key={image.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`选择 ${image.name}`}
                          checked={selected.includes(image.id)}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, image.id]
                                : selected.filter((id) => id !== image.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <div className="organization-image">
                          <div className="organization-thumbnail">
                            <Thumbnail
                              image={{ ...image, width: 1, height: 1, name: imageName(image.name) }}
                              actionLabel={`预览 ${imageName(image.name)}`}
                              onClick={() => setPreview(image)}
                            />
                          </div>
                          <div className="organization-image-info">
                            <strong title={`${image.name} · ${image.id}`}>
                              {imageName(image.name)}
                            </strong>
                            <small>
                              {folders.data?.items.find(
                                (folder: any) => folder.id === image.folderId,
                              )?.name ?? '未分类'}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        <span
                          className={`organization-status ${statusClass(image.classificationStatus)}`}
                        >
                          {labels[image.classificationStatus] ?? image.classificationStatus}
                        </span>
                        {image.error && <small>{image.error}</small>}
                        {image.publicationHold && <small>等待完成，暂不公开</small>}
                      </td>

                      <td>
                        <div className="button-row">
                          <Button
                            variant="ghost"
                            className="organization-retry"
                            disabled={action.pending}
                            onClick={() =>
                              void action.run(async () => {
                                await api(
                                  'admin/classification',
                                  json('POST', { ids: [image.id] }),
                                );
                                await reloadAll();
                              }, '已安排整理')
                            }
                          >
                            重新整理
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
              <Sparkles size={32} />
              <h3>这里还没有整理任务。</h3>
              <p>配置模型和目标文件夹后，从上传中心开始整理。</p>
            </div>
          )}
          <Pagination total={result.data?.total ?? 0} page={page} onChange={setPage} />
        </>
      )}
      <Preview image={preview} close={() => setPreview(undefined)} />
    </div>
  );
}
