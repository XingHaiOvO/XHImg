import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, Shuffle, Copy, Play, Settings2, Globe, LockKeyhole, Trash2 } from 'lucide-react';
import { api, json, useData, useAction, useNotice, copy, absolute } from './api';
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
import { Preview } from './Public';
const empty = {
  kind: 'custom',
  folderId: null,
  name: '',
  slug: '',
  description: '',
  visibility: 'private',
  enabled: false,
  mode: 'image',
  mediaType: 'image',
  includeChildren: false,
  rateLimit: 60,
  rules: [],
};
export function Services() {
  const services = useData('admin/random-services'),
    folders = useData('admin/folders'),
    [searchParams] = useSearchParams(),
    [editing, setEditing] = useState<any>(),
    [preview, setPreview] = useState<any>(),
    action = useAction(),
    notice = useNotice();
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (searchParams.get('folder') && services.data && !attempted) {
      const existing = services.data.items.find(
        (s: any) => s.folder_id === searchParams.get('folder'),
      );
      setEditing(existing ?? { ...empty, kind: 'folder', folderId: searchParams.get('folder') });
      setAttempted(true);
    }
  }, [services.data, searchParams, attempted]);
  return (
    <>
      <PageHeading title="随机图服务" description="将整理好的图片，变成随处可调用的 API。">
        <Button onClick={() => setEditing({ ...empty })}>
          <Plus size={17} />
          创建服务
        </Button>
      </PageHeading>
      <QueryFeedback query={services} backgroundOnly />
      {services.loading ? (
        <Busy />
      ) : services.error ? (
        <QueryFeedback query={services} />
      ) : !services.data?.items.length ? (
        <section className="panel empty">
          <h2>还没有随机图服务</h2>
          <Button onClick={() => setEditing({ ...empty })}>
            <Plus size={17} />
            创建第一个服务
          </Button>
        </section>
      ) : (
        <div className="admin-services">
          {services.data?.items.map((s: any) => (
            <article className="panel admin-service" key={s.id}>
              <div className="service-top">
                <span className="service-symbol">
                  <Shuffle size={23} />
                </span>
                <div className="service-summary">
                  <div className="service-kind">
                    {s.kind === 'global'
                      ? '全站服务'
                      : s.kind === 'folder'
                        ? '文件夹服务'
                        : '自定义服务'}
                    {s.visibility === 'public' ? <Globe size={13} /> : <LockKeyhole size={13} />}
                  </div>
                  <h2 title={s.name}>{s.name}</h2>
                  {s.description && <p className="muted">{s.description}</p>}
                </div>
                <span className={'badge ' + (s.enabled ? 'good' : '')}>
                  {s.enabled ? '已启用' : '已停用'}
                </span>
              </div>
              <div className="endpoint">
                <code>{s.url}</code>
                <button
                  className="icon-button"
                  aria-label={`复制 ${s.name} 接口`}
                  onClick={() =>
                    void copy(absolute(s.url))
                      .then(() => notice('已复制'))
                      .catch(() => notice('复制失败', true))
                  }
                >
                  <Copy size={16} />
                </button>
              </div>
              <div className="service-controls">
                <div className="service-stats">
                  <span>
                    <strong>{s.calls}</strong>次调用
                  </span>
                  <span>
                    <strong>{s.successes}</strong>次成功
                  </span>
                  <span className={s.failures > 0 ? 'service-failures' : 'service-no-failures'}>
                    <strong>{s.failures}</strong>次失败
                  </span>
                </div>
                <div className="button-row">
                  <Button variant="secondary" onClick={() => setEditing(s)}>
                    <Settings2 size={16} />
                    配置
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!s.enabled || action.pending}
                    onClick={() =>
                      void action.run(async () => {
                        const img = await api(s.url + '?mode=json');
                        setPreview({ ...img, name: s.name });
                      }, '')
                    }
                  >
                    <Play size={15} />
                    预览
                  </Button>
                  <Button
                    variant="ghost"
                    className="service-toggle"
                    disabled={action.pending}
                    onClick={() =>
                      void action.run(
                        async () => {
                          await api(
                            `admin/random-services/${s.id}`,
                            json('PUT', normalize({ ...s, enabled: !s.enabled })),
                          );
                          await services.reload();
                        },
                        s.enabled ? '已停用' : '已启用',
                      )
                    }
                  >
                    {s.enabled ? '停用' : '启用'}
                  </Button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <ServiceEditor
        value={editing}
        close={() => setEditing(undefined)}
        folders={folders.data?.items ?? []}
        reload={services.reload}
      />
      <Preview image={preview} close={() => setPreview(undefined)} />
    </>
  );
}
function normalize(s: any) {
  return {
    kind: s.kind,
    folderId: s.folderId ?? s.folder_id ?? null,
    name: s.name,
    slug: s.slug ?? '',
    description: s.description ?? '',
    visibility: s.visibility,
    enabled: !!s.enabled,
    mode: s.mode,
    mediaType: s.mediaType ?? 'image',
    includeChildren: !!(s.includeChildren ?? s.include_children),
    rateLimit: s.rateLimit ?? s.rate_limit ?? 60,
    rules: (s.rules ?? []).map((r: any) => ({
      kind: r.kind,
      resourceId: r.resourceId ?? r.resource_id,
      descendants: !!r.descendants,
    })),
  };
}
function ServiceEditor({ value, close, folders, reload }: any) {
  const confirm = useConfirm();
  const closing = useRef(false);
  const [draft, setDraft] = useState<any>(empty),
    action = useAction();
  useEffect(() => {
    if (value) setDraft(normalize(value));
  }, [value]);
  const patch = (key: string, v: any) => setDraft({ ...draft, [key]: v });
  const dirty = !!value && JSON.stringify(draft) !== JSON.stringify(normalize(value));
  return (
    <Modal
      busy={action.pending}
      open={!!value}
      onOpenChange={async (v) => {
        if (v || closing.current) return;
        closing.current = true;
        try {
          if (!dirty || (await confirm('修改尚未保存，确认放弃？'))) close();
        } finally {
          closing.current = false;
        }
      }}
      title={value?.id ? '配置随机图服务' : '创建随机图服务'}
      description="设置服务来源、访问权限和筛选规则。"
    >
      <form
        className="service-editor"
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(async () => {
            await api(
              'admin/random-services' + (value.id ? `/${value.id}` : ''),
              json(value.id ? 'PUT' : 'POST', draft),
            );
            await reload();
            close();
          });
        }}
      >
        <div className="service-editor-fields">
          <h4 className="form-section">基本信息</h4>
          <Field label="服务名称">
            <input
              required
              value={draft.name}
              onChange={(e) => patch('name', e.target.value)}
              maxLength={120}
            />
          </Field>
          <Field
            label="接口 slug"
            hint="可选，最多 64 位字母、数字和中划线，首尾需为字母或数字；留空使用原地址。修改后旧 slug 地址将失效。"
          >
            <input
              value={draft.slug}
              onChange={(e) => patch('slug', e.target.value)}
              maxLength={64}
              placeholder="wallpaper"
            />
          </Field>
          <p className="muted">
            接口地址：
            <code>
              {draft.slug.trim()
                ? `/api/v1/random/${draft.slug.trim().toLowerCase()}`
                : draft.kind === 'global'
                  ? '/api/v1/random'
                  : draft.kind === 'folder'
                    ? `/api/v1/folders/${draft.folderId ?? '{folderId}'}/random`
                    : `/api/v1/random/${value?.id ?? '{serviceId}'}`}
            </code>
          </p>
          <Field label="描述">
            <textarea
              value={draft.description}
              onChange={(e) => patch('description', e.target.value)}
              maxLength={1000}
            />
          </Field>
          <h4 className="form-section">来源与权限</h4>
          <div className="form-grid">
            <Field label="服务类型">
              <select
                disabled={!!value?.id}
                value={draft.kind}
                onChange={(e) => {
                  setDraft({ ...draft, kind: e.target.value, folderId: null });
                }}
              >
                {value?.kind === 'global' && <option value="global">全站</option>}
                <option value="custom">自定义来源</option>
                <option value="folder">文件夹</option>
              </select>
            </Field>
            <Field label="访问策略">
              <select
                value={draft.visibility}
                onChange={(e) => patch('visibility', e.target.value)}
              >
                <option value="private">私有（授权调用）</option>
                <option value="public">公开（仅公开图片）</option>
              </select>
            </Field>
          </div>
          {draft.kind === 'folder' && (
            <>
              <Field label="来源文件夹">
                <select
                  required
                  value={draft.folderId ?? ''}
                  onChange={(e) => patch('folderId', e.target.value)}
                >
                  <option value="">选择文件夹</option>
                  {folders.map((f: any) => (
                    <option key={f.id} value={f.id}>
                      {f.name}（{f.effective_visibility === 'public' ? '公开' : '私有'}）
                    </option>
                  ))}
                </select>
              </Field>
              <Check
                label="包含子文件夹"
                checked={draft.includeChildren}
                onChange={(e) => patch('includeChildren', e.target.checked)}
              />
            </>
          )}
          <h4 className="form-section">行为</h4>
          <div className="form-grid">
            <Field label="媒体类型">
              <select
                value={draft.mediaType}
                onChange={(e) => {
                  const mediaType = e.target.value;
                  setDraft({
                    ...draft,
                    mediaType,
                    mode: mediaType === 'video' && draft.mode === 'image' ? 'redirect' : draft.mode,
                  });
                }}
              >
                <option value="image">仅图片</option>
                <option value="video">仅视频</option>
                <option value="mixed">图片与视频混合</option>
              </select>
            </Field>
            <Field
              label="默认响应"
              hint={
                draft.mediaType === 'mixed'
                  ? '图片二进制仅抽取图片。JSON 和 302 可抽取图片或视频。'
                  : undefined
              }
            >
              <select value={draft.mode} onChange={(e) => patch('mode', e.target.value)}>
                {draft.mediaType !== 'video' && <option value="image">图片二进制</option>}
                <option value="redirect">302 跳转</option>
                <option value="json">JSON</option>
              </select>
            </Field>
            <Field
              label="每分钟调用上限（每调用者）"
              hint="0 表示不限制；API Key 自身的请求上限独立生效。"
            >
              <input
                type="number"
                min="0"
                max="10000"
                value={draft.rateLimit}
                onChange={(e) => patch('rateLimit', Number(e.target.value))}
              />
            </Field>
          </div>
          <p className="service-auth-note muted">服务地址只定位资源，不能代替 API Key 授权。</p>
          <h4 className="form-section">筛选规则</h4>
          <div className="rules-heading">
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                patch('rules', [
                  ...draft.rules,
                  { kind: 'source_folder', resourceId: '', descendants: false },
                ])
              }
            >
              <Plus size={15} />
              添加规则
            </Button>
          </div>
          <p className="muted">
            多个来源取并集，排除和标签条件共同生效。不设置来源规则时使用服务默认来源。
          </p>
          {draft.rules.map((r: any, i: number) => (
            <div className="rule-row" key={i}>
              <select
                aria-label={`规则 ${i + 1} 类型`}
                value={r.kind}
                onChange={(e) =>
                  patch(
                    'rules',
                    draft.rules.map((v: any, j: number) =>
                      j === i ? { ...v, kind: e.target.value, resourceId: '' } : v,
                    ),
                  )
                }
              >
                <option value="source_folder">包含文件夹</option>
                <option value="exclude_folder">排除文件夹</option>
                <option value="exclude_image">排除图片</option>
                <option value="tag">包含标签</option>
              </select>
              {r.kind.endsWith('folder') ? (
                <select
                  aria-label={`规则 ${i + 1} 文件夹`}
                  required
                  value={r.resourceId}
                  onChange={(e) =>
                    patch(
                      'rules',
                      draft.rules.map((v: any, j: number) =>
                        j === i ? { ...v, resourceId: e.target.value } : v,
                      ),
                    )
                  }
                >
                  <option value="">选择文件夹</option>
                  {folders.map((f: any) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={r.kind === 'tag' ? '标签' : '排除的图片 ID'}
                  required
                  placeholder={r.kind === 'tag' ? '标签名称' : '图片 ID（在图片编辑中复制）'}
                  value={r.resourceId}
                  onChange={(e) =>
                    patch(
                      'rules',
                      draft.rules.map((v: any, j: number) =>
                        j === i ? { ...v, resourceId: e.target.value } : v,
                      ),
                    )
                  }
                />
              )}{' '}
              {r.kind.endsWith('folder') && (
                <Check
                  label="含子目录"
                  checked={r.descendants}
                  onChange={(e) =>
                    patch(
                      'rules',
                      draft.rules.map((v: any, j: number) =>
                        j === i ? { ...v, descendants: e.target.checked } : v,
                      ),
                    )
                  }
                />
              )}
              <button
                type="button"
                className="icon-button"
                aria-label={`删除规则 ${i + 1}`}
                onClick={() =>
                  patch(
                    'rules',
                    draft.rules.filter((_: any, j: number) => j !== i),
                  )
                }
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <Check
            label="启用此服务"
            checked={draft.enabled}
            onChange={(e) => patch('enabled', e.target.checked)}
          />
          <ActionFeedback action={action} />
        </div>
        <footer className="service-editor-footer">
          {value?.id && value.kind !== 'global' && (
            <Button
              type="button"
              variant="destructive"
              disabled={action.pending}
              onClick={async () => {
                if (await confirm(`删除服务“${value.name}”后原接口地址将失效，确认删除？`))
                  void action.run(async () => {
                    await api(`admin/random-services/${value.id}`, json('DELETE'));
                    await reload();
                    close();
                  });
              }}
            >
              删除服务
            </Button>
          )}
          <Button className="service-save" disabled={action.pending}>
            {action.pending ? '正在提交…' : '保存服务'}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
