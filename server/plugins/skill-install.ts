// install_skill: download a GitHub skill repo into ~/.openchatcut/skills/<slug>/
// so multi-file skills (references/scripts/assets/examples) install completely —
// single-SKILL.md manage_skill create cannot carry support files. The panel
// discovers the installed directory automatically (skills-files discovery).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { skillDirFor, skillFilesRoot } from '../skills-files.ts';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SAFE_SLUG = /^[A-Za-z0-9_-]{1,120}$/;

// Skill-relevant paths only — repo plumbing (README/LICENSE/CHANGELOG/
// .gitignore/agents/) is not copied into the skill directory.
const SKIP_PREFIXES = ['README', 'LICENSE', 'CHANGELOG', '.gitignore', 'agents/', 'workflow'];

interface InstallRequest {
  repo: string;
  slug?: string;
}

function parseRepo(raw: string): { owner: string; repo: string } | null {
  const value = String(raw ?? '').trim();
  const m = value.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/|$)/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/i, '') };
}

async function readJson(req: IncomingMessage): Promise<InstallRequest> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) { rejectPromise(new Error('request too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as InstallRequest); }
      catch { rejectPromise(new Error('invalid JSON')); }
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isSkillPath(path: string): boolean {
  if (path === 'SKILL.md') return true;
  const lower = path.toLowerCase();
  return lower.startsWith('references/')
    || lower.startsWith('scripts/')
    || lower.startsWith('assets/')
    || lower.startsWith('examples/')
    || SKIP_PREFIXES.every((prefix) => !lower.startsWith(prefix.toLowerCase()) && !lower.includes(`/${prefix.toLowerCase()}/`));
}

async function fetchTree(owner: string, repo: string): Promise<Array<{ path: string; url: string; size?: number }>> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openchatcut-skill-install' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { tree?: Array<{ path: string; url: string; size?: number; type: string }>; truncated?: boolean };
  if (data.truncated === true) throw new Error('repo tree too large for recursive listing');
  return (data.tree ?? [])
    .filter((t) => t.type === 'blob' && isSkillPath(t.path))
    .map((t) => ({ path: t.path, url: t.url, size: t.size }));
}

export async function installGitHubSkill(
  repo: string,
  slugOverride?: string,
): Promise<{ slug: string; installedAt: string; files: string[] }> {
  const parsed = parseRepo(repo);
  if (!parsed) throw new Error('repo must be a GitHub URL or owner/repo');
  const { owner, repo: repoName } = parsed;
  const files = await fetchTree(owner, repoName);
  if (!files.some((f) => f.path === 'SKILL.md')) throw new Error(`repo ${owner}/${repoName} has no SKILL.md at its root`);
  // slug: override > SKILL.md frontmatter name > repo name.
  let slug = slugOverride?.trim() || '';
  if (!SAFE_SLUG.test(slug)) {
    const frontmatter = await (await fetch(`https://raw.githubusercontent.com/${owner}/${repoName}/HEAD/SKILL.md`, { signal: AbortSignal.timeout(15_000) })).text();
    const name = frontmatter.match(/^name:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1] ?? '';
    slug = name || repoName.replace(/[^A-Za-z0-9_-]/g, '-');
  }
  const root = skillFilesRoot();
  const dir = skillDirFor(root, slug);
  if (!dir) throw new Error(`invalid slug "${slug}"`);
  await mkdir(dir, { recursive: true });
  let total = 0;
  const installed: string[] = [];
  for (const file of files) {
    const size = file.size ?? 0;
    if (size > MAX_FILE_BYTES) continue;
    total += size;
    if (total > MAX_TOTAL_BYTES) break;
    const raw = await (await fetch(file.url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'openchatcut-skill-install' }, signal: AbortSignal.timeout(30_000) })).json() as { content?: string };
    if (!raw.content) continue;
    const bytes = Buffer.from(raw.content, 'base64');
    const target = join(dir, file.path);
    await mkdir(join(dir, file.path.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(target, bytes);
    installed.push(file.path);
  }
  if (!installed.includes('SKILL.md')) throw new Error('SKILL.md download failed');
  return { slug, installedAt: join('~', '.openchatcut', 'skills', slug), files: installed };
}

export function skillInstallPlugin(): Plugin {
  return {
    name: 'openchatcut-skill-install',
    configureServer(server) {
      server.middlewares.use('/api/skills/install', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const body = await readJson(req);
          const result = await installGitHubSkill(body.repo, body.slug);
          sendJson(res, 200, { ok: true, ...result, note: '技能已安装到用户技能目录，面板会自动展示。' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[api/skills/install] ${message}`);
          if (!res.headersSent) sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
