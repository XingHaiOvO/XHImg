import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles } from 'lucide-react';
import { api, json, useData, useAction } from './api';
import { Button, Busy } from './components/ui';
import { PageHeading } from './Resources';
import { UploadCenter } from './components/UploadCenter';
import { ManualClassification } from './ManualClassification';
export function Organization() {
  const [tab, setTab] = useState('upload'),
    [selected, setSelected] = useState<string[]>([]),
    [target, setTarget] = useState(''),
    [page, setPage] = useState(1),
    folders = useData('admin/folders'),
    action = useAction();
  const result = useData(
    `admin/classification?status=${tab === 'upload' ? 'all' : tab}&page=${page}`,
  );
  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [tab]);
  useEffect(() => {
    if (tab === 'pending' || tab === 'running') {
      const timer = setInterval(() => void result.reload(), 3000);
      return () => clearInterval(timer);
    }
  }, [tab, result.reload]);
  const labels: Record<string, string> = {
    pending: '等待分类',
    running: '正在分类',
    completed: '已归档',
    unmatched: '无法匹配',
    failed: '分类失败',
    canceled: '人工调整后取消',
    skipped: '未分类',
  };
  return (
    <>
      <PageHeading title="智能整理" description="上传、处理、归档，让图片自然进入正确的资源空间。">
        <Button asChild variant="secondary">
          <Link to="/admin/settings?tab=ai">模型配置</Link>
        </Button>
      </PageHeading>
      <div className="tabs">
        {[
          ['upload', '上传中心'],
          ['manual', '手动任务'],
          ['pending', '待分类'],
          ['running', '进行中'],
          ['completed', '已完成'],
          ['unmatched', '无法匹配'],
          ['failed', '失败任务'],
          ['all', '全部任务'],
        ].map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key!)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'upload' ? (
        <section className="panel">
          <UploadCenter folders={folders.data?.items ?? []} onComplete={result.reload} />
        </section>
      ) : tab === 'manual' ? (
        folders.error ? (
          <p role="alert">{folders.error}</p>
        ) : folders.loading ? (
          <Busy />
        ) : (
          <ManualClassification
            folders={folders.data?.items ?? []}
            onQueued={() => setTab('pending')}
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
                    await result.reload();
                    setSelected([]);
                  }, '已安排重新分类')
                }
              >
                重新分类
              </Button>
              <select
                aria-label="人工归档目标"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">选择归档文件夹</option>
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
                    await result.reload();
                    setSelected([]);
                  }, '已人工归档')
                }
              >
                人工归档
              </Button>
            </div>
          )}
          {result.loading && !result.data ? (
            <Busy />
          ) : result.error ? (
            <p role="alert">{result.error}</p>
          ) : result.data?.items.length ? (
            <div className="panel table-wrap">
              <table className="organization-table">
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>图片</th>
                    <th>状态</th>
                    <th>归属</th>
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
                        <strong>{image.name}</strong>
                        <small>{image.id}</small>
                      </td>
                      <td>
                        {labels[image.classificationStatus] ?? image.classificationStatus}
                        {image.error && <small>{image.error}</small>}
                        {image.publicationHold && <small>等待完成，暂不公开</small>}
                      </td>
                      <td>
                        {folders.data?.items.find((f: any) => f.id === image.folderId)?.name ??
                          '未分类'}
                      </td>
                      <td>
                        <div className="button-row">
                          <Button
                            variant="secondary"
                            disabled={action.pending}
                            onClick={() =>
                              void action.run(async () => {
                                await api(
                                  'admin/classification',
                                  json('POST', { ids: [image.id] }),
                                );
                                await result.reload();
                              }, '已安排分类')
                            }
                          >
                            重新分类
                          </Button>
                          <Button asChild variant="ghost">
                            <Link to={`/admin/folders?folder=${image.folderId}`}>查看图片</Link>
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
              <h3>这里还没有分类任务。</h3>
              <p>配置模型和目标文件夹后，从上传中心开始整理。</p>
            </div>
          )}
          <div className="pagination">
            <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
              上一页
            </Button>
            <span>第 {page} 页</span>
            <Button
              variant="secondary"
              disabled={!result.data || page * 40 >= result.data.total}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </>
  );
}
