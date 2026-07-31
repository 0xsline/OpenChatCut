import type { TimelineState } from '../editor/types';
import { ExportDialogMain } from './ExportDialogMain';
import { ExportDialogShell, ExportSidebar } from './ExportDialogShell';
import { useExportDialogModel } from './useExportDialogModel';
import type { ExportTab } from './useExportWorkflow';

interface ExportDialogProps {
  state: TimelineState;
  projectName: string;
  onClose: () => void;
}

export function ExportDialog({ state, projectName, onClose }: ExportDialogProps) {
  const model = useExportDialogModel({ state, projectName, onClose });
  const selectTab = (tab: ExportTab) => {
    model.setTab(tab);
    model.workflow.resetFeedback();
  };
  return (
    <ExportDialogShell base={model.base} state={state} busy={!!model.workflow.busy} onClose={onClose}>
      <ExportSidebar tab={model.tab} busy={!!model.workflow.busy} onTabChange={selectTab} />
      <ExportDialogMain state={state} model={model} />
    </ExportDialogShell>
  );
}
