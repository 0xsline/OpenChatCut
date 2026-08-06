// /api/skills — user-visible skill files under ~/.openchatcut/skills/.
// The kv-backed custom skills (project-store skills:custom) stay the runtime
// source of truth; this plugin mirrors every write to SKILL.md files and
// merges skills the user dropped into the directory by hand. Browser code
// talks to this API through src/persist/skillStore (IDB fallback offline).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import {
  discoverSkillFiles,
  readSkillDirFiles,
  skillDirFor,
  displaySkillPath,
  mirrorSkillFile,
  removeSkillFile,
  skillFilesRoot,
} from '../skills-files.ts';

const MAX_BODY_BYTES = 512 * 1024;

interface CustomSkillPayload {
  id: string;
  slug: string;
  name: string;
  nameZh: string;
  description: string;
  summary: string;
  scenarios: string[];
  body: string;
  source: 'custom';
  createdAt: number;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error('skill body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolvePromise(text ? JSON.parse(text) as Record<string, unknown> : {});
      } catch {
        rejectPromise(new Error('invalid JSON body'));
      }
    });
    req.on('error', rejectPromise);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

/** The kv store lives behind /api/project-store; reuse its helpers via the same modules. */
async function kvSkills(): Promise<CustomSkillPayload[]> {
  const { readStore } = await import('./project-store.ts');
  const store = await readStore();
  const raw = store.entries?.['skills:custom'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is CustomSkillPayload => {
    const s = item as Partial<CustomSkillPayload>;
    return typeof s?.id === 'string' && typeof s.body === 'string';
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Mirror every write into the kv library: replace by slug/id, else append. */
async function kvUpsertBySlug(payload: Partial<CustomSkillPayload> & { slug: string }): Promise<void> {
  const { readStore, setStoredEntry } = await import('./project-store.ts');
  const store = await readStore();
  const raw = store.entries?.['skills:custom'];
  const list = Array.isArray(raw) ? raw.filter(isRecord) : [];
  const idx = list.findIndex((item) => item.slug === payload.slug || item.id === payload.slug);
  const next = [...list];
  const entry = {
    ...payload,
    id: typeof payload.id === 'string' ? payload.id : payload.slug,
    source: 'custom' as const,
  };
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  await setStoredEntry('skills:custom', next);
}

/** Remove the kv entry matching a slug or id. */
async function kvDeleteBySlug(slug: string): Promise<void> {
  const { readStore, setStoredEntry } = await import('./project-store.ts');
  const store = await readStore();
  const raw = store.entries?.['skills:custom'];
  if (!Array.isArray(raw)) return;
  const next = raw.filter((item) => !(isRecord(item) && (item.slug === slug || item.id === slug)));
  if (next.length !== raw.length) await setStoredEntry('skills:custom', next);
}

export function skillFilesPlugin(): Plugin {
  return {
    name: 'openchatcut-skill-files',
    configureServer(server) {
      server.middlewares.use('/api/skills', (req, res, next) => {
        // /api/skills/install and /api/skills/<slug>/exec are owned by their own plugins.
        if (req.url?.startsWith('/install')) { next(); return; }
        if (/^\/[A-Za-z0-9_-]{1,120}\/exec$/.test(req.url ?? '')) { next(); return; }
        void handleSkillsRequest(req, res, server);
      });
    },
  };
}

async function handleSkillsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  server: { config: { logger: { error: (msg: string) => void } } },
): Promise<void> {
  const root = skillFilesRoot();
  try {
    if (req.method === 'GET') {
      const [kv, files] = await Promise.all([kvSkills(), discoverSkillFiles(root)]);
      const kvSlugs = new Set(kv.map((skill) => skill.slug));
      // kv skills keep their mirror directory contents when present (full load).
      const kvWithFiles = await Promise.all(kv.map(async (skill) => {
        const dir = skillDirFor(root, skill.slug);
        const fileContents = dir ? await readSkillDirFiles(dir) : {};
        if (fileContents['SKILL.md'] === undefined && skill.body) fileContents['SKILL.md'] = skill.body;
        return { ...skill, files: Object.keys(fileContents).sort(), fileContents };
      }));
      // User-dropped files that are not in kv become ad-hoc custom skills.
      const discovered = files
        .filter((file) => !kvSlugs.has(file.slug))
        .map((file) => ({
          id: file.slug,
          slug: file.slug,
          name: file.slug,
          nameZh: file.slug,
          description: file.description,
          summary: file.description,
          scenarios: [] as string[],
          body: file.body,
          files: Object.keys(file.fileContents).sort(),
          fileContents: file.fileContents,
          source: 'custom' as const,
          createdAt: 0,
        }));
      sendJson(res, 200, { skills: [...kvWithFiles, ...discovered], root });
      return;
    }
    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const payload = body.skill as Partial<CustomSkillPayload> | undefined;
      if (!payload || typeof payload.slug !== 'string' || typeof payload.body !== 'string') {
        sendJson(res, 400, { error: 'PUT requires skill.slug and skill.body' });
        return;
      }
      const path = await mirrorSkillFile(root, payload.slug, payload.body);
      if (!path) {
        sendJson(res, 400, { error: `invalid skill slug "${payload.slug}"` });
        return;
      }
      await kvUpsertBySlug({ ...payload, slug: payload.slug });
      sendJson(res, 200, { ok: true, installedAt: displaySkillPath(payload.slug) });
      return;
    }
    if (req.method === 'DELETE') {
      const slug = String(req.url?.split('/').filter(Boolean).pop() ?? '');
      await removeSkillFile(root, slug);
      await kvDeleteBySlug(slug);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    server.config.logger.error(`[api/skills] ${message}`);
    if (!res.headersSent) sendJson(res, 400, { error: message });
  }
}
