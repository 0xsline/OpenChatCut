// run_skill_script runs ffmpeg and ffprobe as the bundled builds, never only via PATH.
//
// The whitelist allowed `ffmpeg` and `ffprobe`, but execFile looked them up through the
// user's PATH, which packaged installs rarely have (a macOS app opened from Finder or the
// Dock inherits only /usr/bin:/bin:/usr/sbin:/sbin), so they failed with ENOENT. A skill
// script calling ffmpeg by name from node or bash failed the same way. Both run here with
// a PATH that reaches node but holds no ffmpeg or ffprobe.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
interface ExecResult { ok?: boolean; stdout?: string; stderr?: string; error?: string }

const ENV_KEYS = [
  'PATH', 'OPENCHATCUT_DATA_DIR', 'OPENCHATCUT_DEV_PROFILE_ID', 'OPENCHATCUT_FFMPEG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const root = await mkdtemp(join(tmpdir(), 'occ-skill-exec-'));
process.env.OPENCHATCUT_DATA_DIR = join(root, 'data');
process.env.OPENCHATCUT_DEV_PROFILE_ID = '4f0c9a7e-2b6d-4c1a-9e8f-3d5b7a1c6e20';
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) delete process.env[key];

/** A PATH entry that runs node but has no ffmpeg or ffprobe in it. */
async function nodeOnlyPath(): Promise<string> {
  const nodeDir = dirname(process.execPath);
  const shadowed = ['ffmpeg', 'ffprobe'].some((name) => (
    ['', '.exe'].some((ext) => existsSync(join(nodeDir, `${name}${ext}`)))
  ));
  if (!shadowed) return nodeDir;
  const shim = join(root, 'node-only-bin');
  await mkdir(shim, { recursive: true });
  await symlink(process.execPath, join(shim, basename(process.execPath)));
  return shim;
}

let app: Server | undefined;
try {
  const skillsRoot = join(root, 'skills');
  const skillDir = join(skillsRoot, 'media-demo');
  await mkdir(join(skillDir, 'scripts'), { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: media-demo\ndescription: fixture\n---\n');
  // Calls both tools by bare name, the way third-party skill scripts do.
  await writeFile(join(skillDir, 'scripts', 'versions.mjs'), [
    "import { execFileSync } from 'node:child_process';",
    "for (const tool of ['ffmpeg', 'ffprobe']) {",
    "  console.log(execFileSync(tool, ['-version'], { encoding: 'utf8' }).split('\\n')[0]);",
    '}',
  ].join('\n'));

  const { seedKeystore } = await import('../keystore.ts');
  seedKeystore({ OPENCHATCUT_SKILLS_DIR: skillsRoot });
  const { skillExecPlugin, skillProcessPath } = await import('./skill-exec.ts');

  let route: Middleware | undefined;
  const hook = skillExecPlugin().configureServer;
  const configureServer = typeof hook === 'function' ? hook : hook?.handler;
  assert.ok(configureServer, 'skillExecPlugin registers a configureServer hook');
  await configureServer.call({} as never, {
    config: { logger: { error() {} } },
    middlewares: { use(path: string, handler: Middleware) { if (path === '/api/skills') route = handler; } },
  } as never);
  assert.ok(route, 'the skill exec route is registered');
  app = createServer((req, res) => route?.(req, res, () => { res.statusCode = 404; res.end(); }));
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const address = app.address();
  assert(address && typeof address === 'object');
  const exec = async (command: string): Promise<ExecResult> => {
    const response = await fetch(`http://127.0.0.1:${address.port}/media-demo/exec`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    assert.equal(response.status, 200);
    return await response.json() as ExecResult;
  };

  process.env.PATH = await nodeOnlyPath();
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const result = await exec(`${tool} -version`);
    assert.equal(result.ok, true, `${tool} as the command: ${result.error ?? result.stderr}`);
    assert.match(result.stdout ?? '', new RegExp(`^${tool} version`));
  }
  const script = await exec('node scripts/versions.mjs');
  assert.equal(script.ok, true, `a script calling ffmpeg/ffprobe by name: ${script.error ?? script.stderr}`);
  assert.match(script.stdout ?? '', /^ffmpeg version[^\n]*\nffprobe version/);

  // The user's own entries keep their order behind the bundled directories.
  const entries = skillProcessPath(['/first', '/second'].join(delimiter)).split(delimiter);
  assert.deepEqual(entries.slice(-2), ['/first', '/second']);
  assert.ok(entries.slice(0, -2).length > 0 && entries.slice(0, -2).every((entry) => isAbsolute(entry)));
  // A bare-name override has no directory to add, and must never become a relative entry.
  process.env.OPENCHATCUT_FFMPEG = 'ffmpeg';
  assert.ok(skillProcessPath('/only').split(delimiter).every((entry) => isAbsolute(entry)),
    'a bare ffmpeg override must not put "." on the skill PATH');
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (app) await new Promise((resolve) => app?.close(resolve));
  await rm(root, { recursive: true, force: true });
}

console.log('skill exec bundled ffmpeg/ffprobe verification passed');
