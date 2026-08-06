export { INSTALL_SKILL_TOOL_SCHEMAS, INSTALL_SKILL_TOOL_NAMES } from './schemas/install-skill-tools';
// install_skill: fetch a GitHub skill repo and install it into
// ~/.openchatcut/skills/<slug>/ (full multi-file install, not just SKILL.md).
// The library Skills tab discovers the directory automatically.
import type { AgentContext } from '../context';

interface InstallResult {
  ok: boolean;
  slug?: string;
  installedAt?: string;
  files?: string[];
  error?: string;
}

async function callInstall(repo: string, slug?: string): Promise<InstallResult> {
  try {
    const res = await fetch('/api/skills/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, slug }),
    });
    const data = (await res.json().catch(() => null)) as InstallResult | null;
    if (!res.ok || !data) return { ok: false, error: data?.error ?? `install failed (HTTP ${res.status})` };
    return data;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function execInstallSkillTool(name: string, args: Record<string, unknown>, _ctx: AgentContext): Promise<unknown> {
  if (name !== 'install_skill') return { error: `unknown tool ${name}` };
  const repo = String(args.repo ?? '').trim();
  if (!repo) return { error: 'repo is required — a GitHub URL or owner/repo (e.g. "Jane-xiaoer/paper-collage-ad-codex")' };
  const slug = typeof args.slug === 'string' ? args.slug.trim() : undefined;
  const result = await callInstall(repo, slug);
  if (!result.ok) return { error: result.error ?? 'install failed' };
  return {
    ok: true,
    slug: result.slug,
    installedAt: result.installedAt,
    files: result.files,
    note: '技能已安装到用户技能目录（~/.openchatcut/skills/<slug>/），资源库「技能」面板会自动展示。可以在对话中 /skill:<slug> 或从面板激活。',
  };
}
