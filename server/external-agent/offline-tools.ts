import {
  EXTERNAL_SESSION_TOOLS,
  externalDraftSchemas,
  type ExternalRegisteredTool,
} from '../../src/agent/external-tool-shape.js';
import { isExternalServerDirectTool } from '../../src/agent/external-tool-policy.js';
import { AGENT_RUNTIME_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/agent-runtime-tools.js';
import { CORE_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/core-tools.js';
import { CAPTIONS_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/captions-tools.js';
import { MARKERS_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/markers-tools.js';
import { READ_PROJECT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/read-project-tools.js';
import { SCRIPT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/script-tools.js';
import { TIMELINE_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/timeline-tools.js';
import { TRACK_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/track-tools.js';
import { TRANSCRIPT_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/transcript-tools.js';
import { WATERMARK_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/watermark-tools.js';

const OFFLINE_TOOL_DESCRIPTIONS: Record<string, string> = {
  begin_edit_session: 'Start an offline server draft. approvalMode must be auto; open the editor URL for manual approval.',
  review_edit_session: 'Atomically commit the complete offline draft and return terminal status applied, or write nothing.',
  edit_captions: 'Edit built-in caption template, style, layout, text, source, and language data. preset_* actions require the browser editor.',
};

const OFFLINE_SCHEMA_GROUPS = [
  AGENT_RUNTIME_TOOL_SCHEMAS,
  CORE_TOOL_SCHEMAS,
  TIMELINE_TOOL_SCHEMAS,
  TRACK_TOOL_SCHEMAS,
  SCRIPT_TOOL_SCHEMAS,
  CAPTIONS_TOOL_SCHEMAS,
  WATERMARK_TOOL_SCHEMAS,
  MARKERS_TOOL_SCHEMAS,
  READ_PROJECT_TOOL_SCHEMAS,
  TRANSCRIPT_TOOL_SCHEMAS,
] as const;

function serverDirectSchemas(): ExternalRegisteredTool[] {
  const byName = new Map(
    OFFLINE_SCHEMA_GROUPS
      .flat()
      .filter((tool) => isExternalServerDirectTool(tool.name))
      .map((tool) => [tool.name, tool]),
  );
  return externalDraftSchemas([...byName.values()]);
}

/** Lifecycle controls plus the reviewed, dependency-closed pure-data editor subset. */
export function offlineExternalToolSchemas(): ExternalRegisteredTool[] {
  return [...EXTERNAL_SESSION_TOOLS, ...serverDirectSchemas()].map((tool) => (
    OFFLINE_TOOL_DESCRIPTIONS[tool.name]
      ? { ...tool, description: OFFLINE_TOOL_DESCRIPTIONS[tool.name] }
      : tool
  ));
}
