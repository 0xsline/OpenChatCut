import type { EditorCommands } from '../editor/store';
import type { ProjectDoc, TimelineState } from '../editor/types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';

export interface AgentReference {
  id: string;
  name: string;
  kind: 'video' | 'image' | 'audio' | 'motion-graphic' | 'template';
}

/** What the agent's tools operate on: the live editor. */
export interface AgentContext {
  commands: EditorCommands;
  /** the ACTIVE timeline (per-clip tools read this) */
  getState: () => TimelineState;
  /** the whole project — all timelines + which is active (manage_timelines reads this) */
  getDoc: () => ProjectDoc;
  /** the active creative-mode skill id, or null (source agent_skill); drives prompt injection */
  getCreativeMode: () => string | null;
  templates: Tpl[];
  audio: AudioAsset[];
  /** Open project id (hash route /#/editor/:id). Used by project tools. */
  getProjectId?: () => string;
  /** Navigate editor to another project (flush + hash change). */
  openProject?: (projectId: string) => Promise<{ ok: boolean; error?: string } | void>;
  /** Dashboard/title rename when edit_project updates the open project. */
  onProjectRenamed?: (name: string) => void;
}

/** Resolve UI mentions by stable id; names in the prompt are display-only. */
export function resolveAgentReferences(ctx: AgentContext, references: AgentReference[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    if (reference.kind === 'template') {
      const template = ctx.templates.find((item) => item.id === reference.id);
      if (template) entries.push({ type: 'template', id: template.id, name: template.name, category: template.category, width: template.width, height: template.height, durationInFrames: template.durationInFrames, propKeys: template.propSchema.map((prop) => prop.key) });
    } else {
      const asset = ctx.getDoc().assets.find((item) => item.id === reference.id);
      if (asset) entries.push({ type: 'asset', id: asset.id, name: asset.name, kind: asset.kind, src: asset.src, durationInFrames: asset.durationInFrames, width: asset.width, height: asset.height });
    }
  }
  return entries;
}
