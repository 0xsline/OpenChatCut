// End-to-end verify for `occ`: every assertion drives the installed entry point
// in a child process against a throwaway library, so argv parsing, profile
// resolution, the store, the offline edit session and the commit path are all
// exercised the way a user exercises them.
//
// What it pins down (each one is a behavior a plausible bug would break):
//   * a fresh library reports no projects, and `project new` makes one;
//   * reads never mutate: an edit tool without --apply leaves the project identical;
//   * --apply commits, and the canvas really changes;
//   * a committed edit snapshots a pre-edit version, so the app can undo it;
//   * browser-only tools are refused, with a non-zero exit code;
//   * unknown flags and unknown projects fail loudly instead of silently no-oping.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT_PROJECT_VERSION } from '../shared/project-version.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = join(ROOT, 'cli', 'main.ts');
const HOME = mkdtempSync(join(tmpdir(), 'occ-cli-'));
const LIBRARY = join(HOME, 'library');
const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  OPENCHATCUT_DATA_DIR: LIBRARY,
};
// An empty-string profile id is rejected by runtime-profile (it validates the
// value when the variable is present), so remove it instead of blanking it.
delete ENV.OPENCHATCUT_DEV_PROFILE_ID;
// The verifier's own process must read the throwaway library as well: the store
// resolves its paths when runtime-profile.ts is first imported (further down), and
// without this the in-process store would read — and could create — the real one.
Object.assign(process.env, ENV);
delete process.env.OPENCHATCUT_DEV_PROFILE_ID;

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function occ(args: readonly string[]): RunResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', MAIN, ...args], {
    cwd: ROOT,
    env: ENV,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function occOk(args: readonly string[]): string {
  const result = occ(args);
  assert.equal(result.status, 0, `occ ${args.join(' ')} exited ${result.status}:\n${result.stderr}`);
  return result.stdout;
}

function occJson<T>(args: readonly string[]): T {
  const stdout = occOk(args);
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`occ ${args.join(' ')} did not print JSON:\n${stdout}`);
  }
}

interface ProjectJson {
  readonly id: string;
  readonly name: string;
}

interface TimelineJson {
  readonly activeTimelineId: string;
  readonly timelines: readonly { id: string; width: number; height: number; fps: number; itemCount: number }[];
}

interface ToolJson {
  readonly name: string;
  readonly headless: boolean;
}

interface CallJson {
  readonly applied: boolean;
  readonly ops: readonly { readonly tool: string; readonly result: unknown }[];
}

function activeTimelineSize(projectId: string): { width: number; height: number; fps: number } {
  const view = occJson<TimelineJson>(['timeline', 'show', projectId, '--json']);
  const timeline = view.timelines.find((candidate) => candidate.id === view.activeTimelineId);
  assert.ok(timeline, 'the active timeline must be listed');
  return { width: timeline.width, height: timeline.height, fps: timeline.fps };
}

try {
  // The literal in cli/profile.ts mirrors the server's env name; drift here would
  // silently point --data-dir at nothing. Both imports below are dynamic on purpose:
  // static ones would resolve the store's paths (and the active profile) before the
  // throwaway HOME/DATA_DIR above could take effect.
  const runtimeProfile = await import('../server/runtime-profile.ts');
  assert.equal(runtimeProfile.DATA_DIR_ENV, 'OPENCHATCUT_DATA_DIR');

  // 1. empty library
  assert.deepEqual(occJson<ProjectJson[]>(['project', 'list', '--json']), []);

  // 2. create
  const created = occJson<ProjectJson>(['project', 'new', 'CLI Verify', '--size', '1920x1080', '--json']);
  assert.equal(created.name, 'CLI Verify');
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(occJson<ProjectJson[]>(['project', 'list', '--json']).length, 1);

  // 3. the new project renders as an empty 16:9 timeline
  assert.deepEqual(activeTimelineSize(created.id), { width: 1920, height: 1080, fps: 30 });

  // 4. the tool list tells the truth about what is headless
  const headless = occJson<ToolJson[]>(['tools', 'ls', '--json']);
  assert.ok(headless.some((tool) => tool.name === 'read_project'), 'read_project must be headless');
  assert.ok(headless.some((tool) => tool.name === 'set_aspect_ratio'), 'set_aspect_ratio must be headless');
  assert.ok(!headless.some((tool) => tool.name === 'import_media'), 'import_media is browser-backed');
  const all = occJson<ToolJson[]>(['tools', 'ls', '--all', '--json']);
  const importMedia = all.find((tool) => tool.name === 'import_media');
  assert.ok(importMedia && importMedia.headless === false, '--all must list browser-backed tools as such');
  assert.ok(all.length > headless.length, '--all must be a superset');

  // 5. a read tool runs without committing
  const read = occJson<CallJson>(['tools', 'call', 'read_project', '--project', created.id, '--json']);
  assert.equal(read.applied, false);
  assert.ok(read.ops[0]?.result, 'read_project must return a payload');

  // 6. an edit without --apply is discarded: the draft ran, the project did not move
  const drafted = occJson<CallJson>([
    'tools', 'call', 'set_aspect_ratio', '--args', '{"ratio":"9:16"}', '--project', created.id, '--json',
  ]);
  assert.equal(drafted.applied, false);
  assert.deepEqual(activeTimelineSize(created.id), { width: 1920, height: 1080, fps: 30 });

  // 7. --apply commits the same edit
  const applied = occJson<CallJson>([
    'tools', 'call', 'set_aspect_ratio', '--args', '{"ratio":"9:16"}', '--project', created.id,
    '--apply', '--summary', 'occ verify', '--json',
  ]);
  assert.equal(applied.applied, true);
  assert.deepEqual(activeTimelineSize(created.id), { width: 1080, height: 1920, fps: 30 });

  // 8. the commit snapshots a pre-edit version, so the app can undo it
  // (dynamic import for the same profile-resolution reason as above)
  const store = await import('../server/plugins/project-store.ts');
  const versions = await store.getStoredEntry(`versions:${created.id}`);
  assert.equal(versions.found, true);
  const automatic = (Array.isArray(versions.value) ? versions.value : [])
    .filter((entry): entry is { automatic?: boolean; doc?: { timelines?: { width?: number }[] } } => (
      !!entry && typeof entry === 'object'
    ))
    .filter((entry) => entry.automatic === true);
  assert.ok(automatic.length >= 1, 'a committed offline edit must snapshot a pre-edit version');
  assert.equal(automatic[0]?.doc?.timelines?.[0]?.width, 1920, 'the snapshot must hold the pre-edit canvas');

  // 9. several ops in one commit: the batch lands atomically, both effects visible
  const batch = occJson<CallJson>(['edit',
    '--ops', '[{"tool":"set_aspect_ratio","args":{"ratio":"16:9"}},'
      + '{"tool":"update_watermark","args":{"enabled":true,"text":"occ","position":"br"}}]',
    '--project', created.id, '--apply', '--json',
  ]);
  assert.equal(batch.applied, true);
  assert.deepEqual(activeTimelineSize(created.id), { width: 1920, height: 1080, fps: 30 });
  const docView = occJson<{ doc: { timelines: { watermark?: { enabled?: boolean; text?: string } }[] } }>(
    ['project', 'show', created.id, '--doc', '--json'],
  );
  assert.equal(docView.doc.timelines[0]?.watermark?.text, 'occ', 'both ops must land in the same commit');

  // 10. clip edits: the item sugar commands map onto allowlisted tools
  const fixtureTimelineId = 'tl_cli_verify';
  await store.setStoredEntry(`project:${created.id}`, {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: fixtureTimelineId,
    timelines: [{
      id: fixtureTimelineId,
      name: 'Verify',
      order: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      items: [{
        id: 'clip-fixture',
        track: 'track_v1',
        startFrame: 0,
        durationInFrames: 90,
        name: 'Fixture',
        kind: 'solid',
      }],
      selectedId: null,
      trackOrder: ['track_v1'],
      tracks: { track_v1: { kind: 'video' } },
    }],
  });
  const items = (): { id: string; startFrame: number; durationFrames: number }[] => (
    occJson<{ items: { id: string; startFrame: number; durationFrames: number }[] }>(
      ['timeline', 'items', created.id, '--json'],
    ).items
  );
  const fixture = (): { id: string; startFrame: number; durationFrames: number } | undefined => (
    items().find((item) => item.id === 'clip-fixture')
  );
  assert.equal(fixture()?.durationFrames, 90, 'fixture clip must be readable through the CLI');

  // preview: without --apply the draft is discarded and the clip does not move
  const preview = occJson<CallJson>(['item', 'move', 'clip-fixture', '--start', '90', '--json']);
  assert.equal(preview.applied, false);
  assert.equal(fixture()?.startFrame, 0);

  occOk(['item', 'trim', 'clip-fixture', '--start', '15', '--duration', '2s', '--apply']);
  assert.equal(fixture()?.startFrame, 15);
  assert.equal(fixture()?.durationFrames, 60, '2s at 30fps is 60 frames');

  occOk(['item', 'dup', 'clip-fixture', '--apply']);
  assert.equal(items().length, 2, 'duplicate_item appends a copy under a new id');

  occOk(['item', 'split', 'clip-fixture', '--at', '45', '--apply']);
  assert.equal(items().length, 3, 'split_item replaces one clip with two');

  occOk(['item', 'rm', 'clip-fixture', '--apply']);
  assert.equal(items().length, 2, 'remove_item drops exactly one clip');

  // 11. GL-backed tools: edit_item and manage_effects run headless
  const catalogTools = occJson<ToolJson[]>(['tools', 'ls', '--json']);
  assert.ok(catalogTools.some((tool) => tool.name === 'edit_item'), 'edit_item must be headless');
  assert.ok(catalogTools.some((tool) => tool.name === 'manage_effects'), 'manage_effects must be headless');
  const effects = occJson<CallJson>([
    'tools', 'call', 'manage_effects', '--args', '{"action":"list"}', '--project', created.id, '--json',
  ]);
  const effectResult = effects.ops[0]?.result as
    | { effects?: unknown[]; archived?: boolean }
    | undefined;
  assert.ok(
    effectResult?.archived === true || (effectResult?.effects?.length ?? 0) > 10,
    'the GL effect catalog must load in this process (large results come back archived)',
  );
  const target = items()[0]?.id;
  assert.ok(target, 'a clip must survive the remove step');
  occOk([
    'tools', 'call', 'edit_item',
    '--args', `{"updates":[{"type":"solid","itemId":"${target}","transform":{"opacity":0.42}}]}`,
    '--project', created.id, '--apply',
  ]);
  const edited = occJson<{ doc: { timelines: { items: { id: string; transform?: { opacity?: number } }[] }[] } }>(
    ['project', 'show', created.id, '--doc', '--json'],
  );
  const editedClip = edited.doc.timelines[0]?.items.find((item) => item.id === target);
  assert.equal(editedClip?.transform?.opacity, 0.42, 'edit_item must write through the offline session');

  // 12. catalog tools read the bundled registries, not empty arrays
  const templateList = occJson<CallJson>(['tools', 'call', 'list_templates', '--args', '{}', '--project', created.id, '--json']);
  const templateResult: unknown = templateList.ops[0]?.result;
  const templateTotal = templateResult !== null && typeof templateResult === 'object'
    && 'total' in templateResult && typeof templateResult.total === 'number'
    ? templateResult.total
    : 0;
  assert.ok(templateTotal > 100, `the bundled template catalog must reach the offline context (got ${templateTotal})`);

  const audioList = occJson<CallJson>(['tools', 'call', 'list_audio', '--args', '{}', '--project', created.id, '--json']);
  const audioResult: unknown = audioList.ops[0]?.result;
  const builtinAudio = Array.isArray(audioResult)
    ? audioResult.filter((entry) => (
      entry !== null && typeof entry === 'object' && 'source' in entry && entry.source === 'builtin'
    ))
    : [];
  assert.ok(builtinAudio.length > 0, 'the built-in audio library must reach the offline context');

  const searchResult: unknown = occJson<CallJson>([
    'tools', 'call', 'search_templates', '--args', '{"query":"title"}', '--project', created.id, '--json',
  ]).ops[0]?.result;
  const hits = Array.isArray(searchResult)
    ? searchResult.filter((entry): entry is { name: string } => (
      entry !== null && typeof entry === 'object' && 'name' in entry && typeof entry.name === 'string'
    ))
    : [];
  assert.ok(hits.length > 0, 'search_templates must find bundled templates');

  const beforeAdd = items().length;
  occOk([
    'tools', 'call', 'add_motion_graphic',
    '--args', JSON.stringify({ templateName: hits[0]?.name, track: 'V1' }),
    '--project', created.id, '--apply',
  ]);
  assert.equal(items().length, beforeAdd + 1, 'add_motion_graphic must place a bundled template headlessly');

  // 13. media ls reads the pool without touching it
  const media = occJson<{ assets: unknown[] }>(['media', 'ls', created.id, '--json']);
  assert.deepEqual(media.assets, []);

  // 14. browser-backed tools are refused, and the failure is observable
  const refused = occ(['tools', 'call', 'import_media', '--args', '{}', '--project', created.id]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /headless tool subset/);

  // 15. bad references and bad flags fail loudly
  const missingProject = occ(['timeline', 'show', 'no-such-project']);
  assert.equal(missingProject.status, 1);
  assert.match(missingProject.stderr, /No project matches/);
  const unknownFlag = occ(['project', 'list', '--wat']);
  assert.equal(unknownFlag.status, 2);
  assert.match(unknownFlag.stderr, /unknown flag --wat/);

  // 16. an installed plugin pack reaches the headless catalog too
  const packId = 'occ-fixture-pack';
  const packVersion = '1.0.0';
  const packRoot = join(HOME, '.openchatcut', 'plugins');
  const packDir = join(packRoot, packId, Buffer.from(packVersion, 'utf8').toString('base64url'));
  mkdirSync(packDir, { recursive: true });
  const installedAt = Date.now();
  writeFileSync(
    join(packRoot, 'index.json'),
    JSON.stringify([{ id: packId, version: packVersion, enabled: true, installedAt }]),
  );
  writeFileSync(join(packDir, 'manifest.json'), JSON.stringify({
    format: 'openchatcut-plugin@1',
    id: packId,
    name: 'Occ fixture pack',
    version: packVersion,
    installedAt,
    enabled: true,
    items: [{
      id: 'fixture-card',
      type: 'mg-template',
      name: 'Occ Fixture Card',
      code: 'const Card = () => null;',
      props: {},
      durationInFrames: 90,
    }],
  }));
  const packHits = occJson<CallJson>([
    'tools', 'call', 'search_templates', '--args', '{"query":"Occ Fixture"}', '--project', created.id, '--json',
  ]).ops[0]?.result;
  const packTemplates = Array.isArray(packHits)
    ? packHits.filter((entry): entry is { name: string } => (
      entry !== null && typeof entry === 'object' && 'name' in entry && typeof entry.name === 'string'
    ))
    : [];
  assert.deepEqual(
    packTemplates.map((entry) => entry.name),
    ['Occ Fixture Card'],
    'installed packs must feed the headless template catalog, not just the renderer',
  );

  process.stdout.write('occ cli verify: ok\n');
} finally {
  rmSync(HOME, { recursive: true, force: true });
}
