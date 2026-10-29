import { useState, useEffect } from 'react';
import { api, json, useData, useAction } from './api';
import { Field, Check, Button, Busy } from './components/ui';
import { ProcessingEditor, processingDefaults } from './components/ProcessingEditor';

export function ProcessingSettings() {
  const config = useData('admin/processing'),
    [policy, setPolicy] = useState<any>(processingDefaults),
    [limit, setLimit] = useState(100),
    action = useAction();
  useEffect(() => {
    if (config.data) {
      setPolicy(config.data.policy);
      setLimit(config.data.maxUploadMB);
    }
  }, [config.data]);
  if (config.loading) return <Busy />;
  if (config.error) return <p role="alert">{config.error}</p>;
  return (
    <section className="panel narrow-panel">
      <h2>图片处理</h2>
      <p className="muted">
        策略只影响后续上传。已有图片可在编辑中重新处理，成功前继续提供当前版本。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(() =>
            api('admin/processing', json('PUT', { policy, maxUploadMB: limit })),
          );
        }}
      >
        <Field label="单张图片上限（MB）" hint="1–100MB，最大4000万像素，不接受动画。">
          <input
            type="number"
            min="1"
            max="100"
            required
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </Field>
        <ProcessingEditor value={policy} onChange={setPolicy} />
        <Button disabled={action.pending}>保存处理策略</Button>
      </form>
    </section>
  );
}
export function AISettings() {
  const config = useData('admin/ai'),
    folders = useData('admin/folders'),
    [draft, setDraft] = useState<any>({}),
    [key, setKey] = useState(''),
    [replaceKey, setReplaceKey] = useState(false),
    action = useAction();
  useEffect(() => {
    if (config.data) setDraft(config.data);
  }, [config.data]);
  if (config.loading || folders.loading) return <Busy />;
  if (config.error || folders.error) return <p role="alert">{config.error || folders.error}</p>;
  const set = (field: string, value: any) => setDraft({ ...draft, [field]: value });
  const save = async () => {
    const { hasKey, ...body } = draft;
    if (replaceKey || key) body.apiKey = key;
    await api('admin/ai', json('PUT', body));
    setKey('');
    setReplaceKey(false);
    await config.reload();
  };
  return (
    <section className="panel narrow-panel">
      <h2>AI 视觉模型</h2>
      <p className="muted">
        发送去除元数据、最长边1024px的预览图至配置的模型。AI
        只选择已允许的文件夹，不修改图片公开性。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void action.run(save);
        }}
      >
        <Check
          label="启用 AI 自动分类"
          checked={!!draft.enabled}
          onChange={(e) => set('enabled', e.target.checked)}
        />
        <Field
          label="API Base URL"
          hint="填写兼容接口的基础地址，例如 https://example.com/v1，不包含 /chat/completions。"
        >
          <input
            type="url"
            value={draft.baseUrl ?? ''}
            onChange={(e) => set('baseUrl', e.target.value)}
            placeholder="https://example.com/v1"
          />
        </Field>
        <Field label="模型名称">
          <input
            value={draft.model ?? ''}
            onChange={(e) => set('model', e.target.value)}
            placeholder="支持视觉输入的模型名"
          />
        </Field>
        <Field
          label="模型 API Key"
          hint={draft.hasKey ? '已保存密钥；留空保持原值。' : '仅在服务商要求时填写；加密保存。'}
        >
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </Field>
        {draft.hasKey && (
          <Check
            label="清除现有密钥（本地无鉴权服务）"
            checked={replaceKey}
            onChange={(e) => setReplaceKey(e.target.checked)}
          />
        )}
        <div className="form-grid">
          <Field label="超时（秒）">
            <input
              type="number"
              min="1"
              max="120"
              value={draft.timeoutSeconds ?? 60}
              onChange={(e) => set('timeoutSeconds', Number(e.target.value))}
            />
          </Field>
          <Field label="额外重试次数">
            <input
              type="number"
              min="0"
              max="2"
              value={draft.retries ?? 2}
              onChange={(e) => set('retries', Number(e.target.value))}
            />
          </Field>
        </div>
        <Check
          label="模型支持 response_format JSON 模式"
          checked={!!draft.jsonMode}
          onChange={(e) => set('jsonMode', e.target.checked)}
        />
        <Field label="分类提示词">
          <textarea
            value={draft.prompt ?? ''}
            onChange={(e) => set('prompt', e.target.value)}
            maxLength={8000}
          />
        </Field>
        <Field label="自定义分类规则">
          <textarea
            value={draft.rules ?? ''}
            onChange={(e) => set('rules', e.target.value)}
            maxLength={8000}
          />
        </Field>
        <fieldset>
          <legend>允许参与分类的文件夹</legend>
          <p className="muted">
            与文件夹设置中的“参与 AI 自动分类”同步。API 调用还受密钥上传范围限制。
          </p>
          {folders.data?.items
            .filter((f: any) => !f.system)
            .map((folder: any) => (
              <Check
                key={folder.id}
                label={`${folder.name}（${folder.effective_visibility === 'public' ? '公开' : '私有'}）`}
                checked={draft.folderIds?.includes(folder.id) ?? false}
                onChange={(e) =>
                  set(
                    'folderIds',
                    e.target.checked
                      ? [...(draft.folderIds ?? []), folder.id]
                      : (draft.folderIds ?? []).filter((id: string) => id !== folder.id),
                  )
                }
              />
            ))}
        </fieldset>
        <div className="button-row">
          <Button disabled={action.pending}>保存模型配置</Button>
          <Button
            type="button"
            variant="secondary"
            disabled={action.pending}
            onClick={() =>
              void action.run(async () => {
                await save();
                await api('admin/ai/test', json('POST'));
              }, '视觉输入和分类输出测试通过')
            }
          >
            保存并测试模型
          </Button>
        </div>
        <p className="muted">
          测试使用内置蓝色测试图，不发送图库文件。配置模型会产生服务商请求费用时，请按需使用。
        </p>
      </form>
    </section>
  );
}
