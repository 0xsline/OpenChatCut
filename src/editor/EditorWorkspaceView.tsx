import type { ComponentProps } from 'react';
import { theme } from '../theme';
import { ExportDialog } from '../export/ExportDialog';
import { TopBar } from '../components/TopBar';
import { ChatPanel } from '../components/chat/ChatPanel';
import { LibraryPanel } from '../library/LibraryPanel';
import { PreviewPanel } from '../components/PreviewPanel';
import { InspectorPanel } from '../components/InspectorPanel';
import { Timeline } from '../components/timeline/Timeline';
import { TimelineTabs } from '../components/timeline/TimelineTabs';
import { Divider } from '../components/Divider';
import { DesignStylePanel } from '../components/settings/DesignStylePanel';
import { VersionHistory } from '../components/VersionHistory';
import { SettingsDialog } from '../components/settings/SettingsDialog';
import { ShortcutsDialog } from '../shortcuts/ShortcutsDialog';
import { AppToastHost } from '../ui/AppToastHost';

export interface EditorWorkspaceViewProps {
  gridTemplateColumns: string;
  gridTemplateRows: string;
  topBar: ComponentProps<typeof TopBar>;
  exportDialog: ComponentProps<typeof ExportDialog> | null;
  designStylePanel: ComponentProps<typeof DesignStylePanel> | null;
  versionHistory: ComponentProps<typeof VersionHistory> | null;
  shortcutsDialog: ComponentProps<typeof ShortcutsDialog> | null;
  settingsDialog: ComponentProps<typeof SettingsDialog> | null;
  chatPanel: ComponentProps<typeof ChatPanel>;
  chatCollapsed: boolean;
  onResizeChat: ComponentProps<typeof Divider>['onResize'];
  libraryPanel: ComponentProps<typeof LibraryPanel>;
  onResizeLibrary: ComponentProps<typeof Divider>['onResize'];
  previewPanel: ComponentProps<typeof PreviewPanel>;
  inspectorPanel: ComponentProps<typeof InspectorPanel> | null;
  onResizeTimeline: ComponentProps<typeof Divider>['onResize'];
  timelineTabs: ComponentProps<typeof TimelineTabs>;
  timeline: ComponentProps<typeof Timeline>;
}


function renderLibrary(props: EditorWorkspaceViewProps) {
  return (
    <div style={{ gridColumn: 3, gridRow: 2, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <LibraryPanel {...props.libraryPanel} />
    </div>
  );
}

function renderPreview(props: EditorWorkspaceViewProps) {
  return (
    <div className="cc-preview-workspace" style={{ gridColumn: 5, gridRow: 2 }}>
      <PreviewPanel {...props.previewPanel} />
      {props.inspectorPanel && <InspectorPanel {...props.inspectorPanel} />}
    </div>
  );
}

function renderTimeline(props: EditorWorkspaceViewProps) {
  return (
    <div style={{ gridColumn: '3 / -1', gridRow: 4, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <TimelineTabs {...props.timelineTabs} />
      <Timeline {...props.timeline} />
    </div>
  );
}

export function EditorWorkspaceView(props: EditorWorkspaceViewProps) {
  return (
    <div
      className="cc-editor-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: props.gridTemplateColumns,
        gridTemplateRows: props.gridTemplateRows,
        height: '100vh',
        overflow: 'hidden',
        background: theme.bg,
        color: theme.text,
        fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
      }}
    >
      <TopBar {...props.topBar} />
      {props.exportDialog && <ExportDialog {...props.exportDialog} />}
      {props.settingsDialog && <SettingsDialog {...props.settingsDialog} />}
      {props.designStylePanel && <DesignStylePanel {...props.designStylePanel} />}
      {props.versionHistory && <VersionHistory {...props.versionHistory} />}
      {props.shortcutsDialog && <ShortcutsDialog {...props.shortcutsDialog} />}
      <ChatPanel {...props.chatPanel} />
      <div style={{ gridColumn: 2, gridRow: '2 / 5' }}>
        {!props.chatCollapsed && <Divider onResize={props.onResizeChat} />}
      </div>
      {renderLibrary(props)}
      <div style={{ gridColumn: 4, gridRow: 2 }}>
        <Divider onResize={props.onResizeLibrary} />
      </div>
      {renderPreview(props)}
      <div style={{ gridColumn: '3 / -1', gridRow: 3 }}>
        <Divider orientation="horizontal" onResize={props.onResizeTimeline} />
      </div>
      {renderTimeline(props)}
      <AppToastHost />
    </div>
  );
}
