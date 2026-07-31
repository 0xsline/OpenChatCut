import type { ReactNode } from 'react';
import { useT } from '../i18n/locale';
import { Icon, type IconName } from '../components/icons';
import type { ExportQaIssue } from './quality';
import type { ExportQaUiState } from './useExportWorkflow';

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cc-export-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

export function InfoCard({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="cc-export-info">
      <span><Icon name={icon} size={19} /></span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

const QA_ISSUE_LABELS: Record<string, string> = {
  missing_video: '成片缺少视频轨',
  duration_mismatch: '成片时长与时间线不一致',
  resolution_mismatch: '成片分辨率与导出设置不一致',
  fps_mismatch: '成片帧率与导出设置不一致',
  missing_audio: '成片缺少应有的音频轨',
  black_frames: '检测到异常黑帧',
  frozen_frames: '检测到较长静帧',
  long_silence: '检测到较长静音',
  audio_peak: '音频峰值接近削波',
  caption_safe_area_horizontal: '字幕越出横向安全区',
  caption_safe_area_vertical: '字幕越出纵向安全区',
};

function qaIssueLabel(issue: ExportQaIssue, translate: ReturnType<typeof useT>): string {
  const label = translate(QA_ISSUE_LABELS[issue.code] ?? issue.message);
  if (issue.startSeconds === undefined) return label;
  const end = issue.endSeconds ?? issue.startSeconds;
  return `${label} · ${issue.startSeconds.toFixed(2)}–${end.toFixed(2)}s`;
}

export function ExportQaCard({ qa }: { qa: ExportQaUiState }) {
  const t = useT();
  if (qa.status === 'running') {
    return <div className="cc-export-qa-card running"><strong>{t('正在自动检查成片…')}</strong></div>;
  }
  if (qa.status === 'error') {
    return (
      <div className="cc-export-qa-card error">
        <strong>{t('自动质量检查未完成')}</strong>
        <p>{t('成片仍会正常下载；你可以稍后重新导出复检。')} {qa.message}</p>
      </div>
    );
  }
  const report = qa.report!;
  return (
    <div className={`cc-export-qa-card ${qa.status}`}>
      <div className="cc-export-qa-summary">
        <strong>{qa.status === 'passed' ? t('自动质量检查通过') : t('自动质量检查发现问题')}</strong>
        <span>{t('{errors} 个错误 · {warnings} 个警告', {
          errors: report.summary.errors,
          warnings: report.summary.warnings,
        })}</span>
      </div>
      {qa.attempts > 1 && <p>{t('第 {n} 轮检查完成', { n: qa.attempts })}</p>}
      {report.issues.length > 0 && (
        <ul>
          {report.issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.startSeconds ?? index}`} className={issue.severity}>
              {qaIssueLabel(issue, t)}
            </li>
          ))}
        </ul>
      )}
      {qa.evidenceUrl && (
        <details>
          <summary>{t('查看剪辑点前后对照图')}</summary>
          <img src={qa.evidenceUrl} alt={t('剪辑点前后画面对照')} />
        </details>
      )}
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useT();
  return (
    <div className="cc-export-segmented">
      {options.map((option) => (
        <button
          type="button"
          key={String(option.value)}
          className={`cc-export-seg${option.value === value ? ' active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}
