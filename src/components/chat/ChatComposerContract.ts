import type { RefObject } from 'react';
import type { AgentReference } from '../../agent/context';
import type { AgentContextUsage } from '../../agent/context-compaction';
import type { AgentSettings } from '../../agent/settings/agentSettings';
import type { EditorDragPayload } from '../../editor/editorDrag';
import type { IconName } from '../icons';

export type ChatMode = 'agent' | 'ask';
export type RefItem = AgentReference;

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onEnhance: () => void;
  agentSettings: AgentSettings;
  patchAgent: (patch: Partial<AgentSettings>) => void;
  enhancing: boolean;
  running: boolean;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  autoApply: boolean;
  contextUsage: AgentContextUsage | null;
  onAutoApplyChange: (value: boolean) => void;
  selecting: boolean;
  onToggleSelecting: () => void;
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  references: RefItem[];
  onInsertRef: (reference: RefItem) => void;
  selectedRefs?: RefItem[];
  onRemoveRef?: (id: string) => void;
  onPasteFiles?: (files: File[]) => void;
  onDropFiles?: (files: File[]) => void;
  pasting?: boolean;
  pendingAttachmentCount?: number;
  pasteError?: string | null;
  onDismissPasteError?: () => void;
  onDropEditorItem?: (payload: EditorDragPayload) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}

export const REF_ICON: Record<RefItem['kind'], IconName> = {
  video: 'filePlay', image: 'filePlay', gif: 'image', svg: 'image', document: 'text', file: 'paperclip',
  audio: 'fileHeadphone', 'motion-graphic': 'sparkles', template: 'sparkles',
  'library-resource': 'sparkles', item: 'film', timepoint: 'clock', timerange: 'clock',
  'canvas-region': 'aspect', 'transcript-selection': 'text',
};
