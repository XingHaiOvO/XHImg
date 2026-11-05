import { useUrlTab } from './navigation';
import { useState, useEffect, useId, useRef, lazy, Suspense } from 'react';
import {
  Plus,
  HardDrive,
  Cloud,
  KeyRound,
  Copy,
  MoreHorizontal,
  Trash2,
  ImageIcon,
  Eye,
  EyeOff,
} from 'lucide-react';
import { api, json, useData, useAction, useNotice, bytes, copy } from './api';
import {
  QueryFeedback,
  useConfirm,
  ActionFeedback,
  Button,
  Field,
  Check,
  Modal,
  Busy,
  Pagination,
} from './components/ui';
import { useImageSource } from './image-links';
import type { ImageInfo } from '../../../packages/shared/src/index';
import { PageHeading } from './Resources';
import { ProcessingSettings, AISettings } from './P1Settings';
const StorageMigrations = lazy(() =>
  import('./StorageMigrations').then((module) => ({ default: module.StorageMigrations })),
);
export function SettingsPage() {
  const [tab, setTab] = useUrlTab(
    ['storage', 'migrations', 'keys', 'processing', 'ai', 'site', 'security'],
    'storage',
  );
  const labels: Record<string, string> = {
    storage: '存储后端',
    migrations: '存储迁移',
    keys: 'API Key',
    processing: '图片处理',
    ai: 'AI 模型',
    site: '站点设置',
    security: '管理员安全',
  };
  return (
    <>
      <PageHeading title="设置中心" description="管理存储、图片处理、站点与账户配置。" />
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          {Object.keys(labels).map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              aria-current={tab === t ? 'page' : undefined}
              onClick={() => setTab(t)}
            >
              {labels[t]}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === 'storage' ? (
            <StorageSettings />
          ) : tab === 'migrations' ? (
            <Suspense fallback={<Busy />}>
              <StorageMigrations />
            </Suspense>
          ) : tab === 'keys' ? (
            <KeySettings />
          ) : tab === 'site' ? (
            <SiteSettings />
          ) : tab === 'processing' ? (
            <ProcessingSettings />
          ) : tab === 'ai' ? (
            <AISettings />
          ) : (
            <SecuritySettings />
          )}
        </div>
      </div>
    </>
  );
}
function StorageSettings() {
  const { data, error, loading, reload, refreshError, refreshing } =
      useData('admin/storage-backends'),
    [edit, setEdit] = useState<any>(),
    action = useAction();
  const addStorage = () =>
    setEdit({
      name: '',
      type: 's3',
      enabled: 1,
      is_default: 0,
      config: { endpoint: '', region: 'auto', bucket: '', forcePathStyle: true },
    });
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>存储后端</h2>
          <p className="muted">停用只阻止新上传，已有图片仍可读取。</p>
        </div>
        <Button onClick={addStorage}>
          <Plus size={16} />
          添加存储
        </Button>
      </div>
      <QueryFeedback query={{ error: refreshError, refreshing, reload }} />
      {loading ? (
        <Busy />
      ) : error ? (
        <QueryFeedback query={{ error, reload }} />
      ) : !data?.items.length ? (
        <div className="empty">
          <HardDrive size={28} />
          <h3>还没有存储后端</h3>
          <Button onClick={addStorage}>添加第一个存储</Button>
        </div>
      ) : (
        <div className="storage-grid">
          {data?.items.map((s: any) => (
            <section className="panel storage-card" key={s.id}>
              <div className="section-heading">
                {s.type === 'local' ? <HardDrive size={26} /> : <Cloud size={26} />}
                <span className={'badge ' + (s.enabled ? 'good' : '')}>
                  {s.is_default ? '默认存储' : s.enabled ? '已启用' : '已停用'}
                </span>
              </div>
              <h3 title={s.id}>{s.name}</h3>
              <p className="muted">{s.type === 'local' ? '本地文件系统' : s.config.endpoint}</p>
              <div className="storage-usage">
                <strong>{bytes(s.size)}</strong>
                <span>{s.count} 张图片</span>
                {!!s.retainedMigrationObjects && (
                  <small>
                    另有迁移源副本 {s.retainedMigrationObjects} 个 /{' '}
                    {bytes(s.retainedMigrationBytes)}（含缩略图）
                  </small>
                )}
              </div>
              <div className="button-row">
                <details className="storage-menu">
                  <summary aria-label={`更多存储操作：${s.name}`}>
                    <MoreHorizontal size={18} />
                  </summary>
                  <div className="storage-menu-items">
                    <Button
                      variant="ghost"
                      disabled={action.pending}
                      onClick={() =>
                        void action.run(
                          () => api(`admin/storage-backends/${s.id}/test`, json('POST')),
                          '连接测试通过',
                        )
                      }
                    >
                      测试连接
                    </Button>
                    {!s.is_default && s.enabled === 1 && (
                      <Button
                        variant="ghost"
                        disabled={action.pending}
                        onClick={() =>
                          void action.run(async () => {
                            await api(
                              `admin/storage-backends/${s.id}`,
                              json('PATCH', { isDefault: true }),
                            );
                            await reload();
                          })
                        }
                      >
                        设为默认
                      </Button>
                    )}
                  </div>
                </details>
                <Button variant="secondary" onClick={() => setEdit(s)}>
                  配置
                </Button>
              </div>
            </section>
          ))}
        </div>
      )}
      <StorageEditor value={edit} close={() => setEdit(undefined)} reload={reload} />
      <section className="panel maintenance-note">
        <p>备份应包含数据库、本地图片、部署配置与 MASTER_KEY。详见 docs/operations.md。</p>
      </section>
    </>
  );
}
function StorageEditor({ value, close, reload }: any) {
  const confirm = useConfirm();
  const notice = useNotice();
  const formId = useId();
  const [showSecret, setShowSecret] = useState(false),
    [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState<any>({}),
    [credentials, setCredentials] = useState({ accessKeyId: '', secretAccessKey: '' }),
    action = useAction();
  useEffect(() => {
    if (value) {
      setSaved(false);
      setShowSecret(false);
      setDraft({ ...value, enabled: !!value.enabled, isDefault: !!value.is_default });
      setCredentials({ accessKeyId: '', secretAccessKey: '' });
    }
  }, [value]);
  const config = (key: string, v: any) =>
    setDraft({ ...draft, config: { ...draft.config, [key]: v } });
  return (
    <Modal
      cancelFocus
      busy={action.pending}
      open={!!value}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={value?.id ? '存储配置' : '添加存储'}
      description="配置图片存储连接与上传策略。"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            data-cancel
            onClick={close}
            disabled={action.pending}
          >
            取消
          </Button>
          {saved && (
            <Button type="button" variant="ghost" onClick={() => location.reload()}>
              刷新查看
            </Button>
          )}
          <div className="button-row">
            <Button type="submit" form={formId} disabled={action.pending || saved}>
              {action.pending ? '正在提交…' : '保存存储'}
            </Button>
            {value?.id && !value.is_default && (
              <Button
                type="button"
                variant="destructive"
                disabled={action.pending || saved}
                onClick={async () => {
                  if (!(await confirm(`删除存储配置“${value.name}”？仍被引用时会阻止删除。`)))
                    return;
                  void action.run(async () => {
                    await api(`admin/storage-backends/${value.id}`, json('DELETE'));
                    await reload();
                    close();
                  });
                }}
              >
                删除配置
              </Button>
            )}
          </div>
        </>
      }
    >
      <form
        id={formId}
        className="settings-modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (saved) return;
          void action.run(async () => {
            const body: any = {
              name: draft.name,
              enabled: draft.enabled,
              isDefault: draft.isDefault,
            };
            if (value.id && value.type === 's3') {
              const changed = JSON.stringify(draft.config) !== JSON.stringify(value.config);
              const hasCredentials = credentials.accessKeyId && credentials.secretAccessKey;
              if (
                (changed || credentials.accessKeyId || credentials.secretAccessKey) &&
                !hasCredentials
              )
                throw new Error('修改存储连接时，必须同时填写 Access Key 与 Secret Key');
            }
            if (!value.id) {
              body.type = draft.type;
              body.config = draft.type === 's3' ? { ...draft.config, ...credentials } : {};
            } else if (
              value.type === 's3' &&
              credentials.accessKeyId &&
              credentials.secretAccessKey
            )
              body.config = { ...draft.config, ...credentials };
            await api(
              'admin/storage-backends' + (value.id ? `/${value.id}` : ''),
              json(value.id ? 'PATCH' : 'POST', body),
            );
            await reload();
            setSaved(true);
            notice('存储已保存，刷新页面后生效');
          }, '');
        }}
      >
        <fieldset className="modal-fields" disabled={saved}>
          <section className="modal-form-group">
            <h3>基本信息</h3>
            <Field label="名称">
              <input
                required
                value={draft.name ?? ''}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            {!value?.id && (
              <Field label="存储类型">
                <select
                  value={draft.type ?? 's3'}
                  onChange={(e) => setDraft({ ...draft, type: e.target.value })}
                >
                  <option value="s3">S3 兼容对象存储</option>
                  <option value="local">本地文件系统</option>
                </select>
              </Field>
            )}
          </section>
          {draft.type === 's3' && (
            <section className="modal-form-group">
              <h3>连接与凭证</h3>
              <div className="modal-note">
                <p>
                  {value?.id
                    ? '修改连接参数时，必须同时重新输入两项凭证；已有图片的连接不可更换。'
                    : '支持 S3、R2、MinIO 等 S3 兼容服务。'}
                </p>
                <details>
                  <summary>查看说明</summary>
                  <p>Endpoint 必须可被图片访问者访问；HTTPS 站点请使用 HTTPS Endpoint。</p>
                  <p>
                    S3 Bucket 保持私有。鉴权后返回最长有效 5
                    分钟的临时直链。保存后可刷新页面以应用图片来源策略。
                  </p>
                </details>
              </div>
              {[
                ['endpoint', 'Endpoint'],
                ['region', 'Region'],
                ['bucket', 'Bucket'],
              ].map(([key, label]) => (
                <Field key={key} label={label!}>
                  <input
                    required
                    value={draft.config?.[key!] ?? ''}
                    onChange={(e) => config(key!, e.target.value)}
                  />
                </Field>
              ))}
              <Field label="Access Key">
                <input
                  required={!value?.id}
                  autoComplete="off"
                  value={credentials.accessKeyId}
                  onChange={(e) => setCredentials({ ...credentials, accessKeyId: e.target.value })}
                />
              </Field>
              <div className="modal-secret-field">
                <Field label="Secret Key" hint="凭证加密保存，读取配置时不会返回。">
                  <input
                    type={showSecret ? 'text' : 'password'}
                    required={!value?.id}
                    autoComplete="new-password"
                    value={credentials.secretAccessKey}
                    onChange={(e) =>
                      setCredentials({ ...credentials, secretAccessKey: e.target.value })
                    }
                  />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  className="modal-secret-toggle"
                  aria-label={showSecret ? '隐藏 Secret Key' : '显示 Secret Key'}
                  aria-pressed={showSecret}
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </Button>
              </div>
              <Check
                label="使用 Path Style"
                checked={!!draft.config?.forcePathStyle}
                onChange={(e) => config('forcePathStyle', e.target.checked)}
              />
            </section>
          )}
          <section className="modal-form-group">
            <h3>上传策略</h3>
            <Check
              label="允许新上传"
              checked={!!draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            <Check
              label="设为默认存储"
              checked={!!draft.isDefault}
              disabled={!!value?.is_default}
              onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
            />
            {!value?.id && (
              <p className="modal-field-hint">勾选后，新建即设为默认，新上传会写入此存储。</p>
            )}
          </section>
        </fieldset>
        <ActionFeedback action={action} />
      </form>
    </Modal>
  );
}
function KeySettings() {
  const confirm = useConfirm();
  const keys = useData('admin/api-keys'),
    folders = useData('admin/folders'),
    services = useData('admin/random-services'),
    storages = useData('admin/storage-backends'),
    [open, setOpen] = useState(false),
    [created, setCreated] = useState(''),
    action = useAction(),
    notice = useNotice();
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>API Key</h2>
          <p className="muted">每个密钥独立授权，上传不等于私有读取。</p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <Plus size={16} />
          创建密钥
        </Button>
      </div>
      <QueryFeedback query={keys} backgroundOnly />
      {keys.loading ? (
        <Busy />
      ) : keys.error ? (
        <QueryFeedback query={keys} />
      ) : !keys.data?.items.length ? (
        <div className="empty">
          <KeyRound size={28} />
          <h3>还没有 API Key</h3>
          <Button onClick={() => setOpen(true)}>创建第一个密钥</Button>
        </div>
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称与前缀</th>
                <th>操作权限与范围</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>最近使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.data?.items.map((k: any) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                    <small title={k.prefix}>{k.prefix}…</small>
                  </td>
                  <td>
                    <div className="tags">
                      {k.permissions.map((p: string) => (
                        <span className="badge" key={p}>
                          {p}
                        </span>
                      ))}
                    </div>
                    <div className="tags">
                      {k.grants.map((g: any, index: number) => (
                        <span className="badge" key={index} title={g.resource_id}>
                          {g.kind === 'all'
                            ? '全部资源'
                            : `${g.kind}: ${g.kind === 'storage' && g.resource_id === 'local' ? 'local' : ((g.kind === 'folder' ? folders.data?.items : g.kind === 'service' ? services.data?.items : storages.data?.items)?.find((resource: any) => resource.id === g.resource_id)?.name ?? '指定资源')}${g.descendants ? '（含子目录）' : ''}`}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <span
                      className={
                        'badge ' +
                        (!k.revoked && (!k.expires || k.expires >= Date.now()) ? 'good' : '')
                      }
                    >
                      {k.revoked
                        ? '已撤销'
                        : k.expires && k.expires < Date.now()
                          ? '已过期'
                          : '有效'}
                    </span>
                    {k.expires && <small>{new Date(k.expires).toLocaleString('zh-CN')} 到期</small>}
                  </td>
                  <td>{k.created_at ? new Date(k.created_at).toLocaleString('zh-CN') : '—'}</td>
                  <td>
                    {k.last_used ? new Date(k.last_used).toLocaleString('zh-CN') : '尚未使用'}
                  </td>
                  <td>
                    <Button
                      variant="ghost"
                      className="settings-revoke icon-button"
                      aria-label="撤销密钥"
                      title={`撤销密钥：${k.name}`}
                      disabled={!!k.revoked || action.pending}
                      onClick={async () => {
                        if (
                          await confirm(
                            `撤销密钥“${k.name}”后，此密钥及其私有签名链接立即失效，确认撤销？`,
                          )
                        )
                          void action.run(async () => {
                            await api(`admin/api-keys/${k.id}`, json('DELETE'));
                            await keys.reload();
                          }, '密钥已撤销');
                      }}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <KeyEditor
        open={open}
        close={() => setOpen(false)}
        folders={folders.data?.items ?? []}
        services={services.data?.items ?? []}
        storages={storages.data?.items ?? []}
        done={async (key: string) => {
          setCreated(key);
          setOpen(false);
          await keys.reload();
        }}
      />
      <Modal
        open={!!created}
        onOpenChange={(v) => {
          if (!v) setCreated('');
        }}
        title="请保存你的 API Key"
        description="完整密钥仅显示这一次。关闭后无法再次查看。"
      >
        <div className="secret-value">
          <code>{created}</code>
        </div>
        <Button
          onClick={() =>
            void copy(created)
              .then(() => notice('密钥已复制，请妥善保存'))
              .catch(() => notice('复制失败，请手动保存', true))
          }
        >
          <Copy size={16} />
          复制密钥
        </Button>
      </Modal>
    </>
  );
}
function KeyEditor({ open, close, folders, services, storages, done }: any) {
  const [title, setTitle] = useState(''),
    [permissions, setPermissions] = useState<string[]>(['upload']);
  const [grants, setGrants] = useState([{ kind: 'folder', resourceId: '', descendants: false }]);
  const [expiry, setExpiry] = useState(''),
    [rate, setRate] = useState(120),
    action = useAction();
  const formId = useId();
  const togglePermission = (permission: string, checked: boolean) => {
    setPermissions((current) => {
      let next = checked
        ? [...new Set([...current, permission])]
        : current.filter((p) => p !== permission);
      if (permission === 'private:read' && checked) next = [...new Set([...next, 'read'])];
      if (permission === 'read' && !checked) next = next.filter((p) => p !== 'private:read');
      return next;
    });
  };
  const patch = (index: number, value: any) =>
    setGrants(grants.map((g, i) => (i === index ? { ...g, ...value } : g)));
  return (
    <Modal
      cancelFocus
      busy={action.pending}
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="创建 API Key"
      description="为应用选择操作权限和资源范围。"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            data-cancel
            onClick={close}
            disabled={action.pending}
          >
            取消
          </Button>
          <div className="button-row">
            <Button type="submit" form={formId} disabled={action.pending || !permissions.length}>
              创建并显示密钥
            </Button>
          </div>
        </>
      }
    >
      <form
        id={formId}
        className="settings-modal-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            const result = await api(
              'admin/api-keys',
              json('POST', {
                name: title,
                permissions,
                grants,
                expires: expiry ? new Date(expiry).getTime() : null,
                rateLimit: rate,
              }),
            );
            await done(result.key);
          }, '');
        }}
      >
        <section className="modal-form-group">
          <h3>基本信息</h3>
          <Field label="密钥名称">
            <input required value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </section>
        <section className="modal-form-group">
          <h3>操作权限</h3>
          <div className="modal-permission-presets">
            <span>常用组合</span>
            <button type="button" className="text-link" onClick={() => setPermissions(['read'])}>
              只读
            </button>
            <button type="button" className="text-link" onClick={() => setPermissions(['upload'])}>
              上传
            </button>
            <button
              type="button"
              className="text-link"
              onClick={() => setPermissions(['read', 'private:read', 'upload'])}
            >
              完整读写
            </button>
          </div>
          {[
            {
              title: '读取',
              items: [
                ['read', '图片读取'],
                ['private:read', '私有图片读取'],
              ],
            },
            { title: '写入', items: [['upload', '图片上传']] },
            {
              title: '服务',
              items: [
                ['random', '随机图服务调用'],
                ['ai:classify', 'AI 图片分类'],
              ],
            },
          ].map((group) => (
            <fieldset className="perm-group" key={group.title}>
              <legend>{group.title}</legend>
              {group.items.map(([permission, label]) => (
                <div key={permission}>
                  <Check
                    label={label!}
                    checked={permissions.includes(permission!)}
                    disabled={permission === 'read' && permissions.includes('private:read')}
                    aria-describedby={
                      permission === 'read' && permissions.includes('private:read')
                        ? `${formId}-read-hint`
                        : undefined
                    }
                    onChange={(e) => togglePermission(permission!, e.target.checked)}
                  />
                  {permission === 'read' && permissions.includes('private:read') && (
                    <p id={`${formId}-read-hint`} className="modal-field-hint">
                      随私有读取自动启用
                    </p>
                  )}
                </div>
              ))}
            </fieldset>
          ))}
        </section>
        <section className="modal-form-group">
          <div className="rules-heading">
            <h3>资源范围</h3>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setGrants([...grants, { kind: 'folder', resourceId: '', descendants: false }])
              }
            >
              <Plus size={15} />
              添加范围
            </Button>
          </div>
          {grants.some((grant) => grant.kind === 'all') && (
            <div className="modal-note warn" role="status">
              该密钥已授权全部资源。建议至少指定一个文件夹、随机图服务或存储。
            </div>
          )}
          <div className="modal-note">
            <p>可同时指定随机服务、来源文件夹与存储，避免授予不必要的全站权限。</p>
          </div>
          {grants.map((g, index) => (
            <fieldset className="modal-range" key={index}>
              <legend>范围 {index + 1}</legend>
              <Field label="授权类型">
                <select
                  value={g.kind}
                  onChange={(e) =>
                    patch(index, { kind: e.target.value, resourceId: '', descendants: false })
                  }
                >
                  <option value="folder">指定文件夹</option>
                  <option value="service">指定随机图服务</option>
                  <option value="storage">指定存储</option>
                  <option value="all">全部资源（谨慎授予）</option>
                </select>
              </Field>
              {g.kind !== 'all' && (
                <Field label="目标资源">
                  <select
                    required
                    value={g.resourceId}
                    onChange={(e) => patch(index, { resourceId: e.target.value })}
                  >
                    <option value="">请选择</option>
                    {(g.kind === 'folder'
                      ? folders
                      : g.kind === 'service'
                        ? services
                        : storages
                    ).map((v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {g.kind === 'folder' && (
                <Check
                  label="授权包含子文件夹"
                  checked={g.descendants}
                  onChange={(e) => patch(index, { descendants: e.target.checked })}
                />
              )}
              {grants.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setGrants(grants.filter((_, i) => i !== index))}
                >
                  移除此范围
                </Button>
              )}
            </fieldset>
          ))}
        </section>
        <section className="modal-form-group">
          <h3>有效期与限流</h3>
          <Field label="到期时间（可选）" hint="留空表示永不过期">
            <input
              type="datetime-local"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </Field>
          {expiry && (
            <p className="modal-field-hint" role="status">
              {new Date(expiry).getTime() <= Date.now()
                ? '已过期'
                : `还剩 ${Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000)} 天`}
            </p>
          )}
          <Field label="每分钟请求上限" hint="0 表示不限制；随机图服务自身的调用上限独立生效。">
            <input
              type="number"
              min="0"
              max="10000"
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
            />
          </Field>
        </section>
        <ActionFeedback action={action} />
      </form>
    </Modal>
  );
}
function SiteSettings() {
  const settings = useData('admin/settings'),
    [draft, setDraft] = useState<any>({}),
    [galleryOpen, setGalleryOpen] = useState(false),
    [logoGalleryOpen, setLogoGalleryOpen] = useState(false),
    [previewError, setPreviewError] = useState(false),
    [logoError, setLogoError] = useState(false),
    [saved, setSaved] = useState(false),
    action = useAction();
  useEffect(() => {
    if (settings.data)
      setDraft({ ...settings.data, origins: settings.data.allowedOrigins.join('\n') });
  }, [settings.data]);
  useEffect(() => setPreviewError(false), [draft.homeBackgroundUrl]);
  useEffect(() => setLogoError(false), [draft.logoUrl]);
  if (settings.loading) return <Busy />;
  if (settings.error) return <QueryFeedback query={settings} />;
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>站点设置</h2>
          <p className="muted">管理站点品牌、首页背景与跨域访问策略。</p>
        </div>
        <Button form="site-settings" type="submit" disabled={action.pending}>
          保存站点设置
        </Button>
      </div>
      <QueryFeedback query={settings} />
      <form
        id="site-settings"
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              'admin/settings',
              json('PUT', {
                title: draft.title,
                description: draft.description,
                logoUrl: (draft.logoUrl ?? '').trim(),
                homeBackgroundUrl: (draft.homeBackgroundUrl ?? '').trim(),
                originWhitelistEnabled: !!draft.originWhitelistEnabled,
                allowedOrigins: draft.origins
                  .split('\n')
                  .map((x: string) => x.trim())
                  .filter(Boolean),
              }),
            );
            window.dispatchEvent(new Event('site-settings'));
            setSaved(true);
          }, '已保存，刷新页面后生效');
        }}
      >
        <section className="panel">
          <Field
            label="站点图标"
            hint="显示在页头、页脚与首页，建议使用 1:1 的正方形图片；留空使用内置图标。"
          >
            <input
              type="url"
              maxLength={2048}
              placeholder="https://example.com/logo.png"
              value={draft.logoUrl ?? ''}
              onChange={(e) => setDraft({ ...draft, logoUrl: e.target.value })}
            />
          </Field>
          <div className="settings-logo">
            {draft.logoUrl?.trim() && !logoError ? (
              <img
                src={draft.logoUrl.trim()}
                alt="站点图标预览"
                onError={() => setLogoError(true)}
              />
            ) : (
              <div className="settings-logo-placeholder">内置</div>
            )}
            <Button type="button" variant="secondary" onClick={() => setLogoGalleryOpen(true)}>
              从图库选择
            </Button>
          </div>
          <Field label="站点名称">
            <input
              required
              value={draft.title ?? ''}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </Field>
          <Field label="站点描述" hint="显示在首页标题下，支持换行；留空则不显示。">
            <textarea
              maxLength={500}
              value={draft.description ?? ''}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <Field label="首页背景图片" hint="填写 HTTP(S) 图片地址，留空使用默认底色。">
            <input
              type="url"
              maxLength={2048}
              placeholder="https://example.com/background.jpg"
              value={draft.homeBackgroundUrl ?? ''}
              onChange={(e) => setDraft({ ...draft, homeBackgroundUrl: e.target.value })}
            />
          </Field>
          <div className="settings-background">
            {draft.homeBackgroundUrl?.trim() && !previewError ? (
              <img
                src={draft.homeBackgroundUrl.trim()}
                alt="首页背景预览"
                onError={() => setPreviewError(true)}
              />
            ) : (
              <div className="settings-background-placeholder">使用默认底色</div>
            )}
            <Button type="button" variant="secondary" onClick={() => setGalleryOpen(true)}>
              从图库选择
            </Button>
          </div>
          <section className="settings-group">
            <div className="settings-group-heading">
              <h3>跨域与访问控制</h3>
              <span className="badge">API</span>
            </div>
            <Check
              label="启用跨域来源白名单"
              checked={!!draft.originWhitelistEnabled}
              onChange={(e) => setDraft({ ...draft, originWhitelistEnabled: e.target.checked })}
            />
            <p className="muted">
              {draft.originWhitelistEnabled
                ? '仅允许本站、PUBLIC_URL 和下方白名单来源。列表为空时仅允许本站与 PUBLIC_URL。'
                : '默认允许任意 HTTP(S) 来源跨域访问。接口仍需相应授权，跨域管理员 Cookie 不开放。'}
            </p>
            <Field
              label="允许跨域的来源"
              hint="每行一个完整来源，例如 https://example.com，不含路径和末尾斜杠。仅在开启白名单后生效，关闭时保留已填写内容。"
            >
              <textarea
                disabled={!draft.originWhitelistEnabled}
                value={draft.origins ?? ''}
                onChange={(e) => setDraft({ ...draft, origins: e.target.value })}
              />
            </Field>
          </section>
        </section>
        <div className="settings-actions">
          <ActionFeedback action={action} />
          {saved && (
            <button
              type="button"
              className="settings-text-button"
              onClick={() => window.location.reload()}
            >
              刷新查看
            </button>
          )}
          <div className="settings-action-buttons">
            <Button type="submit" disabled={action.pending}>
              {action.pending ? '正在提交…' : '保存站点设置'}
            </Button>
          </div>
        </div>
      </form>
      <Modal
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        title="从图库选择"
        description="从公开图库选择首页背景。可按名称、标签或文件夹查找。"
      >
        {galleryOpen && (
          <SiteImagePicker
            onSelect={(url) => {
              setDraft({ ...draft, homeBackgroundUrl: url });
              setGalleryOpen(false);
            }}
          />
        )}
      </Modal>
      <Modal
        open={logoGalleryOpen}
        onOpenChange={setLogoGalleryOpen}
        title="选择站点图标"
        description="从公开图库选择站点图标，建议使用 1:1 的正方形图片。"
      >
        {logoGalleryOpen && (
          <SiteImagePicker
            onSelect={(url) => {
              setDraft({ ...draft, logoUrl: url });
              setLogoGalleryOpen(false);
            }}
          />
        )}
      </Modal>
    </>
  );
}
const SITE_IMAGE_PAGE_SIZE = 40;
type PickerImage = Pick<
  ImageInfo,
  'id' | 'name' | 'logicalUrl' | 'thumbnailUrl' | 'thumbnailUrlExpiresAt' | 'logicalThumbnailUrl'
>;

function SiteImagePicker({ onSelect }: { onSelect: (url: string) => void }) {
  const [search, setSearch] = useState('');
  const [criteria, setCriteria] = useState({ search: '', folderId: '', page: 1 });
  const results = useRef<HTMLDivElement>(null);
  const folders = useData<{ items: { id: string; name: string }[] }>('public/folders');
  const params = new URLSearchParams({
    page: String(criteria.page),
    limit: String(SITE_IMAGE_PAGE_SIZE),
    sort: 'newest',
  });
  if (criteria.search) params.set('search', criteria.search);
  if (criteria.folderId) params.set('folderId', criteria.folderId);
  const images = useData<{ items: PickerImage[]; total: number }>(`public/images?${params}`);
  const lastPage = Math.max(1, Math.ceil((images.data?.total ?? 0) / SITE_IMAGE_PAGE_SIZE));
  const outOfRange = !!images.data && criteria.page > lastPage;
  const filtered = !!(criteria.search || criteria.folderId);
  useEffect(() => {
    const term = search.trim();
    const timer = setTimeout(() => {
      setCriteria((current) =>
        current.search === term ? current : { ...current, search: term, page: 1 },
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (outOfRange) {
      setCriteria((current) => (current === criteria ? { ...current, page: lastPage } : current));
    }
  }, [criteria, lastPage, outOfRange]);

  return (
    <div className="settings-gallery">
      <div className="settings-gallery-filters">
        <Field label="搜索图片名称或标签">
          <input
            type="search"
            maxLength={120}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
        <Field label="筛选文件夹">
          <select
            value={criteria.folderId}
            disabled={!folders.data}
            onChange={(event) =>
              setCriteria({ search: search.trim(), folderId: event.target.value, page: 1 })
            }
          >
            <option value="">所有公开文件夹</option>
            {folders.data?.items.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {(folders.error || folders.refreshError || folders.refreshing) && (
        <div role="group" aria-label="公开文件夹">
          <QueryFeedback query={folders} />
        </div>
      )}
      <div ref={results} tabIndex={-1} role="region" aria-label="选图结果">
        {images.loading || outOfRange ? (
          <Busy />
        ) : images.error ? (
          <QueryFeedback query={images} />
        ) : images.data?.items.length ? (
          <>
            <p className="muted settings-gallery-count" role="status">
              共 {images.data.total} 张图片
            </p>
            <div className="settings-gallery-grid">
              {images.data.items.map((image) => (
                <SiteImageChoice key={image.id} image={image} onSelect={onSelect} />
              ))}
            </div>
            <Pagination
              total={images.data.total}
              page={criteria.page}
              pageSize={SITE_IMAGE_PAGE_SIZE}
              onChange={(page) => {
                setCriteria((current) => ({ ...current, page }));
                results.current?.focus({ preventScroll: true });
                results.current?.scrollIntoView({ block: 'start' });
              }}
            />
          </>
        ) : (
          <div className="empty" role="status">
            <ImageIcon size={28} />
            <p>{filtered ? '没有符合条件的公开图片' : '图库中还没有公开图片'}</p>
          </div>
        )}
      </div>
    </div>
  );
}
function SiteImageChoice({
  image,
  onSelect,
}: {
  image: PickerImage;
  onSelect: (url: string) => void;
}) {
  const preview = useImageSource(image, true);
  return (
    <button
      type="button"
      className="settings-gallery-choice"
      aria-label={`选择图片：${image.name}`}
      title={image.name}
      onClick={() =>
        onSelect(new URL(image.logicalUrl || `/i/${image.id}`, window.location.origin).href)
      }
    >
      {preview.failed ? (
        <ImageIcon size={24} />
      ) : (
        <img src={preview.source} onError={preview.onError} alt="" loading="lazy" />
      )}
      <span>{image.name}</span>
    </button>
  );
}

function SecuritySettings() {
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    notice = useNotice(),
    action = useAction();
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>管理员安全</h2>
          <p className="muted">修改密码会注销所有管理员会话，并使对应的私有签名链接失效。</p>
        </div>
        <Button form="security-settings" type="submit" disabled={action.pending}>
          修改密码
        </Button>
      </div>
      <form
        id="security-settings"
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirmation) {
            notice('两次输入的新密码不一致', true);
            return;
          }
          void action.run(async () => {
            await api('admin/password', json('PUT', { currentPassword: current, password }));
            location.href = '/login';
          }, '密码已修改，请重新登录');
        }}
      >
        <section className="panel">
          <Field label="当前密码">
            <input
              type="password"
              required
              value={current}
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="新密码" hint="至少 12 个字符。">
            <input
              type="password"
              required
              minLength={12}
              maxLength={256}
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="确认新密码">
            <input
              type="password"
              required
              minLength={12}
              maxLength={256}
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
        </section>
        <div className="settings-actions">
          <ActionFeedback action={action} />
          <div className="settings-action-buttons">
            <Button type="submit" disabled={action.pending}>
              {action.pending ? '正在提交…' : '修改密码并重新登录'}
            </Button>
          </div>
        </div>
      </form>
    </>
  );
}
