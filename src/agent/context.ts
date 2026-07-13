import type { EditorCommands } from '../editor/store';
import type { TimelineState } from '../editor/types';
import type { Tpl } from '../types';

/** What the agent's tools operate on: the live editor. */
export interface AgentContext {
  commands: EditorCommands;
  getState: () => TimelineState;
  templates: Tpl[];
}
