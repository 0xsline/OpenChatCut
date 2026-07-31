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
          onToggle={workflow.toggleAutoQa} nleFormat={model.nleFormat}
          setNleFormat={model.setNleFormat} includeMg={model.includeMg}
          setIncludeMg={model.setIncludeMg} mgCount={model.mgItems.length}
        />
        {workflow.error && <p className="cc-export-error">{workflow.error}</p>}
      </div>
      <ExportDestinationBar busy={!!workflow.busy} choosing={workflow.choosingDestination}
        destination={workflow.destination} onChoose={workflow.chooseDestination} />
      <ExportFooter tab={model.tab} outputName={model.outputName} videoSummary={model.videoSummary}
        disabled={model.disabled} workflow={workflow} />
    </main>
  );
}
