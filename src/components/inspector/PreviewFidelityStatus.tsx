import { theme } from '../../theme';
import type { SelectedPreviewStatus } from '../../gl/previewAdapter';
import { useT } from '../../i18n/locale';

function fallbackReasonText(status: SelectedPreviewStatus): string {
  if (status.fallbackReason === 'webgl-unavailable') return 'WebGL2 不可用';
  if (status.fallbackReason === 'unsupported-media') return '素材类型不支持纹理预览';
  if (status.fallbackReason === 'missing-shader') return '着色器资源缺失';
  if (status.fallbackReason === 'shader-error') return '着色器编译或运行失败';
  if (status.fallbackReason === 'unsupported-transition') return '转场不支持 GL';
  return '资源尚未就绪';
}

export function PreviewFidelityStatus({ status }: { status?: SelectedPreviewStatus }) {
  const t = useT();
  if (!status || status.phase === 'inactive') return null;
  const fallback = status.phase === 'fallback';
  const label = status.phase === 'ready'
    ? t('真实 GL 预览 · 与导出共用参数')
    : status.phase === 'waiting'
      ? t('正在准备真实 GL 预览…')
      : status.adapter === 'css-transition'
        ? t('CSS 回退预览 · 不代表导出效果')
        : t('源画面回退 · 当前未显示特效');
  return (
    <div role="status" aria-live="polite" style={{
      display: 'flex', alignItems: 'center', gap: 6, minHeight: 24,
      padding: '4px 6px', border: `0.5px solid ${fallback ? theme.accent : theme.border}`,
      borderRadius: 4, color: fallback ? theme.text : theme.textMuted,
      background: theme.panelAlt, fontSize: 10.5, lineHeight: 1.35,
    }}>
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto', background: fallback ? theme.accent : status.phase === 'ready' ? theme.success : theme.textDim }} />
      <span>{label}{fallback ? ` · ${t(fallbackReasonText(status))}` : ''}</span>
    </div>
  );
}
