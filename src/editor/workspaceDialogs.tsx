// The editor's five overlays — export, settings, design style, version history
// and shortcuts — are each rendered only while their props object is non-null,
// i.e. only after the user opens them. Importing them statically put their whole
// dependency closure (the export pipeline, the provider catalogs and vendor
// icons, the design-style transfer code) into the chunk that has to arrive
// before a project can be shown at all.
//
// They load on demand instead, and are warmed on idle so the first click still
// opens instantly — the fetch happens while the user is reading their timeline,
// not while they are waiting for it.
import { lazy } from 'react';
import { useIdlePrefetch } from '../ui/idlePrefetch';

const loadExportDialog = () => import('../export/ExportDialog');
const loadSettingsDialog = () => import('../components/settings/SettingsDialog');
const loadDesignStylePanel = () => import('../components/settings/DesignStylePanel');
const loadVersionHistory = () => import('../components/VersionHistory');
const loadShortcutsDialog = () => import('../shortcuts/ShortcutsDialog');

export const ExportDialog = lazy(() => loadExportDialog().then((m) => ({ default: m.ExportDialog })));
export const SettingsDialog = lazy(() => loadSettingsDialog().then((m) => ({ default: m.SettingsDialog })));
export const DesignStylePanel = lazy(() => loadDesignStylePanel().then((m) => ({ default: m.DesignStylePanel })));
export const VersionHistory = lazy(() => loadVersionHistory().then((m) => ({ default: m.VersionHistory })));
export const ShortcutsDialog = lazy(() => loadShortcutsDialog().then((m) => ({ default: m.ShortcutsDialog })));

const LOADERS = [
  loadExportDialog, loadSettingsDialog, loadDesignStylePanel, loadVersionHistory, loadShortcutsDialog,
];

/** Fetch the overlay chunks once the editor is idle, so opening one is instant. */
export function useWorkspaceDialogPrefetch(): void {
  useIdlePrefetch(LOADERS);
}
