import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { ExportDestinationBar } from './ExportDestinationBar';
import { ExportFooter } from './ExportDialogFooter';
import { ExportTabContent } from './ExportDialogTabs';
import { EXPORT_TABS, type ExportDialogModel } from './useExportDialogModel';
import type { ExportTab, RenderEngine } from './useExportWorkflow';
import type { ExportEngineInfo } from './exportWorkflowTypes';

function RenderBadge({ tab, renderEngine, engine, reason }: {
  tab: ExportTab;
  renderEngine: RenderEngine;
  engine: ExportEngineInfo | null;
  reason: string | null;
}) {
  const t = useT();
  const label = tab !== 'video' ? t('本机渲染')
    : engine ? t(engine.label)
      : renderEngine === 'checking' ? t('正在检测本机') : t('本机自适应');
  const accelerated = tab !== 'video' || engine?.hardware;
  return <span className={`cc-export-local-badge${accelerated ? ' accelerated' : ''}`} title={reason ? t(reason) : undefined}><i />{label}</span>;
}

function ExportMainHeader({ model }: { model: ExportDialogModel }) {
  const t = useT();
  const activeTab = EXPORT_TABS.find((entry) => entry.key === model.tab) ?? EXPORT_TABS[0];
  return (
    <div className="cc-export-main-header">
      <div><h3>{t(activeTab.label)}</h3><p>{activeTab.summary}</p></div>
      <RenderBadge tab={model.tab} renderEngine={model.workflow.renderEngine}
        engine={model.workflow.engineInfo} reason={model.workflow.engineReason} />
    </div>
  );
}

function BackgroundExportJobs({ model }: { model: ExportDialogModel }) {
  const t = useT();
  const { jobs, selectedJobId, viewJob, cancelJob } = model.workflow;
  if (jobs.length === 0) return null;
  return (
    <section className="cc-export-progress" aria-label={t('后台导出任务')}>
      <div className="cc-export-progress-head">
        <strong>{t('后台导出')}</strong>
        <span>{jobs.length}</span>
      </div>
      {jobs.map((job) => {
        const terminal = job.progress.phase === 'completed'
          || job.progress.phase === 'failed'
          || job.progress.phase === 'cancelled';
        return (
          <div className="cc-export-progress-meta" key={job.id}>
            <button type="button" onClick={() => viewJob(job.id)}
              aria-pressed={selectedJobId === job.id}>
              {job.label} · {job.progress.phase} · {job.progress.percent}%
            </button>
            {!terminal && (
              <button type="button" onClick={() => cancelJob(job.id)}>{t('取消')}</button>
            )}
          </div>
        );
      })}
    </section>
  );
}

function StructuredExportFailure({ model }: { model: ExportDialogModel }) {
  const failure = model.workflow.failure;
  if (!failure) return model.workflow.error
    ? <p className="cc-export-error">{model.workflow.error}</p>
    : null;
  return (
    <div className="cc-export-error" role="alert">
      <strong>{failure.message}</strong>
      <div>{failure.stage} · {failure.code} · {failure.retryable ? 'retryable' : 'not retryable'}</div>
      <div>cleanup: {failure.cleanupStatus}</div>
      {failure.targetPath && <div>{failure.targetPath}</div>}
      {failure.mediaIssues?.length ? (
        <ul>
          {failure.mediaIssues.map((issue, index) => (
            <li key={`${issue.code}-${issue.itemId ?? issue.source ?? index}`}>
              {issue.itemId ? `${issue.itemId}: ` : ''}{issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ExportDialogMain({ state, model }: { state: TimelineState; model: ExportDialogModel }) {
  const { workflow } = model;
  return (
    <main className="cc-export-main">
      <ExportMainHeader model={model} />
      <div className="cc-export-content" role="tabpanel" id={`cc-export-content-${model.tab}`}
        aria-labelledby={`cc-export-tab-${model.tab}`}>
        <ExportTabContent
          tab={model.tab} state={state} video={model.video} subtitles={model.subtitles}
          busy={!!workflow.busy} enabled={workflow.autoQaEnabled} qa={workflow.qa}
          qualityMode={model.qualityMode} setQualityMode={model.setQualityMode}
          onToggle={workflow.toggleAutoQa} nleFormat={model.nleFormat}
          setNleFormat={model.setNleFormat} includeMg={model.includeMg}
          setIncludeMg={model.setIncludeMg} mgCount={model.mgItems.length}
        />
        <StructuredExportFailure model={model} />
      </div>
      <BackgroundExportJobs model={model} />
      <ExportDestinationBar busy={!!workflow.busy} choosing={workflow.choosingDestination}
        destination={workflow.destination} onChoose={workflow.chooseDestination} />
      <ExportFooter tab={model.tab} outputName={model.outputName} videoSummary={model.videoSummary}
        disabled={model.disabled} workflow={workflow} />
    </main>
  );
}
