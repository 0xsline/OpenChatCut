import type { ProjectDoc, TimelineState } from '../editor/types';
import type { ExportJobStore } from './backgroundExportStore';
import { ExportDialogMain } from './ExportDialogMain';
import { ExportDialogShell, ExportSidebar } from './ExportDialogShell';
import { useExportDialogModel } from './useExportDialogModel';
import type { ExportTab } from './useExportWorkflow';

interface ExportDialogProps {
  state: TimelineState;
  project: ProjectDoc;
  projectId: string;
  projectName: string;
  exportJobs: ExportJobStore;
  onClose: () => void;
}

export function ExportDialog({ state, project, projectId, projectName, exportJobs, onClose }: ExportDialogProps) {
  const model = useExportDialogModel({ state, project, projectId, projectName, exportJobs, onClose });
  const selectTab = (tab: ExportTab) => {
    model.setTab(tab);
    model.workflow.resetFeedback();
  };
  return (
    <ExportDialogShell base={model.base} state={state} onClose={onClose}>
      <ExportSidebar tab={model.tab} busy={!!model.workflow.busy} onTabChange={selectTab} />
      <ExportDialogMain state={state} model={model} />
    </ExportDialogShell>
  );
}
