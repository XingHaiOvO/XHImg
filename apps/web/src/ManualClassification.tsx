import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Play, Images } from 'lucide-react';
import { api, json, useData, useAction, useNotice } from './api';
import { Pagination, QueryFeedback, ActionFeedback, Button, Busy, Field } from './components/ui';
import type { ImageInfo } from '../../../packages/shared/src/index';

const available = (image: ImageInfo) =>
  image.state === 'ready' &&
  !['pending', 'processing'].includes(image.processingStatus ?? '') &&
  !['pending', 'running'].includes(image.classificationStatus ?? '');
export function ManualClassification({
  folders,
  config,
  onQueued,
}: {
  folders: any[];
  config: ReturnType<typeof useData<any>>;
  onQueued: () => void;
}) {
  const [folder, setFolder] = useState('uncategorized'),
    [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [selected, setSelected] = useState<string[]>([]);
  const result = useData<{ items: ImageInfo[]; total: number }>(
    `admin/images?${new URLSearchParams({ folderId: folder, search, page: String(page) })}`,
  );
  const action = useAction(),
    notice = useNotice();
  const items: ImageInfo[] = result.data?.items ?? [],
    eligible = items.filter(available);
  const reset = () => {
    setPage(1);
    setSelected([]);
  };
  return (
    <div className="manual-classification">
      <section className="panel">
        <h2>手动创建整理任务</h2>
        <p className="muted">
          选择已有图片，使用当前模型自动整理到允许的目标文件夹。每次最多100张，正在处理或整理的图片会跳过。
        </p>
        <div className="form-grid">
          <Field label="来源文件夹" hint="只显示当前文件夹，不包含子文件夹。">
            <select
              value={folder}
              disabled={action.pending}
              onChange={(e) => {
                setFolder(e.target.value);
                reset();
              }}
            >
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="搜索已有图片">
            <input
              value={search}
              disabled={action.pending}
              maxLength={120}
              placeholder="图片名称或标签"
              onChange={(e) => {
                setSearch(e.target.value);
                reset();
              }}
            />
          </Field>
        </div>
        {config.error && <QueryFeedback query={config} />}
        {config.data && !config.data.enabled && (
          <p className="muted">
            请先在<Link to="/admin/settings?tab=ai">模型配置</Link>中启用 AI 整理。
          </p>
        )}
        <div className="manual-actions">
          <Button
            variant="secondary"
            disabled={result.loading || !!result.error || !eligible.length || action.pending}
            onClick={() =>
              setSelected(
                [...new Set([...selected, ...eligible.map((image) => image.id)])].slice(0, 100),
              )
            }
          >
            选中本页可整理图片
          </Button>
          <Button
            variant="ghost"
            disabled={!selected.length || action.pending}
            onClick={() => setSelected([])}
          >
            清空选择
          </Button>
          <span className="manual-selection-count">已选 {selected.length} / 100</span>
          <Button
            className="manual-execute"
            disabled={!selected.length || !config.data?.enabled || action.pending}
            onClick={() =>
              void action.run(async () => {
                const receipt = await api(
                  'admin/classification',
                  json('POST', { ids: selected, skipUnavailable: true }),
                );
                setSelected([]);
                notice(
                  `已安排 ${receipt.queued} 张图片整理${receipt.skipped ? `，跳过 ${receipt.skipped} 张不可用或正在执行的图片` : ''}`,
                );
                if (receipt.queued) onQueued();
                else await result.reload();
              }, '')
            }
          >
            <Play size={15} />
            执行整理
          </Button>
        </div>
      </section>
      <ActionFeedback action={action} />
      <QueryFeedback query={result} backgroundOnly />
      {result.loading ? (
        <Busy />
      ) : result.error ? (
        <QueryFeedback query={result} />
      ) : items.length ? (
        <div className="panel table-wrap">
          <table className="organization-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>图片</th>
                <th>状态</th>
                <th>归属</th>
                <th>预览</th>
              </tr>
            </thead>
            <tbody>
              {items.map((image) => (
                <tr key={image.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${image.name}`}
                      checked={selected.includes(image.id)}
                      disabled={
                        !available(image) ||
                        action.pending ||
                        (!selected.includes(image.id) && selected.length >= 100)
                      }
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
                    <small>
                      {image.width} × {image.height} · {image.format.toUpperCase()}
                    </small>
                  </td>
                  <td>
                    {!available(image)
                      ? '处理中或暂不可用'
                      : image.classificationStatus === 'skipped'
                        ? '未分类'
                        : '可重新整理'}
                  </td>
                  <td>{folders.find((f) => f.id === image.folderId)?.name ?? '未分类'}</td>
                  <td>
                    {image.thumbnailState === 'ready' ? (
                      <a
                        href={image.url}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`预览 ${image.name}`}
                      >
                        <img
                          className="manual-task-thumbnail"
                          src={image.thumbnailUrl}
                          alt={image.name}
                          loading="lazy"
                        />
                      </a>
                    ) : (
                      <span className="muted">缩略图待就绪</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          <Images size={32} />
          <h3>没有符合条件的图片</h3>
          <p>更换文件夹或搜索内容后再选择。</p>
          <Button asChild variant="secondary">
            <Link to="/admin/organize">去上传</Link>
          </Button>
        </div>
      )}
      {(result.data?.total ?? 0) > 40 && (
        <fieldset className="pagination-guard" disabled={action.pending || result.loading}>
          <Pagination total={result.data?.total ?? 0} page={page} onChange={setPage} />
        </fieldset>
      )}
    </div>
  );
}
