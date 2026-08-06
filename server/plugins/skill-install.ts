// install_skill: download a GitHub skill repo into ~/.openchatcut/skills/<slug>/
// so multi-file skills (references/scripts/assets/examples) install completely —
// single-SKILL.md manage_skill create cannot carry support files. The panel
// discovers the installed directory automatically (skills-files discovery).
// GitHub API is the primary path (GITHUB_TOKEN env raises the rate limit);
// on 403 rate limits it falls back to a shallow git clone.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { skillDirFor, skillFilesRoot } from '../skills-files.ts';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SAFE_SLUG = /^[A-Za-z0-9_-]{1,120}$/;
const execFileAsync = promisify(execFile);

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

function githubToken(): string {
  return process.env.GITHUB_TOKEN?.trim() ?? '';
}

function apiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'User-Agent': 'openchatcut-skill-install' };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function isRateLimited(status: number): boolean {
  return status === 403 || status === 429;
}

function isSkillPath(path: string): boolean {
  if (path === 'SKILL.md') return true;
  if (path.split('/').some((part) => part.startsWith('.'))) return false;
  const lower = path.toLowerCase();
  return lower.startsWith('references/')
    || lower.startsWith('scripts/')
    || lower.startsWith('assets/')
    || lower.startsWith('examples/')
    || SKIP_PREFIXES.every((prefix) => !lower.startsWith(prefix.toLowerCase()) && !lower.includes(`/${prefix.toLowerCase()}/`));
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

/** GitHub API recursive tree; throws RateLimitedError on 403/429. */
class RateLimitedError extends Error {
  constructor(message: string) { super(message); this.name = 'RateLimitedError'; }
}

async function fetchTree(owner: string, repo: string): Promise<Array<{ path: string; url: string; size?: number }>> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    if (isRateLimited(res.status)) throw new RateLimitedError(`GitHub API ${res.status}`);
    throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { tree?: Array<{ path: string; url: string; size?: number; type: string }>; truncated?: boolean };
  if (data.truncated === true) throw new Error('repo tree too large for recursive listing');
  return (data.tree ?? [])
    .filter((t) => t.type === 'blob' && isSkillPath(t.path))
    .map((t) => ({ path: t.path, url: t.url, size: t.size }));
}

async function fetchFrontmatterName(owner: string, repo: string): Promise<string> {
  const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/SKILL.md`, {
    headers: githubToken() ? { Authorization: `Bearer ${githubToken()}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return '';
  const text = await res.text();
  return text.match(/^name:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1] ?? '';
}

/** Slug: override > SKILL.md frontmatter name > repo name. */
function deriveSlug(override: string | undefined, frontmatterName: string, repoName: string): string {
  const candidate = (override?.trim() || frontmatterName || repoName.replace(/[^A-Za-z0-9_-]/g, '-')).trim();
  return SAFE_SLUG.test(candidate) ? candidate : '';
}

async function writeSkillFiles(dir: string, entries: Array<{ path: string; bytes: Buffer }>): Promise<string[]> {
  let total = 0;
  const installed: string[] = [];
  for (const entry of entries) {
    if (entry.bytes.byteLength > MAX_FILE_BYTES) continue;
    total += entry.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) break;
    const parts = entry.path.split('/');
    await mkdir(join(dir, ...parts.slice(0, -1)), { recursive: true });
    await writeFile(join(dir, ...parts), entry.bytes);
    installed.push(entry.path);
  }
  return installed;
}

async function installViaApi(owner: string, repo: string, slug: string): Promise<{ files: string[]; source: string }> {
  const files = await fetchTree(owner, repo);
  if (!files.some((f) => f.path === 'SKILL.md')) throw new Error(`repo ${owner}/${repo} has no SKILL.md at its root`);
  const entries: Array<{ path: string; bytes: Buffer }> = [];
  for (const file of files) {
    const res = await fetch(file.url, { headers: apiHeaders(), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`GitHub blob ${res.status}: ${file.path}`);
    const raw = (await res.json()) as { content?: string };
    if (raw.content) entries.push({ path: file.path, bytes: Buffer.from(raw.content, 'base64') });
  }
  const dir = skillDirFor(skillFilesRoot(), slug);
  if (!dir) throw new Error(`invalid slug "${slug}"`);
  await mkdir(dir, { recursive: true });
  const installed = await writeSkillFiles(dir, entries);
  if (!installed.includes('SKILL.md')) throw new Error('SKILL.md download failed');
  return { files: installed, source: 'api' };
}

/** Shallow clone fallback for GitHub API rate limits (git must be available). */
async function installViaClone(owner: string, repo: string, slug: string): Promise<{ files: string[]; source: string }> {
  const scratch = join(tmpdir(), `occ-skill-${randomBytes(6).toString('hex')}`);
  try {
    await execFileAsync('git', ['clone', '--depth', '1', `https://github.com/${owner}/${repo}`, scratch], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const skill = await readFile(join(scratch, 'SKILL.md'));
    const entries: Array<{ path: string; bytes: Buffer }> = [];
    const walk = async (relative: string): Promise<void> => {
      const absolute = join(scratch, relative);
      const stat = await import('node:fs/promises').then((fs) => fs.stat(absolute));
      if (stat.isDirectory()) {
        if (relative === '.git' || relative.endsWith('/.git')) return;
        const children = await import('node:fs/promises').then((fs) => fs.readdir(absolute));
        for (const child of children) await walk(join(relative, child));
      } else if (isSkillPath(relative)) {
        entries.push({ path: relative, bytes: await import('node:fs/promises').then((fs) => fs.readFile(absolute)) });
      }
    };
    await walk('');
    const dir = skillDirFor(skillFilesRoot(), slug);
    if (!dir) throw new Error(`invalid slug "${slug}"`);
    await mkdir(dir, { recursive: true });
    const installed = await writeSkillFiles(dir, [{ path: 'SKILL.md', bytes: skill }, ...entries.filter((e) => e.path !== 'SKILL.md')]);
    if (!installed.includes('SKILL.md')) throw new Error('SKILL.md download failed');
    return { files: installed, source: 'git-clone' };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installGitHubSkill(
  repo: string,
  slugOverride?: string,
): Promise<{ slug: string; installedAt: string; files: string[]; source: string }> {
  const parsed = parseRepo(repo);
  if (!parsed) throw new Error('repo must be a GitHub URL or owner/repo');
  const { owner, repo: repoName } = parsed;
  let slug = slugOverride?.trim() || '';
  if (!SAFE_SLUG.test(slug)) {
    const frontmatterName = await fetchFrontmatterName(owner, repoName);
    slug = deriveSlug(undefined, frontmatterName, repoName);
  }
  if (!SAFE_SLUG.test(slug)) throw new Error('invalid skill slug');
  let result: { files: string[]; source: string };
  try {
    result = await installViaApi(owner, repoName, slug);
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    try {
      result = await installViaClone(owner, repoName, slug);
    } catch (cloneError) {
      const detail = cloneError instanceof Error ? cloneError.message : String(cloneError);
      throw new Error(`GitHub API rate-limited and git clone fallback failed: ${detail}`);
    }
  }
  return { slug, installedAt: join('~', '.openchatcut', 'skills', slug), files: result.files, source: result.source };
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
