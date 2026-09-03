// The import thunks for the project list's dialogs, plus the idle warm-up built
// on them. Kept out of dashboardDialogs.tsx so that file exports components and
// nothing else — Fast Refresh gives up on a module that mixes the two.
import { useIdlePrefetch } from '../../ui/idlePrefetch';
import { loadMcpGuideDialog } from '../settings/mcpGuideLoader';

export const loadSettingsDialog = () => import('../settings/SettingsDialog');
export const loadShortcutsDialog = () => import('../../shortcuts/ShortcutsDialog');
export { loadMcpGuideDialog };
export const loadMediaCleanupDialog = () => import('../../media/MediaCleanupDialog');
export const loadStorageMigrationDialog = () => import('../settings/StorageMigrationDialog');

const LOADERS = [
  loadSettingsDialog, loadShortcutsDialog, loadMcpGuideDialog,
  loadMediaCleanupDialog, loadStorageMigrationDialog,
];

/** Fetch the dialog chunks once the project list is idle, so opening one is instant. */
export function useDashboardDialogPrefetch(): void {
  useIdlePrefetch(LOADERS);
}
