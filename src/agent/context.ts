import type { EditorCommands } from '../editor/store';
import type { TimelineState } from '../editor/types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';

/** What the agent's tools operate on: the live editor. */
export interface AgentContext {
  commands: EditorCommands;
  getState: () => TimelineState;
  templates: Tpl[];
  audio: AudioAsset[];
}
