import type { AgentContext } from './context';
import {
  costCategoryForTool,
  type CostGuardCategory,
} from './settings/agentSettings';
import type { ToolApprovalPolicy, ToolExecutionPolicy } from './execution-policy';
import { resolveTrackedJobForProject } from '../persist/jobRegistryStore';
import {
  approvalPresentationFromDetails,
  formatToolApprovalDetails,
  type ApprovalDetail,
} from './approval-details';
import { redactTextForAgentRuntime } from './runtime-artifact';

export type RuntimePermissionKind =
  | 'paid_external'
  | 'persistent_local'
  | 'irreversible_external';

export interface RuntimeGuardRequest {
  readonly skill: CostGuardCategory;
  readonly permissionKind?: RuntimePermissionKind;
  readonly approval?: ToolApprovalPolicy;
  /** Actual provider/export tool whose execution is being confirmed. */
  readonly tool: string;
  readonly requestedTool?: string;
  readonly operationId?: string;
  readonly argsDigest?: string;
  readonly details?: readonly ApprovalDetail[];
  readonly summary?: string;
}


function permissionSummary(
  presentation: string,
  permissionKind: RuntimePermissionKind,
): string {
  const prefix = permissionKind === 'persistent_local'
    ? '将持久修改本机或工程数据'
    : permissionKind === 'irreversible_external'
      ? '将执行可能无法撤销的外部操作'
      : '将执行付费或高成本外部操作';
  return `${prefix}：${presentation}`;
}

export function guardRequestForPolicy(
  toolName: string,
  args: Record<string, unknown>,
  policy: ToolExecutionPolicy,
  resolved: RuntimeGuardRequest | null,
): RuntimeGuardRequest | null {
  if (policy.approval === 'never') return null;
  const permissionKind: RuntimePermissionKind = resolved?.permissionKind
    ?? (policy.effect === 'persistent_local' ? 'persistent_local'
      : policy.effect === 'irreversible_external' ? 'irreversible_external' : 'paid_external');
  const authoritativeTool = resolved?.tool ?? toolName;
  const presentation = resolved?.requestedTool && resolved.details
    ? approvalPresentationFromDetails(authoritativeTool, resolved.details)
    : formatToolApprovalDetails(authoritativeTool, args);
  return {
    skill: resolved?.skill ?? 'high-cost-operation',
    tool: authoritativeTool,
    requestedTool: resolved?.requestedTool,
    operationId: resolved?.operationId
      ? redactTextForAgentRuntime(resolved.operationId)
      : undefined,
    permissionKind,
    approval: policy.approval,
    summary: permissionSummary(presentation.summary, permissionKind),
    details: presentation.details,
  };
}

/** Resolve reruns before confirmation so the card names the original operation and args. */
export async function runtimeGuardForTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: AgentContext,
): Promise<RuntimeGuardRequest | null> {
  const defaultSkill = costCategoryForTool(toolName);
  if (!defaultSkill) return null;
  if (toolName !== 'rerun_generation') {
    const presentation = formatToolApprovalDetails(toolName, args);
    return {
      skill: defaultSkill,
      permissionKind: 'paid_external',
      tool: toolName,
      summary: presentation.summary,
      details: presentation.details,
    };
  }
  const projectId = ctx.getProjectId?.();
  if (!projectId) throw new Error('rerun_generation requires a persisted project id');
  const resolution = await resolveTrackedJobForProject(projectId, String(args.jobId ?? ''));
  if (!resolution.ok) throw new Error(resolution.message);
  const original = resolution.job;
  if (original.submitArgsVersion !== 1 || !original.submitArgs || !original.toolName) {
    throw new Error(`generation operation ${original.operationId} is a legacy summary-only snapshot and cannot be rerun safely`);
  }
  const presentation = formatToolApprovalDetails(original.toolName, original.submitArgs);
  return {
    skill: costCategoryForTool(original.toolName) ?? 'high-cost-operation',
    tool: original.toolName,
    requestedTool: toolName,
    operationId: original.operationId,
    summary: presentation.summary,
    details: presentation.details,
    permissionKind: 'paid_external',
  };
}
