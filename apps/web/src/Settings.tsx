import { useUrlTab } from './navigation';
import { useState, useEffect, lazy, Suspense } from 'react';
import { Plus, HardDrive, Cloud, KeyRound, ShieldCheck, Copy } from 'lucide-react';
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
} from './components/ui';
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
      <PageHeading title="设置中心" description="基础设施，安静地为你的图片服务。" />
      <div className="tabs settings-tabs" aria-label="设置分类">
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
      </div>
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
    </>
  );
}
function StorageSettings() {
  const { data, error, loading, reload, refreshError, refreshing } =
      useData('admin/storage-backends'),
    [edit, setEdit] = useState<any>(),
    action = useAction();
  return (
    <>
      <div className="section-heading">
        <div>
          <h2>每一张图片，都有可靠的归处。</h2>
          <p className="muted">停用只阻止新上传，已有图片仍可读取。</p>
        </div>
        <Button
          onClick={() =>
            setEdit({
              name: '',
              type: 's3',
              enabled: 1,
              is_default: 0,
              config: { endpoint: '', region: 'auto', bucket: '', forcePathStyle: true },
            })
          }
        >
          <Plus size={16} />
          添加存储
        </Button>
      </div>
      <QueryFeedback query={{ error: refreshError, refreshing, reload }} />
      {loading ? (
        <Busy />
      ) : error ? (
        <QueryFeedback query={{ error, reload }} />
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
              <h3>{s.name}</h3>
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
                <Button variant="secondary" onClick={() => setEdit(s)}>
                  配置
                </Button>
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
              <small className="muted">{s.id}</small>
            </section>
          ))}
        </div>
      )}
      <StorageEditor value={edit} close={() => setEdit(undefined)} reload={reload} />
      <section className="panel maintenance-note">
        <h3>备份与恢复</h3>
        <p>
          备份应包含数据库一致性副本、本地图片、部署配置及 MASTER_KEY。S3
          对象需另行备份。升级前先备份，恢复时先停止写入。
        </p>
        <p className="muted">具体命令见随源码交付的 README 和 docs/operations.md。</p>
      </section>
    </>
  );
}
function StorageEditor({ value, close, reload }: any) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<any>({}),
    [credentials, setCredentials] = useState({ accessKeyId: '', secretAccessKey: '' }),
    action = useAction();
  useEffect(() => {
    if (value) {
      setDraft({ ...value, enabled: !!value.enabled, isDefault: !!value.is_default });
      setCredentials({ accessKeyId: '', secretAccessKey: '' });
    }
  }, [value]);
  const config = (key: string, v: any) =>
    setDraft({ ...draft, config: { ...draft.config, [key]: v } });
  return (
    <Modal
      busy={action.pending}
      open={!!value}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={value?.id ? '存储配置' : '添加存储'}
      description="S3 Bucket 保持私有。鉴权后返回最长有效 5 分钟的临时直链。"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
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
            close();
            if (draft.type === 's3' && body.config) location.reload();
          });
        }}
      >
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
        {draft.type === 's3' && (
          <>
            <p className="muted">
              {value?.id
                ? '修改连接参数时，必须同时重新输入两项凭证；已有图片的连接不可更换。'
                : '支持 S3、R2、MinIO 等 S3 兼容服务。'}
            </p>
            <p className="muted">
              Endpoint 必须可被图片访问者访问；HTTPS 站点请使用 HTTPS Endpoint。保存新的 S3
              连接后会重新加载页面以应用图片来源策略。
            </p>
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
            <Field label="Secret Key" hint="凭证加密保存，读取配置时不会返回。">
              <input
                type="password"
                required={!value?.id}
                autoComplete="new-password"
                value={credentials.secretAccessKey}
                onChange={(e) =>
                  setCredentials({ ...credentials, secretAccessKey: e.target.value })
                }
              />
            </Field>
            <Check
              label="使用 Path Style"
              checked={!!draft.config?.forcePathStyle}
              onChange={(e) => config('forcePathStyle', e.target.checked)}
            />
          </>
        )}
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
        <div className="button-row">
          <Button disabled={action.pending}>{action.pending ? '正在提交…' : '保存存储'}</Button>
          {value?.id && !value.is_default && (
            <Button
              type="button"
              variant="destructive"
              disabled={action.pending}
              onClick={async () => {
                if (await confirm(`删除存储配置“${value.name}”？仍被引用时会阻止删除。`))
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
          <h2>把权限，交给正确的调用方。</h2>
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
      ) : (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称与前缀</th>
                <th>操作权限与范围</th>
                <th>状态</th>
                <th>最近使用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {keys.data?.items.map((k: any) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                    <small>{k.prefix}…</small>
                  </td>
                  <td>
                    <div className="tags">
                      {k.permissions.map((p: string) => (
                        <span key={p}>{p}</span>
                      ))}
                    </div>
                    <small>
                      {k.grants
                        .map((g: any) =>
                          g.kind === 'all'
                            ? '全部资源'
                            : `${g.kind}: ${g.resource_id}${g.descendants ? '（含子目录）' : ''}`,
                        )
                        .join('；')}
                    </small>
                  </td>
                  <td>
                    {k.revoked ? '已撤销' : k.expires && k.expires < Date.now() ? '已过期' : '有效'}
                    {k.expires && <small>{new Date(k.expires).toLocaleString('zh-CN')} 到期</small>}
                  </td>
                  <td>
                    {k.last_used ? new Date(k.last_used).toLocaleString('zh-CN') : '尚未使用'}
                  </td>
                  <td>
                    <Button
                      variant="destructive"
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
                      撤销
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {keys.data?.items.length === 0 && (
            <div className="empty">
              <KeyRound size={28} />
              <p>为你的第一个应用创建密钥。</p>
            </div>
          )}
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
  const patch = (index: number, value: any) =>
    setGrants(grants.map((g, i) => (i === index ? { ...g, ...value } : g)));
  return (
    <Modal
      busy={action.pending}
      open={open}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title="创建 API Key"
      description="操作权限和资源范围需同时满足。私有读取需要 read 与 private:read。"
    >
      <form
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
        <Field label="密钥名称">
          <input required value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <fieldset>
          <legend>操作权限</legend>
          {[
            ['read', '图片读取'],
            ['upload', '图片上传'],
            ['private:read', '私有图片读取'],
            ['random', '随机图服务调用'],
            ['ai:classify', 'AI 图片分类'],
          ].map(([key, label]) => (
            <Check
              key={key}
              label={label!}
              checked={permissions.includes(key!)}
              onChange={(e) =>
                setPermissions(
                  e.target.checked ? [...permissions, key!] : permissions.filter((p) => p !== key),
                )
              }
            />
          ))}
        </fieldset>
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
        <p className="muted">可同时指定随机服务、来源文件夹与存储，避免授予不必要的全站权限。</p>
        {grants.map((g, index) => (
          <fieldset key={index}>
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
                  {(g.kind === 'folder' ? folders : g.kind === 'service' ? services : storages).map(
                    (v: any) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ),
                  )}
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
        <Field label="到期时间（可选）">
          <input type="datetime-local" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        </Field>
        <Field label="每分钟请求上限" hint="0 表示不限制；随机图服务自身的调用上限独立生效。">
          <input
            type="number"
            min="0"
            max="10000"
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </Field>
        <Button disabled={action.pending || !permissions.length}>创建并显示密钥</Button>
        <ActionFeedback action={action} />
      </form>
    </Modal>
  );
}
function SiteSettings() {
  const settings = useData('admin/settings'),
    [draft, setDraft] = useState<any>({}),
    action = useAction();
  useEffect(() => {
    if (settings.data)
      setDraft({ ...settings.data, origins: settings.data.allowedOrigins.join('\n') });
  }, [settings.data]);
  if (settings.loading) return <Busy />;
  if (settings.error) return <QueryFeedback query={settings} />;
  return (
    <section className="panel narrow-panel">
      <h2>站点设置</h2>
      <QueryFeedback query={settings} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              'admin/settings',
              json('PUT', {
                title: draft.title,
                description: draft.description,
                allowedOrigins: draft.origins
                  .split('\n')
                  .map((x: string) => x.trim())
                  .filter(Boolean),
              }),
            );
            window.dispatchEvent(new Event('site-settings'));
          });
        }}
      >
        <Field label="站点名称">
          <input
            required
            value={draft.title ?? ''}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </Field>
        <Field label="站点描述">
          <textarea
            value={draft.description ?? ''}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </Field>
        <Field
          label="允许跨域的来源"
          hint="每行一个完整来源，例如 https://example.com，不含路径和末尾斜杠。不会允许跨域管理员 Cookie。"
        >
          <textarea
            value={draft.origins ?? ''}
            onChange={(e) => setDraft({ ...draft, origins: e.target.value })}
          />
        </Field>
        <Button disabled={action.pending}>{action.pending ? '正在提交…' : '保存站点设置'}</Button>
        <ActionFeedback action={action} />
      </form>
    </section>
  );
}
function SecuritySettings() {
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    action = useAction();
  return (
    <section className="panel narrow-panel">
      <ShieldCheck size={28} />
      <h2>管理员安全</h2>
      <p className="muted">修改密码会注销所有管理员会话，并使对应的私有签名链接失效。</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api('admin/password', json('PUT', { currentPassword: current, password }));
            location.href = '/login';
          }, '密码已修改，请重新登录');
        }}
      >
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
        <Button disabled={action.pending}>
          {action.pending ? '正在提交…' : '修改密码并重新登录'}
        </Button>
        <ActionFeedback action={action} />
      </form>
    </section>
  );
}
