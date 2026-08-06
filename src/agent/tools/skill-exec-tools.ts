export { RUN_SKILL_SCRIPT_TOOL_SCHEMAS, RUN_SKILL_SCRIPT_TOOL_NAMES } from './schemas/skill-exec-tools';
// run_skill_script: execute a whitelisted binary inside an installed skill's
// directory on the LOCAL machine (server-side). Skill-shipped deterministic
// scripts (render.mjs, check-deps.sh, …) run where their relative assets live;
// the cloud run_code sandbox cannot see ~/.openchatcut/skills.
import type { AgentContext } from '../context';

interface ExecResult {
  ok?: boolean;
  exitCode?: number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
  cwd?: string;
}

export async function execRunSkillScriptTool(name: string, args: Record<string, unknown>, _ctx: AgentContext): Promise<unknown> {
  if (name !== 'run_skill_script') return { error: `unknown tool ${name}` };
  const skill = String(args.skill ?? '').trim();
  const command = String(args.command ?? '').trim();
  if (!skill) return { error: 'skill is required (slug from load_skill)' };
  if (!command) return { error: 'command is required, e.g. "bash scripts/check-deps.sh"' };
  try {
    const res = await fetch(`/api/skills/${encodeURIComponent(skill)}/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        timeout: typeof args.timeout === 'number' ? args.timeout : undefined,
      }),
    });
    const data = (await res.json().catch(() => null)) as ExecResult | null;
    if (!data) return { error: `exec failed (HTTP ${res.status})` };
    if (data.error && data.ok !== true) return { error: data.error, stdout: data.stdout, stderr: data.stderr, exitCode: data.exitCode };
    return {
      ok: data.ok,
      exitCode: data.exitCode,
      killed: data.killed,
      stdout: data.stdout ?? '',
      stderr: data.stderr ?? '',
      cwd: data.cwd,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
