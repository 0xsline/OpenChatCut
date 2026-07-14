// Runnable: `npx tsx src/agent/project-tools.check.ts`
import assert from 'node:assert';
import { makeDraft } from '../editor/store';
import {
  docFromTimeline,
  resetProjectStoreMemory,
} from '../persist/projectStore';
import type { AgentContext } from './context';
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

// speaker action not implemented
const sp = await execProjectTool('edit_project', { action: 'speaker-create' }, ctx) as {
  error?: string;
};
assert.strictEqual(sp.error, 'not_implemented');

console.log('project-tools.check: ok');
