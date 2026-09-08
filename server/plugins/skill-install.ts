// install_skill: download a GitHub skill repo into ~/.openchatcut/skills/<slug>/
// so multi-file skills (references/scripts/assets/examples) install completely —
// single-SKILL.md manage_skill create cannot carry support files. The panel
// discovers the installed directory automatically (skills-files discovery).
// GitHub API is the primary path (GITHUB_TOKEN env raises the rate limit);
// on 403 rate limits it falls back to a shallow git clone.
import { proxyDispatcher } from '../outbound-proxy.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { skillDirFor, skillFilesRoot } from '../skills-files.ts';
import {
  isSkillPath, publishSkillFiles, stageCloneSkillFiles, stageSkillFile,
  validateSkillFiles, validateSkillPath, type SkillInstallFile,
} from './skill-install-files.ts';
// Proxy-aware fetch: attaches the configured outbound proxy (keystore
// PROXY_URL or HTTPS_PROXY/HTTP_PROXY env) via undici dispatcher.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);


const SAFE_SLUG = /^[A-Za-z0-9_-]{1,120}$/;
const execFileAsync = promisify(execFile);

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

async function fetchTree(owner: string, repo: string): Promise<SkillInstallFile[]> {
  const res = await fetchWithProxy(`https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`, {
    headers: apiHeaders(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    if (isRateLimited(res.status)) throw new RateLimitedError(`GitHub API ${res.status}`);
    throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { tree?: Array<{ path: string; sha: string; size: number; type: string; mode: string }>; truncated?: boolean };
  if (data.truncated === true) throw new Error('repo tree too large for recursive listing');
  const files: SkillInstallFile[] = [];
  for (const entry of data.tree ?? []) {
    validateSkillPath(entry.path);
    if (entry.mode === '120000') throw new Error(`symbolic links are not allowed in skills: ${entry.path}`);
    if (entry.type === 'tree') continue;
    if (!isSkillPath(entry.path)) continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)
      || !/^[a-f0-9]{40,64}$/i.test(entry.sha)) throw new Error(`invalid skill blob: ${entry.path}`);
    files.push({ path: entry.path, sha: entry.sha, size: entry.size });
  }
  validateSkillFiles(files);
  return files;
}

/** Slug: override > SKILL.md frontmatter name > repo name. */
function deriveSlug(override: string | undefined, frontmatterName: string, repoName: string): string {
  const candidate = (override?.trim() || frontmatterName || repoName.replace(/[^A-Za-z0-9_-]/g, '-')).trim();
  return SAFE_SLUG.test(candidate) ? candidate : '';
}

async function installViaApi(owner: string, repo: string, stage: string): Promise<SkillInstallFile[]> {
  const files = await fetchTree(owner, repo);
  const budget = { total: 0 };
  for (const file of files) {
    // Build the trusted origin ourselves; never send credentials to a tree-provided URL.
    const url = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${file.sha}`;
    const res = await fetchWithProxy(url, {
      headers: { ...apiHeaders(), Accept: 'application/vnd.github.raw+json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (isRateLimited(res.status)) throw new RateLimitedError(`GitHub blob ${res.status}`);
    if (!res.ok) throw new Error(`GitHub blob ${res.status}: ${file.path}`);
    if (!res.body) throw new Error(`empty blob response: ${file.path}`);
    if (res.headers.has('content-length') && Number(res.headers.get('content-length')) > file.size) {
      await res.body.cancel();
      throw new Error(`skill file exceeds size limit: ${file.path}`);
    }
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
    await stageSkillFile(body, stage, file, budget);
  }
  return files;
}

/** Shallow clone fallback for GitHub API rate limits (git must be available). */
async function installViaClone(owner: string, repo: string, stage: string): Promise<SkillInstallFile[]> {
  const scratch = await mkdtemp(join(tmpdir(), 'occ-skill-clone-'));
  try {
    await execFileAsync('git', ['clone', '--depth', '1', `https://github.com/${owner}/${repo}`, scratch], { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    return await stageCloneSkillFiles(scratch, stage);
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
  const stage = await mkdtemp(join(tmpdir(), 'occ-skill-stage-'));
  try {
    let files: SkillInstallFile[];
    let source = 'api';
    try {
      files = await installViaApi(owner, repoName, stage);
    } catch (error) {
      if (!(error instanceof RateLimitedError)) throw error;
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage);
      source = 'git-clone';
      files = await installViaClone(owner, repoName, stage);
    }
    const skill = await readFile(join(stage, 'SKILL.md'), 'utf8');
    const frontmatterName = skill.match(/^name:\s*([A-Za-z0-9_-]+)\s*$/m)?.[1] ?? '';
    const slug = deriveSlug(SAFE_SLUG.test(slugOverride ?? '') ? slugOverride : undefined, frontmatterName, repoName);
    const dir = skillDirFor(skillFilesRoot(), slug);
    if (!dir) throw new Error('invalid skill slug');
    await publishSkillFiles(stage, dir, files);
    return { slug, installedAt: join('~', '.openchatcut', 'skills', slug), files: files.map((file) => file.path), source };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
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
