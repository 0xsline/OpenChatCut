import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { EditorCommands } from '../../editor/store';
import type { TimelineState, TrackId } from '../../editor/types';
import type { SlipPreview } from '../../editor/slip';
import type { CaptionSelectOptions, CaptionSelectionRef } from '../../captions/captionSelection';
import type { TimelineShortcutApi } from '../../shortcuts/timelineApi';

export interface TimelineProps {
  state: TimelineState;
  commands: EditorCommands;
  playerRef: RefObject<PlayerRef | null>;
  /** project id for playhead continuity across reloads */
  projectId?: string;
  /** record a mic voiceover → upload the blob → drop it on an audio track */
  onRecordVoiceover?: (blob: Blob) => void;
  /** Filled by Timeline so Editor can bind the global shortcut dispatcher. */
  shortcutApiRef?: RefObject<TimelineShortcutApi | null>;
  onReviewItem?: (request: { itemId: string; frame: number; clientX: number; clientY: number }) => void;
  onSlipPreview?: (preview: SlipPreview | null) => void;
  /** Read-only frame under the pointer; never mutates the formal playhead. */
  onHoverPreviewFrameChange?: (frame: number | null) => void;
  selectedCaptions?: CaptionSelectionRef[];
  onSelectCaption?: (selection: CaptionSelectionRef | null, options?: CaptionSelectOptions) => void;
  onMarqueeCaptionSelect?: (
    selections: CaptionSelectionRef[],
    options: { additive: boolean; preserveWithItems: boolean },
  ) => void;
  onDropExternalFiles?: (files: File[], trackId: TrackId, startFrame: number) => void;
}
