import type { TimelineState } from '../editor/types';
import { useT } from '../i18n/locale';
import { ExportFooter } from './ExportDialogFooter';
import { ExportTabContent } from './ExportDialogTabs';
import { EXPORT_TABS, type ExportDialogModel } from './useExportDialogModel';
import type { ExportTab, RenderEngine } from './useExportWorkflow';

function RenderBadge({ tab, renderEngine }: { tab: ExportTab; renderEngine: RenderEngine }) {
  const t = useT();
  const label = tab !== 'video' ? t('本机渲染')
    : renderEngine === 'server' ? t('兼容渲染')
      : renderEngine === 'browser' ? t('浏览器加速')
        : renderEngine === 'checking' ? t('检测浏览器') : t('浏览器优先');
  return <span className="cc-export-local-badge"><i />{label}</span>;
}

function ExportMainHeader({ tab, renderEngine }: { tab: ExportTab; renderEngine: RenderEngine }) {
  const t = useT();
  const activeTab = EXPORT_TABS.find((entry) => entry.key === tab) ?? EXPORT_TABS[0];
  return (
    <div className="cc-export-main-header">
      <div><h3>{t(activeTab.label)}</h3><p>{activeTab.summary}</p></div>
      <RenderBadge tab={tab} renderEngine={renderEngine} />
    </div>
  );
}

export function ExportDialogMain({ state, model }: { state: TimelineState; model: ExportDialogModel }) {
  const { workflow } = model;
  return (
    <main className="cc-export-main">
      <ExportMainHeader tab={model.tab} renderEngine={workflow.renderEngine} />
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
      <ExportFooter tab={model.tab} outputName={model.outputName} videoSummary={model.videoSummary}
        disabled={model.disabled} workflow={workflow} />
    </main>
  );
}
