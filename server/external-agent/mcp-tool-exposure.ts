import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { activatedToolNamesForResult } from '../../src/agent/skills/skill-tool-activation.ts';

interface McpToolListChangeTarget {
  toolListDigest: string;
  server?: { sendToolListChanged: () => Promise<void> } | null;
}

export function mcpToolListDigest(tools: readonly Tool[]): string {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

export async function sendMcpToolListChangedIfChanged(
  target: McpToolListChangeTarget,
  tools: readonly Tool[],
): Promise<void> {
  const digest = mcpToolListDigest(tools);
  if (digest === target.toolListDigest) return;
  target.toolListDigest = digest;
  await target.server?.sendToolListChanged().catch(() => undefined);
}

export type McpToolExposureMode = 'progressive' | 'full';
export interface McpToolExposure {
  readonly mode: McpToolExposureMode;
  readonly names: readonly string[];
  readonly revision: number;
  readonly lastActivation?: {
    readonly source: 'tool_search' | 'load_skill';
    readonly names: readonly string[];
    readonly at: number;
  };
}

const PROGRESSIVE_BOOT_NAMES = [
  'ToolSearch',
  'load_skill',
  'read_project',
  'read_timeline',
  'read_agent_artifact',
  'begin_edit_session',
  'get_edit_session',
  'review_edit_session',
  'discard_edit_session',
] as const;

export function requestedMcpToolExposure(req: IncomingMessage): McpToolExposureMode {
  const header = req.headers['x-openchatcut-tool-exposure'];
  const headerValue = Array.isArray(header) ? header[0] : header;
  const queryValue = new URL(req.url ?? '/', 'http://openchatcut.local')
    .searchParams.get('toolExposure');
  return headerValue === 'progressive' || queryValue === 'progressive'
    ? 'progressive'
    : 'full';
}

export function initialMcpToolExposure(mode: McpToolExposureMode): McpToolExposure {
  return { mode, names: [...PROGRESSIVE_BOOT_NAMES], revision: 1 };
}

export function projectMcpToolExposure(
  exposure: McpToolExposure,
  tools: readonly Tool[],
  controlNames: Readonly<Record<string, true>>,
): Tool[] {
  if (exposure.mode === 'full') return [...tools];
  const visible = new Set(exposure.names);
  return tools.filter((tool) => controlNames[tool.name] === true || visible.has(tool.name));
}

export function activatedMcpToolNames(
  toolName: string,
  result: unknown,
  catalog: readonly Tool[],
): string[] {
  return activatedToolNamesForResult(toolName, result, catalog);
}

export function activateMcpToolExposure(
  exposure: McpToolExposure,
  toolName: string,
  result: unknown,
  catalog: readonly Tool[],
  now = Date.now(),
): McpToolExposure {
  if (exposure.mode === 'full' || (toolName !== 'ToolSearch' && toolName !== 'load_skill')) {
    return exposure;
  }
  const activated = activatedMcpToolNames(toolName, result, catalog);
  const current = new Set(exposure.names);
  const added = activated.filter((name) => !current.has(name));
  if (!added.length) return exposure;
  return {
    ...exposure,
    names: [...current, ...added],
    revision: exposure.revision + 1,
    lastActivation: {
      source: toolName === 'ToolSearch' ? 'tool_search' : 'load_skill',
      names: added,
      at: now,
    },
  };
}

export function mcpToolExposureStatus(
  exposure: McpToolExposure,
  projectedCount: number,
  fullCount: number,
): Record<string, unknown> {
  return {
    toolExposureMode: exposure.mode,
    toolExposureCount: projectedCount,
    fullToolCount: fullCount,
    exposureRevision: exposure.revision,
    lastToolActivation: exposure.lastActivation ?? null,
  };
}
