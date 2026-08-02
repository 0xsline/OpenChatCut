import type { AgentContext } from './context';
import {
  generationSkillForTool,
  type GenerationGuardSkill,
} from './settings/agentSettings';
import { resolveTrackedJobForProject } from '../persist/jobRegistryStore';

export interface RuntimeGuardRequest {
  readonly skill: GenerationGuardSkill;
  /** Actual provider/export tool whose execution is being confirmed. */
  readonly tool: string;
  readonly requestedTool?: string;
  readonly operationId?: string;
  readonly summary?: string;
}

function summarizeGuardArgs(toolName: string, args: Record<string, unknown>): string {
  const keys = ['provider', 'model', 'mode', 'durationSeconds', 'resolution', 'ratio', 'name'] as const;
  const details = keys.flatMap((key) => args[key] === undefined ? [] : [`${key}=${String(args[key])}`]);
  if (typeof args.prompt === 'string' && args.prompt.trim()) {
    const prompt = args.prompt.trim();
    details.push(`prompt=${JSON.stringify(prompt.length > 120 ? `${prompt.slice(0, 117)}…` : prompt)}`);
  }
  return [toolName, ...details].join(' · ');
}

/** Resolve reruns before confirmation so the card names the original operation and args. */
export async function runtimeGuardForTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<RuntimeGuardRequest | null> {
  const defaultSkill = generationSkillForTool(toolName);
  if (!defaultSkill) return null;
  if (toolName !== 'rerun_generation') {
    return { skill: defaultSkill, tool: toolName, summary: summarizeGuardArgs(toolName, args) };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) throw new Error('rerun_generation requires a persisted project id');
  const resolution = await resolveTrackedJobForProject(projectId, String(args.jobId ?? ''));
  if (!resolution.ok) throw new Error(resolution.message);
  const original = resolution.job;
  if (original.submitArgsVersion !== 1 || !original.submitArgs || !original.toolName) {
    throw new Error(`generation operation ${original.operationId} is a legacy summary-only snapshot and cannot be rerun safely`);
  }
  return {
    skill: generationSkillForTool(original.toolName) ?? 'high-cost-operation',
    tool: original.toolName,
    requestedTool: toolName,
    operationId: original.operationId,
    summary: summarizeGuardArgs(original.toolName, original.submitArgs),
  };
}
