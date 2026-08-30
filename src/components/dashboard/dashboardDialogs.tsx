// The project list's five dialogs are each rendered only while their flag in
// `model.dialogs` is set. Importing them statically put settings (provider
// catalogs, vendor icons), the MCP guide, media cleanup and storage migration
// into the entry chunk, so every cold start paid for screens most sessions
// never open. They load on demand and warm on idle instead — the same
// treatment the editor's overlays get in src/editor/workspaceDialogs.tsx.
import { lazy } from 'react';
import { useIdlePrefetch } from '../../ui/idlePrefetch';

const loadSettingsDialog = () => import('../settings/SettingsDialog');
const loadShortcutsDialog = () => import('../../shortcuts/ShortcutsDialog');
const loadMcpGuideDialog = () => import('../settings/McpGuide');
const loadMediaCleanupDialog = () => import('../../media/MediaCleanupDialog');
const loadStorageMigrationDialog = () => import('../settings/StorageMigrationDialog');

export const SettingsDialog = lazy(() => loadSettingsDialog().then((m) => ({ default: m.SettingsDialog })));
export const ShortcutsDialog = lazy(() => loadShortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })));
export const McpGuideDialog = lazy(() => loadMcpGuideDialog().then((m) => ({ default: m.McpGuideDialog })));
export const MediaCleanupDialog = lazy(() => loadMediaCleanupDialog().then((m) => ({ default: m.MediaCleanupDialog })));
export const StorageMigrationDialog = lazy(() => loadStorageMigrationDialog()
  .then((m) => ({ default: m.StorageMigrationDialog })));

const LOADERS = [
  loadSettingsDialog, loadShortcutsDialog, loadMcpGuideDialog,
  loadMediaCleanupDialog, loadStorageMigrationDialog,
];

/** Fetch the dialog chunks once the project list is idle, so opening one is instant. */
export function useDashboardDialogPrefetch(): void {
  useIdlePrefetch(LOADERS);
}
