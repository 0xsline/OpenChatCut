import type { EditorCommands } from '../editor/store';
import type { ProjectDoc, TimelineState } from '../editor/types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';

/** What the agent's tools operate on: the live editor. */
export interface AgentContext {
  commands: EditorCommands;
  /** the ACTIVE timeline (per-clip tools read this) */
  getState: () => TimelineState;
  /** the whole project — all timelines + which is active (manage_timelines reads this) */
  getDoc: () => ProjectDoc;
  templates: Tpl[];
  audio: AudioAsset[];
}
