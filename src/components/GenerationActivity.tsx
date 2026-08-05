import { useCallback, useEffect, useMemo, useState } from 'react';
import { isTerminal, normalizeStatus } from '../agent/progress/job-model';
import { useT } from '../i18n/locale';
import {
  listTrackedJobs,
  subscribeTrackedJobs,
  type TrackedJob,
} from '../persist/jobRegistryStore';
import { theme } from '../theme';
import { Icon } from './icons';
import { TopBarIconButton } from './TopBarIconButton';

interface GenerationActivityProps {
  projectId: string;
  onResume?: () => Promise<void>;
}

type Translate = ReturnType<typeof useT>;

function operationSummary(job: TrackedJob, t: Translate): string {
  const args = job.submitArgs;
  if (!args) return job.params ? t('旧版参数摘要（不可安全重跑）') : t('参数快照不可用');
  const fields = ['provider', 'model', 'mode', 'durationSeconds', 'resolution', 'ratio']
    .flatMap((key) => args[key] === undefined ? [] : [`${key}=${String(args[key])}`]);
  if (typeof args.prompt === 'string' && args.prompt.trim()) {
    const prompt = args.prompt.trim();
    fields.push(prompt.length > 100 ? `${prompt.slice(0, 97)}…` : prompt);
  }
  return fields.join(' · ') || job.toolName || t('生成任务');
}
function isResumable(job: TrackedJob): boolean {
  return !isTerminal(job.status)
    || job.retryClass === 'download-retryable'
    || job.retryClass === 'provider-retryable'
    || job.retryClass === 'restart-recoverable';
}


function relativeTime(timestamp: number, t: Translate): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return t('刚刚');
  if (minutes < 60) return t('{n} 分钟前', { n: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? t('{n} 小时前', { n: hours })
    : t('{n} 天前', { n: Math.floor(hours / 24) });
}

function statusLabel(status: string, t: Translate): string {
  return {
    pending: t('等待中'),
    running: t('进行中'),
    complete: t('已完成'),
    failed: t('失败'),
    not_found: t('未找到'),
  }[normalizeStatus(status)];
}

function retryClassLabel(retryClass: TrackedJob['retryClass'], t: Translate): string | null {
  if (!retryClass || retryClass === 'none') return null;
  return {
    'download-retryable': t('可重试下载'),
    'provider-retryable': t('可重试生成'),
    'restart-recoverable': t('重启后可恢复'),
    'provider-terminal': t('不可重试'),
    'legacy-unknown': t('旧任务状态未知'),
  }[retryClass];
}

export function GenerationActivity({ projectId, onResume }: GenerationActivityProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setJobs(await listTrackedJobs(projectId));
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    void refresh();
    return subscribeTrackedJobs(projectId, () => { void refresh(); });
  }, [projectId, refresh]);

  const activeCount = useMemo(() => jobs.filter(isResumable).length, [jobs]);
  const resume = async () => {
    if (!onResume || resuming) return;
    setResuming(true);
    try {
      await onResume();
      await refresh();
    } finally {
      setResuming(false);
    }
  };

  return (
    <>
      <TopBarIconButton
        icon="sparkles"
        label={t('生成任务')}
        onClick={() => setOpen(true)}
        badge={activeCount > 0 ? (
          <span style={{ position: 'absolute', right: 1, top: 1, minWidth: 13, height: 13, padding: '0 3px', borderRadius: 7, background: theme.accent, color: theme.onAccent, fontSize: 9, lineHeight: '13px', fontWeight: 700 }}>
            {activeCount}
          </span>
        ) : null}
      />
      {open && (
        <div role="presentation" onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.28)' }}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={t('生成任务')}
            onClick={(event) => event.stopPropagation()}
            style={{ position: 'absolute', top: 42, right: 72, width: 'min(460px, calc(100vw - 24px))', maxHeight: 'min(620px, calc(100vh - 64px))', overflow: 'auto', padding: 14, border: `0.5px solid ${theme.border}`, borderRadius: 8, background: theme.panel, boxShadow: '0 18px 48px rgba(0,0,0,0.34)' }}
          >
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div>
                <div style={{ color: theme.text, fontSize: 13, fontWeight: 650 }}>{t('生成任务')}</div>
                <div style={{ color: theme.textDim, fontSize: 11, marginTop: 2 }}>{t('刷新后仍可继续检查、下载或重跑')}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {onResume && activeCount > 0 && (
                  <button type="button" disabled={resuming} onClick={() => { void resume(); }} style={ghostButton}>
                    {resuming ? t('恢复中…') : t('继续任务')}
                  </button>
                )}
                <button type="button" aria-label={t('关闭')} onClick={() => setOpen(false)} style={iconButton}><Icon name="x" size={16} /></button>
              </div>
            </header>
            {loading && !jobs.length ? (
              <div style={emptyState}>{t('正在读取任务…')}</div>
            ) : !jobs.length ? (
              <div style={emptyState}>{t('暂无生成任务')}</div>
            ) : jobs.map((job) => {
              const retryLabel = retryClassLabel(job.retryClass, t);
              return <article key={job.operationId} style={{ padding: '10px 0', borderTop: `0.5px solid ${theme.border}` }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
                  <strong style={{ color: theme.text, fontSize: 12.5, fontWeight: 600 }}>{job.label || job.toolName || t('生成任务')}</strong>
                  <span style={{ color: isTerminal(job.status) ? theme.textDim : theme.accent, fontSize: 11 }}>{statusLabel(job.status, t)}</span>
                </div>
                <div style={{ color: theme.textDim, fontSize: 11.5, lineHeight: 1.5, marginTop: 4, overflowWrap: 'anywhere' }}>{operationSummary(job, t)}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 10px', color: theme.textDim, fontSize: 10.5, marginTop: 6 }}>
                  <code title={job.operationId} style={{ fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>{job.operationId}</code>
                  <span>{relativeTime(job.updatedAt, t)}</span>
                  {job.providerTaskId && <span>{t('Provider 任务')} {job.providerTaskId}</span>}
                  {retryLabel && <span>{retryLabel}</span>}
                </div>
                {job.error && <div style={{ color: theme.danger, fontSize: 11, lineHeight: 1.45, marginTop: 6 }}>{job.error}</div>}
                {job.resultPath && (
                  <a href={job.resultPath} target="_blank" rel="noreferrer" style={{ color: theme.accent, display: 'inline-block', fontSize: 11.5, marginTop: 6 }}>
                    {t('打开结果')}
                  </a>
                )}
                {onResume && isResumable(job) && (
                  <button type="button" disabled={resuming} onClick={() => { void resume(); }} style={{ ...ghostButton, marginTop: 7 }}>
                    {job.status === 'failed' ? t('重试可恢复任务') : t('检查进度')}
                  </button>
                )}
              </article>;
            })}
          </section>
        </div>
      )}
    </>
  );
}

const emptyState: React.CSSProperties = { padding: '28px 0', textAlign: 'center', color: theme.textDim, fontSize: 12 };
const iconButton: React.CSSProperties = { border: 'none', background: 'none', color: theme.textDim, cursor: 'pointer', lineHeight: 0, padding: 4 };
const ghostButton: React.CSSProperties = { border: `0.5px solid ${theme.border}`, borderRadius: 5, background: theme.panelAlt, color: theme.text, cursor: 'pointer', padding: '4px 9px', fontSize: 11.5 };
