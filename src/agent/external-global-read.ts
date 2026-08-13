import type { AgentContext } from './context';
import { ExternalSessionRunLedger } from './external-run-ledger';
import { executeTool } from './tools';

export async function executeExternalGlobalReadTool(
  projectId: string,
  name: string,
  args: Record<string, unknown>,
  context: AgentContext,
  signal?: AbortSignal,
): Promise<unknown> {
  const run = await ExternalSessionRunLedger.start(
    projectId,
    'external-connected',
    `global_${crypto.randomUUID()}`,
    'external-connected',
    executeTool,
  );
  try {
    const invocation = await run.requested(name, args);
    const result = await run.executeApprovedTool(invocation, args, context, signal);
    await run.finalize('completed', `External global read ${name} completed.`);
    return result;
  } catch (error) {
    await run.finalize('failed', `External global read ${name} failed.`).catch(() => undefined);
    throw error;
  } finally {
    run.dispose();
  }
}
