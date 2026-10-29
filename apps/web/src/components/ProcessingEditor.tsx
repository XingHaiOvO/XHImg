import { Field, Check } from './ui';
export const processingDefaults = {
  enabled: false,
  compress: true,
  targetFormat: 'keep',
  quality: 80,
  maxWidth: null as number | null,
  maxHeight: null as number | null,
  preserveOriginal: true,
};
export function ProcessingEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: any;
  onChange: (value: any) => void;
  disabled?: boolean;
}) {
  const policy = { ...processingDefaults, ...value },
    set = (key: string, next: any) => onChange({ ...policy, [key]: next });
  return (
    <div className="processing-editor">
      <Check
        label="启用图片处理"
        disabled={disabled}
        checked={policy.enabled}
        onChange={(e) => set('enabled', e.target.checked)}
      />
      <fieldset disabled={disabled || !policy.enabled}>
        <legend>处理策略</legend>
        <div className="form-grid">
          <Field label="输出格式">
            <select
              value={policy.targetFormat}
              onChange={(e) => set('targetFormat', e.target.value)}
            >
              <option value="keep">保持原格式</option>
              <option value="jpg">JPG</option>
              <option value="png">PNG</option>
              <option value="webp">WebP</option>
            </select>
          </Field>
          <Field
            label="质量"
            hint={
              policy.targetFormat === 'png'
                ? 'PNG 使用无损压缩，不进行降色。'
                : '用于 JPG / WebP 有损压缩。'
            }
          >
            <input
              type="number"
              min="1"
              max="100"
              disabled={!policy.compress || policy.targetFormat === 'png'}
              value={policy.quality}
              onChange={(e) => set('quality', Number(e.target.value))}
            />
          </Field>
          <Field label="最大宽度（像素）">
            <input
              type="number"
              min="1"
              max="40000"
              placeholder="不限制，不放大"
              value={policy.maxWidth ?? ''}
              onChange={(e) => set('maxWidth', e.target.value ? Number(e.target.value) : null)}
            />
          </Field>
          <Field label="最大高度（像素）">
            <input
              type="number"
              min="1"
              max="40000"
              placeholder="不限制，不放大"
              value={policy.maxHeight ?? ''}
              onChange={(e) => set('maxHeight', e.target.value ? Number(e.target.value) : null)}
            />
          </Field>
        </div>
        <Check
          label="启用压缩"
          checked={policy.compress}
          onChange={(e) => set('compress', e.target.checked)}
        />
        <Check
          label="保留原始文件（仅管理员可下载）"
          checked={policy.preserveOriginal}
          onChange={(e) => set('preserveOriginal', e.target.checked)}
        />
        <p className="muted">
          处理时纠正方向、转为 sRGB 并去除元数据。透明图片转 JPG 使用白色背景。
        </p>
      </fieldset>
    </div>
  );
}
