import { sandboxSkipFromHttpError, sandboxSkipIfUnconfigured } from '../sandbox-unavailable';

export { RUN_CODE_TOOL_SCHEMAS, RUN_CODE_TOOL_NAMES } from './schemas/run-code-tools';
// run_code — lets a loaded skill execute its shipped scripts (ffmpeg / node / python /
// bash) in our own e2b cloud sandbox, via the server-side /e2b/run proxy (which holds the
// key). Write optional input files, run one command, read optional outputs. The sandbox
// is isolated from the editor — results come back here and the agent applies them with the
// editor tools. This is the portable execution substrate that stands in for the native
// Agent Skills container our relay can't reach.

export async function execRunCodeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'run_code') return { error: `unknown tool ${name}` };
  const unconfigured = sandboxSkipIfUnconfigured();
  if (unconfigured) return unconfigured;
  try {
    const res = await fetch('/e2b/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const message = (data.error as string) ?? `e2b failed (${res.status})`;
      return sandboxSkipFromHttpError(message) ?? { error: message };
    }
    return data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sandboxSkipFromHttpError(message) ?? { error: message };
  }
}
