// Runnable: `npx tsx src/agent/project-tools.check.ts`
import assert from 'node:assert';
import { makeDraft } from '../../editor/store';
import {
  docFromTimeline,
  resetProjectStoreMemory,
} from '../../persist/projectStore';
import type { AgentContext } from '../context';
import {
  PROJECT_TOOL_NAMES,
  PROJECT_TOOL_SCHEMAS,
  buildEditorUrl,
  emptyProjectDoc,
  execProjectTool,
} from './project-tools';

const expected = [
  'list_projects',
  'create_project',
  'delete_project',
  'restore_project',
  'duplicate_project',
  'edit_project',
  'target_project',
  'get_editor_url',
].sort();
assert.deepStrictEqual(PROJECT_TOOL_SCHEMAS.map((t) => t.name).sort(), expected);
for (const n of expected) assert.ok(PROJECT_TOOL_NAMES.has(n));

assert.ok(buildEditorUrl('abc', 'http://localhost:5199/').endsWith('#/editor/abc'));
assert.ok(buildEditorUrl('abc', 'http://localhost:5199').includes('#/editor/abc'));

const empty = emptyProjectDoc({ width: 1280, height: 720, fps: 24 });
assert.strictEqual(empty.version, 2);
assert.strictEqual(empty.timelines[0]!.width, 1280);
assert.strictEqual(empty.timelines[0]!.fps, 24);

resetProjectStoreMemory();

let opened: string | null = null;
let renamed: string | null = null;
const draft = makeDraft(docFromTimeline({
  fps: 30, width: 1920, height: 1080, items: [], selectedId: null, assets: [],
}));
const ctx: AgentContext = {
  commands: draft.commands,
  getState: draft.getState,
  getDoc: draft.getDoc,
  getCreativeMode: () => null,
  templates: [],
  audio: [],
  getProjectId: () => opened ?? 'none',
  openProject: async (id) => { opened = id; return { ok: true }; },
  onProjectRenamed: (n) => { renamed = n; },
};

const created = await execProjectTool('create_project', {
  name: 'Alpha',
  compositionWidth: 1080,
  compositionHeight: 1920,
  fps: 30,
  editorBaseUrl: 'http://test.local/',
}, ctx) as { ok: boolean; projectId: string; editorUrl: string };
assert.strictEqual(created.ok, true);
assert.ok(created.projectId);
assert.ok(created.editorUrl.includes(created.projectId));

const listed = await execProjectTool('list_projects', { editorBaseUrl: 'http://test.local/' }, ctx) as {
  count: number;
  projects: Array<{ id: string; name: string; editorUrl: string }>;
};
assert.strictEqual(listed.count, 1);
assert.strictEqual(listed.projects[0]!.name, 'Alpha');

const url = await execProjectTool('get_editor_url', {
  projectId: created.projectId,
  editorBaseUrl: 'http://test.local',
}, ctx) as { ok: boolean; editorUrl: string };
assert.strictEqual(url.ok, true);
assert.ok(url.editorUrl.includes('#/editor/'));

// target opens
opened = null;
const targeted = await execProjectTool('target_project', { projectId: created.projectId }, ctx) as {
  ok: boolean; opened: boolean; projectId: string;
};
assert.strictEqual(targeted.ok, true);
assert.strictEqual(targeted.opened, true);
assert.strictEqual(opened, created.projectId);

// edit name (current project)
const edited = await execProjectTool('edit_project', {
  action: 'update',
  json: JSON.stringify({ name: 'Alpha Renamed', description: 'hi' }),
  projectId: created.projectId,
}, ctx) as { ok: boolean; name: string };
assert.strictEqual(edited.ok, true);
assert.strictEqual(edited.name, 'Alpha Renamed');
assert.strictEqual(renamed, 'Alpha Renamed');

// duplicate without activate
const dup = await execProjectTool('duplicate_project', {
  projectId: created.projectId,
  name: 'Beta',
  activate: false,
}, ctx) as { ok: boolean; newProjectId: string; activated: boolean };
assert.strictEqual(dup.ok, true);
assert.strictEqual(dup.activated, false);
assert.notStrictEqual(dup.newProjectId, created.projectId);

// soft delete requires explicit id — refuse empty
const delBad = await execProjectTool('delete_project', {}, ctx) as { error?: string };
assert.ok(delBad.error);

const del = await execProjectTool('delete_project', { projectId: created.projectId }, ctx) as {
  ok: boolean; softDeleted: boolean;
};
assert.strictEqual(del.ok, true);
assert.strictEqual(del.softDeleted, true);

const activeList = await execProjectTool('list_projects', {}, ctx) as { count: number };
assert.strictEqual(activeList.count, 1); // only Beta remains

const withDeleted = await execProjectTool('list_projects', { includeDeleted: true }, ctx) as {
  count: number;
  projects: Array<{ id: string; deletionState: string }>;
};
assert.strictEqual(withDeleted.count, 2);
assert.ok(withDeleted.projects.some((p) => p.id === created.projectId && p.deletionState === 'deleted'));

const restored = await execProjectTool('restore_project', { projectId: created.projectId }, ctx) as {
  ok: boolean; projectId: string;
};
assert.strictEqual(restored.ok, true);
const afterRestore = await execProjectTool('list_projects', {}, ctx) as { count: number };
assert.strictEqual(afterRestore.count, 2);

// speaker-create/delete → graceful unsupported (no speaker roster in this build)
const spc = await execProjectTool('edit_project', { action: 'speaker-create' }, ctx) as { unsupported?: boolean; note?: string; error?: string };
assert.strictEqual(spc.unsupported, true, 'speaker-create is gracefully unsupported');
assert.strictEqual(spc.error, undefined, 'speaker-create no longer hard-errors not_implemented');
assert.ok(spc.note);

// speaker-update → project-wide relabel across all transcribed clips
const spDraft = makeDraft(docFromTimeline({
  fps: 30, width: 1920, height: 1080, selectedId: null, assets: [],
  items: [
    { id: 'c1', track: 'V1', startFrame: 0, durationInFrames: 60, kind: 'video', name: 'a', src: '/a.mp4',
      transcript: [{ text: 'hi', start: 0, end: 500, speaker: 'A' }, { text: 'yo', start: 500, end: 1000, speaker: 'B' }] },
    { id: 'c2', track: 'V1', startFrame: 60, durationInFrames: 60, kind: 'video', name: 'b', src: '/b.mp4',
      transcript: [{ text: 'ok', start: 0, end: 500, speaker: 'A' }] },
  ],
}));
const spCtx: AgentContext = { ...ctx, commands: spDraft.commands, getState: spDraft.getState, getDoc: spDraft.getDoc, getProjectId: () => 'p1' };
const su = await execProjectTool('edit_project', { action: 'speaker-update', from: 'A', to: '主持人' }, spCtx) as { ok?: boolean; itemsChanged?: number; wordsChanged?: number };
assert.strictEqual(su.ok, true, 'speaker-update succeeds');
assert.strictEqual(su.itemsChanged, 2, 'relabels speaker A in both clips');
assert.strictEqual(su.wordsChanged, 2, 'two words were speaker A');
const st = spDraft.getState();
assert.strictEqual(st.items.find((i) => i.id === 'c1')!.transcript!.find((w) => w.text === 'hi')!.speaker, '主持人', 'A→主持人 applied');
assert.strictEqual(st.items.find((i) => i.id === 'c1')!.transcript!.find((w) => w.text === 'yo')!.speaker, 'B', 'B untouched; only from-speaker words change');
assert.ok((await execProjectTool('edit_project', { action: 'speaker-update', from: 'Z', to: 'x' }, spCtx) as { error?: string }).error, 'unknown speaker errors');
assert.ok((await execProjectTool('edit_project', { action: 'speaker-update', from: 'A' }, spCtx) as { error?: string }).error, 'missing to errors');

// Top-level `id` is the speaker id and aliases from/json.id.
const suById = await execProjectTool('edit_project', { action: 'speaker-update', id: 'B', to: '嘉宾' }, spCtx) as { ok?: boolean; from?: string; wordsChanged?: number };
assert.strictEqual(suById.ok, true, 'speaker-update accepts top-level id as the speaker locator');
assert.strictEqual(suById.from, 'B', 'id resolved as the from-speaker');
assert.strictEqual(suById.wordsChanged, 1, 'the one B word relabeled');
assert.strictEqual(spDraft.getState().items.find((i) => i.id === 'c1')!.transcript!.find((w) => w.text === 'yo')!.speaker, '嘉宾', 'B→嘉宾 via id');
// edit_project schema exposes the `id` field.
const epSchema = PROJECT_TOOL_SCHEMAS.find((t) => t.name === 'edit_project')!;
assert.ok('id' in (epSchema.input_schema as { properties: Record<string, unknown> }).properties, 'edit_project schema has top-level id');

console.log('project-tools.check: ok');
