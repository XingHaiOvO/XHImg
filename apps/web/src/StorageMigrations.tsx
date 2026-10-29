import { useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { ArrowRightLeft, Plus, RefreshCw } from 'lucide-react';
import { api, json, useData, useAction, usePolling, bytes } from './api';
import { QueryFeedback, ActionFeedback, Button, Modal, Field, Check, Busy } from './components/ui';
import type { StorageMigration, MigrationItem } from '../../../packages/shared/src/index';

const states: Record<string, string> = {
  draft: '待确认',
  queued: '等待迁移',
  running: '正在迁移',
  pausing: '正在暂停',
  paused: '已暂停',
  canceling: '正在取消',
  canceled: '已取消',
  completed: '已完成',
  completed_with_errors: '部分失败',
  failed: '迁移失败',
  expired: '草稿已过期',
  pending: '等待执行',
  copying: '正在复制',
  committed: '迁移成功',
  skipped: '已跳过',
};
const phases: Record<string, string> = {
  waiting: '等待执行',
  copying: '复制',
  verifying: '校验',
  switching: '切换',
  completed: '完成',
  failed: '失败',
  paused: '暂停',
  canceled: '取消',
};
const cleanStates: Record<string, string> = {
  retained: '源副本已保留',
  cleaning: '正在验证并清理',
  partial_failed: '部分清理失败',
  cleaned: '清理已完成',
};
const terminal = ['completed', 'completed_with_errors', 'failed', 'canceled'];
export function MigrationCreateDialog({
  imageIds,
  close,
  onStarted,
  onDraft,
}: {
  imageIds?: string[];
  close: () => void;
  onStarted: (task: StorageMigration) => void;
  onDraft?: (task: StorageMigration) => void;
}) {
  const storages = useData('admin/storage-backends'),
    folders = useData('admin/folders'),
    action = useAction();
  const [source, setSource] = useState(''),
    [target, setTarget] = useState(''),
    [folder, setFolder] = useState(''),
    [children, setChildren] = useState(false),
    [trash, setTrash] = useState(false),
    [draft, setDraft] = useState<StorageMigration>();
  const enabled = storages.data?.items.filter((s: any) => s.enabled && s.id !== source) ?? [];
  return (
    <Modal
      busy={action.pending}
      open
      onOpenChange={(v) => {
        if (!v && !action.pending) close();
      }}
      title={draft ? '确认迁移清单' : '创建存储迁移'}
      description="迁移现有图片，保留 ID、直链和权限；不改变新上传的默认存储。"
    >
      {storages.loading || folders.loading ? (
        <Busy />
      ) : storages.error || folders.error ? (
        <>
          <QueryFeedback query={storages} />
          <QueryFeedback query={folders} />
        </>
      ) : draft ? (
        <>
          <div className="migration-preview">
            <p>
              目标存储：<strong>{draft.target_name}</strong>
            </p>
            <p>
              清单已冻结：<strong>{draft.total_count} 张</strong>，其中可执行{' '}
              <strong>{draft.total_count - draft.skipped_count} 张</strong>。
            </p>
            <p>当前结果与保留原图约 {bytes(draft.estimated_bytes)}，不含缩略图。</p>
            <p className="muted">
              草稿有效至 {new Date(draft.expires_at).toLocaleTimeString('zh-CN')}
              。源副本将保留，迁移结束后可手动清理。
            </p>
            {draft.skipReasons.map((reason) => (
              <p key={reason.reason}>
                {reason.reason}：{reason.count} 张
              </p>
            ))}
          </div>
          <div className="button-row">
            <Button
              disabled={action.pending || draft.total_count === draft.skipped_count}
              onClick={() =>
                void action.run(async () => {
                  const task = await api<StorageMigration>(
                    `admin/storage-migrations/${draft.id}/start`,
                    json('POST'),
                  );
                  onStarted(task);
                  close();
                }, '迁移任务已开始')
              }
            >
              确认执行迁移
            </Button>
            <Button
              variant="secondary"
              disabled={action.pending}
              onClick={() =>
                void action.run(async () => {
                  await api(`admin/storage-migrations/${draft.id}/cancel`, json('POST'));
                  setDraft(undefined);
                }, '')
              }
            >
              返回修改
            </Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action.run(async () => {
              const task = await api<StorageMigration>(
                'admin/storage-migrations',
                json('POST', {
                  targetStorageId: target,
                  ...(imageIds
                    ? { imageIds }
                    : { sourceStorageId: source, ...(folder ? { folderId: folder } : {}) }),
                  includeChildren: children,
                  includeTrash: trash,
                }),
              );
              setDraft(task);
              onDraft?.(task);
            }, '');
          }}
        >
          {imageIds ? (
            <p>已选择 {imageIds.length} 张图片。每批最多100张。</p>
          ) : (
            <>
              <Field label="来源存储">
                <select
                  required
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    if (target === e.target.value) setTarget('');
                  }}
                >
                  <option value="">请选择来源存储</option>
                  {storages.data?.items.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {s.enabled ? '' : '（已停用，仍可读取）'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="来源文件夹">
                <select value={folder} onChange={(e) => setFolder(e.target.value)}>
                  <option value="">该来源存储的全部文件夹</option>
                  {folders.data?.items.map((f: any) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Check
                label="包含子文件夹"
                checked={children}
                disabled={!folder}
                onChange={(e) => setChildren(e.target.checked)}
              />
            </>
          )}
          <Field label="目标存储">
            <select required value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">请选择已启用的目标存储</option>
              {enabled.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Check
            label="包含回收站图片（仍保留删除状态）"
            checked={trash}
            onChange={(e) => setTrash(e.target.checked)}
          />
          <p className="muted">
            只处理确认时的图片集合。迁空旧存储前，请先手动调整新上传目标。复制和校验会读取、写入对象，云服务可能按流量计费。
          </p>
          <Button
            disabled={
              action.pending ||
              !target ||
              (!imageIds && !source) ||
              (!!imageIds && imageIds.length > 100)
            }
          >
            {action.pending ? '正在生成清单…' : '预览迁移清单'}
          </Button>
        </form>
      )}
      <ActionFeedback action={action} />
    </Modal>
  );
}
export function StorageMigrations() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('task') ?? '';
  const setSelected = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('task', id);
    setParams(next);
  };
  const [page, setPage] = useState(1),
    [creating, setCreating] = useState(false);
  const list = useData<{ items: StorageMigration[]; total: number }>(
    `admin/storage-migrations?page=${page}`,
  );
  usePolling(
    list.reload,
    !!list.data?.items.some(
      (task) =>
        ['queued', 'running', 'pausing', 'canceling'].includes(task.state) ||
        task.cleanup_state === 'cleaning',
    ),
  );
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>存储迁移</h2>
          <p className="muted">逐图校验后切换，源副本由你决定何时清理。</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} />
          创建迁移任务
        </Button>
      </div>
      {creating && (
        <MigrationCreateDialog
          close={() => {
            setCreating(false);
            void list.reload();
          }}
          onDraft={(task) => {
            setSelected(task.id);
            void list.reload();
          }}
          onStarted={(task) => {
            setSelected(task.id);
            void list.reload();
          }}
        />
      )}
      <QueryFeedback query={list} backgroundOnly />
      {list.error ? (
        <QueryFeedback query={list} />
      ) : list.loading && !list.data ? (
        <Busy />
      ) : list.data?.items.length ? (
        <div className="migration-task-list">
          {list.data.items.map((task) => (
            <button
              key={task.id}
              className={`panel migration-task ${selected === task.id ? 'active' : ''}`}
              onClick={() => setSelected(task.id)}
            >
              <ArrowRightLeft size={20} />
              <span>
                <strong>迁往 {task.target_name}</strong>
                <small>
                  {new Date(task.created_at).toLocaleString('zh-CN')} · {task.total_count} 张
                </small>
              </span>
              <span>
                {states[task.state] ?? task.state}
                <small>
                  成功 {task.success_count} · 失败 {task.failed_count} · 跳过 {task.skipped_count}
                </small>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty">
          <ArrowRightLeft size={30} />
          <h3>还没有迁移任务。</h3>
          <p>创建任务，先预览已有图片的迁移清单。</p>
        </div>
      )}
      <div className="pagination">
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页
        </Button>
        <span>第 {page} 页</span>
        <Button
          variant="secondary"
          disabled={!list.data || page * 40 >= list.data.total}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </Button>
      </div>
      {selected && <MigrationDetails key={selected} id={selected} onChange={list.reload} />}
    </>
  );
}
function MigrationDetails({ id, onChange }: { id: string; onChange: () => Promise<void> }) {
  const [page, setPage] = useState(1),
    [filter, setFilter] = useState(''),
    [confirm, setConfirm] = useState<'cleanup' | 'cancel'>();
  const task = useData<StorageMigration>(`admin/storage-migrations/${id}`),
    items = useData<{ items: MigrationItem[]; total: number }>(
      `admin/storage-migrations/${id}/items?page=${page}&${filter ? 'state=' + filter : ''}`,
    ),
    action = useAction();
  const reload = async () => {
    await Promise.all([task.reload(), items.reload(), onChange()]);
  };
  usePolling(
    async () => {
      await Promise.all([task.reload(), items.reload()]);
    },
    !!task.data &&
      (['queued', 'running', 'pausing', 'canceling'].includes(task.data.state) ||
        task.data.cleanup_state === 'cleaning'),
  );
  const execute = (verb: string) =>
    action.run(
      async () => {
        await api(`admin/storage-migrations/${id}/${verb}`, json('POST'));
        setConfirm(undefined);
        await reload();
      },
      verb === 'cleanup' ? '源副本清理已安排' : '任务状态已更新',
    );
  if (task.error) return <QueryFeedback query={task} />;
  if (!task.data) return <Busy />;
  const t = task.data,
    finished = t.success_count + t.failed_count + t.skipped_count + t.canceled_count;
  return (
    <section className="panel migration-details">
      <QueryFeedback query={task} />
      <div className="section-heading">
        <h3>迁往 {t.target_name}</h3>
        <span className="badge">{states[t.state] ?? t.state}</span>
      </div>
      <p className="muted">{t.id}</p>
      <p>
        已处理 {finished} / {t.total_count} 张，成功迁移 {t.success_count} 张。
      </p>
      <progress aria-label="迁移任务进度" value={finished} max={Math.max(t.total_count, 1)} />
      <p>
        成功 {t.success_count} · 失败 {t.failed_count} · 跳过 {t.skipped_count} · 取消{' '}
        {t.canceled_count}
      </p>
      {t.error && (
        <p className="form-error" role="alert">
          {t.error}
        </p>
      )}
      <div className="button-row migration-controls">
        {t.state === 'draft' && (
          <Button
            disabled={
              action.pending || t.expires_at <= Date.now() || t.total_count === t.skipped_count
            }
            onClick={() => void execute('start')}
          >
            确认执行迁移
          </Button>
        )}
        {['queued', 'running'].includes(t.state) && (
          <Button
            variant="secondary"
            disabled={action.pending}
            onClick={() => void execute('pause')}
          >
            暂停迁移
          </Button>
        )}
        {t.state === 'paused' && (
          <Button disabled={action.pending} onClick={() => void execute('resume')}>
            继续迁移
          </Button>
        )}
        {terminal.includes(t.state) && t.failed_count > 0 && (
          <Button
            variant="secondary"
            disabled={action.pending}
            onClick={() => void execute('retry')}
          >
            重试失败图片
          </Button>
        )}
        {['draft', 'queued', 'running', 'paused', 'pausing'].includes(t.state) && (
          <Button variant="ghost" disabled={action.pending} onClick={() => setConfirm('cancel')}>
            取消迁移
          </Button>
        )}
        <Button variant="ghost" disabled={action.pending} onClick={() => void reload()}>
          <RefreshCw size={14} />
          刷新任务
        </Button>
      </div>
      <div className="migration-source-note">
        <strong>
          {!terminal.includes(t.state) && t.retained_count === 0
            ? '切换成功后保留源副本'
            : (cleanStates[t.cleanup_state] ?? t.cleanup_state)}
        </strong>
        <p>
          待清理源副本：{t.retained_count} 个对象，{bytes(t.retained_bytes)}（含缩略图）。
        </p>
        {terminal.includes(t.state) && t.retained_count > 0 && t.cleanup_state !== 'cleaning' && (
          <Button
            variant="destructive"
            disabled={action.pending}
            onClick={() => setConfirm('cleanup')}
          >
            {t.cleanup_state === 'partial_failed' ? '重试源副本清理' : '清理源副本'}
          </Button>
        )}
      </div>
      <Field label="明细状态">
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          {[
            'draft',
            'pending',
            'copying',
            'paused',
            'committed',
            'failed',
            'skipped',
            'canceled',
          ].map((state) => (
            <option key={state} value={state}>
              {states[state] ?? state}
            </option>
          ))}
        </select>
      </Field>
      <QueryFeedback query={items} backgroundOnly />
      {items.error ? (
        <QueryFeedback query={items} />
      ) : items.loading && !items.data ? (
        <Busy />
      ) : (
        <div className="table-wrap">
          <table className="migration-items">
            <thead>
              <tr>
                <th>图片</th>
                <th>来源</th>
                <th>阶段</th>
                <th>结果</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {items.data?.items.map((item) => (
                <tr key={item.id}>
                  <td data-label="图片">
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.image_id}</small>
                    </span>
                  </td>
                  <td data-label="来源">{item.source_name}</td>
                  <td data-label="阶段">{phases[item.phase] ?? item.phase}</td>
                  <td data-label="结果">{states[item.state] ?? item.state}</td>
                  <td data-label="说明">{item.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="pagination">
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
          上一页明细
        </Button>
        <span>第 {page} 页</span>
        <Button
          variant="secondary"
          disabled={!items.data || page * 40 >= items.data.total}
          onClick={() => setPage(page + 1)}
        >
          下一页明细
        </Button>
      </div>
      <Modal
        busy={action.pending}
        cancelFocus
        open={!!confirm}
        onOpenChange={(v) => {
          if (!v && !action.pending) setConfirm(undefined);
        }}
        title={confirm === 'cleanup' ? '确认清理源副本' : '确认取消迁移'}
        description={
          confirm === 'cleanup'
            ? '将删除此任务已迁移成功图片在原存储中的保留副本，不能撤销。清理前会验证当前有效对象。'
            : '已完成的迁移会保留；未完成图片继续使用原存储，未提交的目标副本会清理。'
        }
      >
        <p>
          {confirm === 'cleanup'
            ? `${t.retained_count} 个源对象，约 ${bytes(t.retained_bytes)}。目标不可用时会保留源副本。`
            : `已成功迁移 ${t.success_count} 张，取消不会回滚这些图片。`}
        </p>
        <div className="modal-actions">
          <Button
            data-cancel
            variant="secondary"
            disabled={action.pending}
            onClick={() => setConfirm(undefined)}
          >
            返回
          </Button>
          <Button
            variant="destructive"
            disabled={action.pending}
            onClick={() => confirm && void execute(confirm)}
          >
            {confirm === 'cleanup' ? '确认清理源副本' : '确认取消迁移'}
          </Button>
        </div>
        <ActionFeedback action={action} />
      </Modal>
    </section>
  );
}
