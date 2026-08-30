// The import thunks for the editor's overlays, plus the idle warm-up built on
// them. Kept out of workspaceDialogs.tsx so that file exports components and
// nothing else — Fast Refresh gives up on a module that mixes the two.
import { useIdlePrefetch } from '../ui/idlePrefetch';

export const loadExportDialog = () => import('../export/ExportDialog');
export const loadSettingsDialog = () => import('../components/settings/SettingsDialog');
export const loadDesignStylePanel = () => import('../components/settings/DesignStylePanel');
export const loadVersionHistory = () => import('../components/VersionHistory');
export const loadShortcutsDialog = () => import('../shortcuts/ShortcutsDialog');

const LOADERS = [
  loadExportDialog, loadSettingsDialog, loadDesignStylePanel, loadVersionHistory, loadShortcutsDialog,
];

/** Fetch the overlay chunks once the editor is idle, so opening one is instant. */
export function useWorkspaceDialogPrefetch(): void {
  useIdlePrefetch(LOADERS);
}
