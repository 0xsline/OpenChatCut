// The project list's five dialogs are each rendered only while their flag in
// `model.dialogs` is set. Importing them statically put settings (provider
// catalogs, vendor icons), the MCP guide, media cleanup and storage migration
// into the entry chunk, so every cold start paid for screens most sessions
// never open. They load on demand and warm on idle through
// useDashboardDialogPrefetch (dashboardDialogLoaders.ts) instead — the same
// treatment the editor's overlays get in src/editor/workspaceDialogs.tsx.
import { lazy } from 'react';
import {
  loadMcpGuideDialog, loadMediaCleanupDialog, loadSettingsDialog,
  loadShortcutsDialog, loadStorageMigrationDialog,
} from './dashboardDialogLoaders';

export const SettingsDialog = lazy(() => loadSettingsDialog().then((m) => ({ default: m.SettingsDialog })));
export const ShortcutsDialog = lazy(() => loadShortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })));
export const McpGuideDialog = lazy(() => loadMcpGuideDialog().then((m) => ({ default: m.McpGuideDialog })));
export const MediaCleanupDialog = lazy(() => loadMediaCleanupDialog().then((m) => ({ default: m.MediaCleanupDialog })));
export const StorageMigrationDialog = lazy(() => loadStorageMigrationDialog()
  .then((m) => ({ default: m.StorageMigrationDialog })));
