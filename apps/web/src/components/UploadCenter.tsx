import { useState, useRef, useEffect, useId } from 'react';
import { Upload as TusUpload } from 'tus-js-client';
import { Upload, Pause, Play, X } from 'lucide-react';
import { api, json, useData, useNotice, csrfToken, bytes } from '../api';
import { Field, Button, Check } from './ui';
import { ProcessingEditor, processingDefaults } from './ProcessingEditor';
import {
  hashBlob,
  checkedHttpStack,
  resumeRecords,
  saveResume,
  removeResume,
  type ResumeRecord,
} from '../resume';

type Entry = {
  id: string;
  name: string;
  progress: number;
  status: string;
  state: string;
  file?: File;
  task?: TusUpload;
  record?: ResumeRecord;
  imageId?: string;
  error?: string;
  controller?: AbortController;
};
const labels: Record<string, string> = {
  created: '等待上传',
  uploading: '上传中',
  validating: '校验文件中',
  processing: '图片处理中',
  classifying: 'AI 分类中',
  ready: '上传成功',
  failed: '处理失败',
  expired: '已过期',
  canceled: '已取消',
};
export function UploadCenter({
  folders,
  panel = false,
  current = '',
  onComplete = () => {},
  onBusy = () => {},
}: {
  folders: any[];
  panel?: boolean;
  current?: string;
  onComplete?: () => void | Promise<void>;
  onBusy?: (busy: boolean) => void;
}) {
  const destinationId = useId();
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [editingDestination, setEditingDestination] = useState(false);
  const [folder, setFolder] = useState(current),
    [visibility, setVisibility] = useState('private'),
    [inherit, setInherit] = useState(true),
    [policy, setPolicy] = useState<any>(processingDefaults),
    [classify, setClassify] = useState('auto'),
    [entries, setEntries] = useState<Entry[]>([]),
    [saved, setSaved] = useState<ResumeRecord[]>([]);
  const config = useData('public/upload-config'),
    input = useRef<HTMLInputElement>(null),
    resumeInput = useRef<HTMLInputElement>(null),
    resumeTarget = useRef<ResumeRecord | null>(null),
    live = useRef(new Map<string, Entry>()),
    mounted = useRef(true),
    notice = useNotice();
  const update = (entry: Entry, patch: Partial<Entry>) => {
    if (!mounted.current || entry.state === 'canceled') return;
    Object.assign(entry, patch);
    if (mounted.current) setEntries([...live.current.values()]);
  };
  const loadSaved = () =>
    resumeRecords()
      .then((records) => {
        if (mounted.current) setSaved(records);
      })
      .catch(() => notice('浏览器未允许保存续传记录，保持页面打开仍可上传', true));
  useEffect(() => {
    mounted.current = true;
    void loadSaved();
    return () => {
      mounted.current = false;
      for (const entry of live.current.values()) {
        entry.controller?.abort();
        void entry.task?.abort().catch(() => {});
      }
    };
  }, []);
  useEffect(() => setFolder(current), [current]);
  const busy = entries.some((e) =>
    ['hashing', 'uploading', 'validating', 'processing', 'classifying', 'queued'].includes(e.state),
  );
  useEffect(() => onBusy(busy), [busy]);
  const watch = async (entry: Entry) => {
    if (!entry.record) return;
    const controller = (entry.controller ??= new AbortController());
    const uploadId = entry.record.url.split('/').pop();
    while (mounted.current && entry.state !== 'canceled') {
      try {
        const receipt = await api(`uploads/${uploadId}`, { signal: controller.signal });
        if (!mounted.current || controller.signal.aborted || entry.state === 'canceled') return;
        update(entry, {
          state: receipt.state,
          status: labels[receipt.state] ?? receipt.state,
          imageId: receipt.imageId,
          error: receipt.error,
        });
        if (['ready', 'failed', 'expired', 'canceled'].includes(receipt.state)) {
          if (receipt.state !== 'failed') {
            await removeResume(entry.record.url).catch(() => {});
            await loadSaved();
          }
          await onComplete();
          return;
        }
      } catch (e: any) {
        if (!mounted.current || controller.signal.aborted || entry.state === 'canceled') return;
        update(entry, { state: 'failed', status: e.message, error: e.message });
        return;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  const startTransfer = (entry: Entry, file: File, record: ResumeRecord) => {
    if (!mounted.current || entry.state === 'canceled' || entry.controller?.signal.aborted) return;
    const active = () => mounted.current && entry.state === 'uploading' && entry.task === task;
    const task = new TusUpload(file, {
      endpoint: '/api/v1/resumable',
      uploadUrl: record.url || null,
      metadata: { filename: record.name, sha256: record.hash, ...record.options },
      chunkSize: 4 * 1024 * 1024,
      parallelUploads: 1,
      retryDelays: [0, 1000, 3000, 5000],
      storeFingerprintForResuming: false,
      uploadDataDuringCreation: false,
      httpStack: checkedHttpStack(),
      onBeforeRequest: (request) => request.setHeader('X-CSRF-Token', csrfToken()),
      onProgress: (sent, total) => {
        if (active())
          update(entry, { progress: Math.max(entry.progress, Math.round((sent / total) * 100)) });
      },
      onUploadUrlAvailable: () => {
        if (task.url) {
          record.url = new URL(task.url, location.origin).pathname;
          entry.record = record;
          if (entry.state === 'canceled') {
            void api(`uploads/${record.url.split('/').pop()}`, json('DELETE'))
              .then(() => removeResume(record.url))
              .catch(() => {});
            return;
          }
          void saveResume(record)
            .then(() =>
              entry.state === 'canceled' ? removeResume(record.url).then(loadSaved) : loadSaved(),
            )
            .catch(() => notice('续传记录未保存，请保持页面打开', true));
        }
      },
      onError: (error) => {
        if (!active()) return;
        update(entry, { state: 'failed', status: error.message, error: error.message });
      },
      onSuccess: () => {
        if (!active()) return;
        update(entry, { state: 'validating', progress: 100, status: '校验文件中' });
        void watch(entry);
      },
    });
    entry.task = task;
    entry.file = file;
    entry.record = record;
    update(entry, { state: 'uploading', status: '上传中', error: undefined });
    task.start();
  };
  const add = async (files: File[], resume?: ResumeRecord) => {
    const options: Record<string, string> = { visibility };
    if (folder) options.folderId = folder;
    if (!inherit) options.processing = JSON.stringify(policy);
    if (classify !== 'auto') options.classify = classify;
    const batch = files.map((file) => {
      const entry: Entry = {
        id: `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        progress: 0,
        status: '等待上传',
        state: 'queued',
        file,
        controller: new AbortController(),
      };
      live.current.set(entry.id, entry);
      return entry;
    });
    setEntries([...live.current.values()]);
    let next = 0;
    await Promise.all(
      [0, 1].map(async () => {
        while (next < batch.length && mounted.current) {
          const entry = batch[next++]!,
            file = entry.file!;
          try {
            if (file.size > (config.data?.maxUploadMB ?? 100) * 1024 * 1024)
              throw new Error('文件超过当前上传上限');
            while (
              [...live.current.values()].filter((e) => ['hashing', 'uploading'].includes(e.state))
                .length >= 2 &&
              mounted.current &&
              entry.state !== 'canceled'
            )
              await new Promise((r) => setTimeout(r, 200));
            if (!mounted.current || entry.state === 'canceled') continue;
            update(entry, { state: 'hashing', status: resume ? '读取续传进度' : '校验文件指纹' });
            if (resume) {
              const receipt = await api(`uploads/${resume.url.split('/').pop()}`, {
                signal: entry.controller!.signal,
              });
              if (!mounted.current || entry.state === 'canceled') continue;
              update(entry, {
                progress:
                  receipt.length > 0 ? Math.round((receipt.offset / receipt.length) * 100) : 0,
              });
            }
            update(entry, { status: '校验文件指纹' });
            const hash = await hashBlob(
              file,
              (n) => update(entry, { status: `校验文件指纹（${n}%）` }),
              entry.controller!.signal,
            );
            if (!mounted.current || entry.state === 'canceled') continue;
            if (resume && (resume.hash !== hash || resume.size !== file.size))
              throw new Error('文件指纹不一致，请选择原来的文件');
            const record = resume ?? {
              url: '',
              hash,
              name: file.name,
              size: file.size,
              options,
              createdAt: Date.now(),
            };
            startTransfer(entry, file, record);
            while (entry.state === 'uploading' && mounted.current)
              await new Promise((r) => setTimeout(r, 200));
          } catch (e: any) {
            if (!mounted.current || entry.state === 'canceled') continue;
            update(entry, { state: 'failed', status: e.message, error: e.message });
          }
        }
      }),
    );
  };
  const cancel = async (entry: Entry) => {
    update(entry, { state: 'canceled', status: '已取消' });
    entry.controller?.abort();
    await entry.task?.abort().catch(() => {});
    if (entry.record?.url) {
      try {
        await api(`uploads/${entry.record.url.split('/').pop()}`, json('DELETE'));
        await removeResume(entry.record.url);
        await loadSaved();
      } catch (e: any) {
        notice(e.message, true);
      }
    }
  };
  return (
    <div className={panel ? 'upload-center panel' : 'upload-center'}>
      <button
        type="button"
        className={'dropzone' + (dragging ? ' dragging' : '')}
        onClick={() => input.current?.click()}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          void add(Array.from(e.dataTransfer.files));
        }}
      >
        <Upload size={28} />
        <strong>拖入图片，或点击选择</strong>
        <span>
          JPG、PNG、WebP、GIF · 每张最多 {config.data?.maxUploadMB ?? 100}MB · 支持暂停与续传
        </span>
      </button>
      <div className="upload-destination-summary">
        <span role="group" aria-label="目标文件夹">
          将上传到「{folders.find((item) => item.id === folder)?.name ?? '未分类'}」
        </span>
        <span aria-hidden="true">·</span>
        <span role="group" aria-label="图片自身权限">
          {visibility === 'public' ? '公开' : '私有'}
        </span>
        <Button
          type="button"
          className="text-link"
          variant="ghost"
          aria-expanded={editingDestination}
          aria-controls={destinationId}
          onClick={() => setEditingDestination(!editingDestination)}
        >
          {editingDestination ? '收起' : '修改'}
        </Button>
      </div>
      <div className="form-grid" id={destinationId} hidden={!editingDestination}>
        <Field label="目标文件夹">
          <select
            aria-label="目标文件夹"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="">未分类（可自动整理）</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="图片自身权限">
          <select
            aria-label="图片自身权限"
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
          >
            <option value="private">私有</option>
            <option value="public">公开（仍受父文件夹限制）</option>
          </select>
        </Field>
      </div>
      <details className="upload-policy">
        <summary>
          <span className="upload-policy-chevron" aria-hidden="true">
            ▸
          </span>
          <span>处理与分类选项</span>
          <small>
            {inherit
              ? '跟随文件夹 / 系统策略'
              : !policy.enabled
                ? '保持原图 · 不处理'
                : `${policy.targetFormat === 'keep' ? '保持原格式' : policy.targetFormat.toUpperCase()} · ${policy.compress && policy.targetFormat !== 'png' ? `质量 ${policy.quality}` : '无损处理'}`}
          </small>
        </summary>
        <Check
          label="使用文件夹 / 系统默认处理策略"
          checked={inherit}
          onChange={(e) => setInherit(e.target.checked)}
        />
        {!inherit && <ProcessingEditor value={policy} onChange={setPolicy} />}
        <p className="muted">GIF 原样保存，最多 500 帧，所有帧合计最多 4000 万像素。</p>
        <Field
          label="AI 分类"
          hint="指定文件夹默认不自动移动；明确启用后，可归入其他参与分类的文件夹。"
        >
          <select value={classify} onChange={(e) => setClassify(e.target.value)}>
            <option value="auto">跟随系统规则</option>
            <option value="true">启用 AI 自动归档</option>
            <option value="false">不执行 AI 分类</option>
          </select>
        </Field>
      </details>
      <input
        ref={input}
        className="sr-only"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/gif,.gif"
        aria-label="选择上传图片"
        onChange={(e) => {
          void add(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <input
        ref={resumeInput}
        className="sr-only"
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,.gif"
        aria-label="选择原文件继续上传"
        onChange={(e) => {
          const file = e.target.files?.[0],
            record = resumeTarget.current;
          if (file && record) void add([file], record);
          e.target.value = '';
        }}
      />

      <div className={'upload-queue' + (!entries.length ? ' is-empty' : '')} aria-live="polite">
        {!entries.length && (
          <p className="muted upload-queue-empty">暂无上传任务，选择图片后将在这里显示进度。</p>
        )}
        {entries.map((entry) => (
          <div key={entry.id}>
            <strong>{entry.name}</strong>
            <span>{entry.status}</span>
            <progress value={entry.progress} max="100" aria-label={`${entry.name} 上传进度`} />
            <div className="button-row">
              {entry.state === 'uploading' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    update(entry, { state: 'paused', status: '已暂停' });
                    void entry.task?.abort();
                  }}
                >
                  <Pause size={14} />
                  暂停
                </Button>
              )}
              {entry.state === 'paused' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    if (entry.file && entry.record) startTransfer(entry, entry.file, entry.record);
                  }}
                >
                  <Play size={14} />
                  继续
                </Button>
              )}
              {entry.state === 'failed' && entry.record && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    void api(`uploads/${entry.record!.url.split('/').pop()}`, {
                      signal: entry.controller?.signal,
                    })
                      .then((receipt) => {
                        if (!mounted.current || entry.state === 'canceled') return;
                        if (receipt.state === 'failed') {
                          return api(`uploads/${receipt.uploadId}/retry`, json('POST')).then(() => {
                            if (!mounted.current || entry.state === 'canceled') return;
                            update(entry, {
                              state: 'validating',
                              status: '正在重试',
                              error: undefined,
                            });
                            void watch(entry);
                          });
                        } else if (entry.file && entry.record)
                          startTransfer(entry, entry.file, entry.record);
                      })
                      .catch((e) => {
                        if (mounted.current && entry.state !== 'canceled') notice(e.message, true);
                      });
                  }}
                >
                  重试
                </Button>
              )}
              {!['ready', 'canceled'].includes(entry.state) && (
                <Button type="button" variant="ghost" onClick={() => void cancel(entry)}>
                  <X size={14} />
                  取消
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {saved.filter((record) => !entries.some((e) => e.record?.url === record.url)).length > 0 && (
        <section className="resume-list">
          <h3>可恢复的上传</h3>
          <p className="muted">刷新后需重新选择原文件；不会在浏览器中保存整张图片。</p>
          {saved
            .filter((record) => !entries.some((e) => e.record?.url === record.url))
            .map((record) => (
              <div key={record.url}>
                <div>
                  <strong>{record.name}</strong>
                  <small>{bytes(record.size)}</small>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={async () => {
                    try {
                      const receipt = await api(`uploads/${record.url.split('/').pop()}`);
                      if (['processing', 'classifying', 'validating'].includes(receipt.state)) {
                        const entry: Entry = {
                          id: record.url,
                          name: record.name,
                          progress: 100,
                          status: labels[receipt.state]!,
                          state: receipt.state,
                          record,
                        };
                        live.current.set(entry.id, entry);
                        setEntries([...live.current.values()]);
                        void watch(entry);
                      } else if (receipt.state === 'ready') {
                        await removeResume(record.url);
                        await loadSaved();
                        notice('该图片已上传成功');
                      } else if (receipt.state === 'failed') {
                        await api(`uploads/${receipt.uploadId}/retry`, json('POST'));
                        const entry: Entry = {
                          id: record.url,
                          name: record.name,
                          progress: 100,
                          status: '正在重试',
                          state: 'validating',
                          record,
                        };
                        live.current.set(entry.id, entry);
                        setEntries([...live.current.values()]);
                        void watch(entry);
                      } else if (['expired', 'canceled'].includes(receipt.state)) {
                        notice(receipt.error ?? '此上传不能继续，请重新上传', true);
                      } else {
                        resumeTarget.current = record;
                        resumeInput.current?.click();
                      }
                    } catch (e: any) {
                      notice(e.message, true);
                    }
                  }}
                >
                  恢复
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const receipt = await api(`uploads/${record.url.split('/').pop()}`);
                      if (receipt.state !== 'ready')
                        await api(`uploads/${record.url.split('/').pop()}`, json('DELETE'));
                      await removeResume(record.url);
                      await loadSaved();
                    } catch (e: any) {
                      notice(e.message, true);
                    }
                  }}
                >
                  移除
                </Button>
              </div>
            ))}
        </section>
      )}
    </div>
  );
}
