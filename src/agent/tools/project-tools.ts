import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { ProjectDoc, TimelineState } from '../../editor/types';
import {
  docFromTimeline,
  listProjects,
  loadProject,
  createProject,
  updateProjectMeta,
  duplicateProject,
  deleteProject,
  restoreProject,
  type ProjectMeta,
} from '../../persist/projectStore';

// Local-first MCP project session tools:
// create/list/delete/duplicate/edit/restore/target_project + get_editor_url.
// Soft-deleted data stays in IDB, with an in-memory fallback for tests.

type Args = Record<string, unknown>;

export const PROJECT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'list_projects',
    description: [
      'List OpenChatCut projects this browser owns (id, name, updatedAt, editorUrl), newest first.',
      'Discovery only — does not retarget the editor. Call target_project before editing another project.',
      'Pass includeDeleted=true to also list soft-deleted projects for restore_project.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        editorBaseUrl: { type: 'string', description: 'Origin for returned URLs; defaults to location.origin.' },
        includeDeleted: { type: 'boolean', description: 'Include soft-deleted projects (default false).' },
      },
    },
  },
  {
    name: 'create_project',
    description: [
      'Create a new empty project (one timeline, one video track) and return projectId + editorUrl.',
      'Does not auto-open unless you call target_project with the returned id.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (default: random or "new project").' },
        description: { type: 'string' },
        compositionWidth: { type: 'number', description: 'Default 1920.' },
        compositionHeight: { type: 'number', description: 'Default 1080.' },
        fps: { type: 'number', description: 'Default 30.' },
        editorBaseUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'delete_project',
    description: [
      'Soft-delete a project (same as dashboard delete). Hidden from list_projects; restore with restore_project.',
      'Requires explicit projectId — never defaults to the current project.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Full project id from list_projects or editor URL.' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'restore_project',
    description: 'Restore a soft-deleted project so it reappears in list_projects / dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        editorBaseUrl: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'duplicate_project',
    description: [
      'Full-copy a project (timelines, assets, captions). Chat history is not copied.',
      'activate=true (default) navigates the editor to the new copy when openProject is available.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Source project id; defaults to current project.' },
        name: { type: 'string', description: 'Copy display name; default "[Copy] <source>".' },
        activate: { type: 'boolean', description: 'Open the copy in the editor (default true).' },
        editorBaseUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'edit_project',
    description: [
      'Update project-level settings or speakers. action=update: change name/description via json {"name"?, "description"?}.',
      'action=speaker-update: project-wide rename/merge a speaker — {from:"A", to:"new name"} relabels every word of that speaker across all transcribed clips in the open project.',
      'speaker-create/speaker-delete are unsupported here (no speaker roster — speakers are per-word diarization labels); use speaker-update to relabel, or manage_transcript fix per clip.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'speaker-create', 'speaker-update', 'speaker-delete'],
        },
        id: { type: 'string', description: 'Speaker ID (for speaker ops) — the existing diarization label to target (alias of from / json.id).' },
        from: { type: 'string', description: 'speaker-update: existing speaker label to rename (e.g. "A").' },
        to: { type: 'string', description: 'speaker-update: new speaker name.' },
        json: { type: 'string', description: 'update: {name?, description?}. speaker-update also accepts {from,to} here.' },
        projectId: { type: 'string', description: 'Defaults to current project (speaker-update needs the open project).' },
      },
      required: ['action'],
    },
  },
  {
    name: 'target_project',
    description: [
      'Bind the session to an existing project and open it in the editor (hash navigate).',
      'Use after list_projects. Subsequent tools run against the newly opened project after reload.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id or unique prefix from list_projects.' },
        editorBaseUrl: { type: 'string' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'get_editor_url',
    description: [
      'Return the editor URL for the targeted or given projectId (origin + #/editor/<id>).',
      'Never invent hostnames — uses location.origin or editorBaseUrl.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        editorBaseUrl: { type: 'string' },
        openPricing: { type: 'boolean' },
        pricingSource: { type: 'string' },
      },
    },
  },
];

export const PROJECT_TOOL_NAMES = new Set(PROJECT_TOOL_SCHEMAS.map((t) => t.name));

/** Build a shareable editor URL (hash-router). */
export function buildEditorUrl(projectId: string, editorBaseUrl?: string): string {
  const base = (editorBaseUrl?.trim()
    || (typeof location !== 'undefined' && location.origin
      ? `${location.origin}${location.pathname || '/'}`
      : 'http://127.0.0.1:5200/')).replace(/\/$/, '');
  // path may already be / or /index.html — always append hash route
  return `${base}#/editor/${projectId}`;
}

function emptyState(opts: { width?: number; height?: number; fps?: number }): TimelineState {
  const width = typeof opts.width === 'number' && opts.width > 0 ? Math.round(opts.width) : 1920;
  const height = typeof opts.height === 'number' && opts.height > 0 ? Math.round(opts.height) : 1080;
  const fps = typeof opts.fps === 'number' && opts.fps > 0 ? opts.fps : 30;
  return {
    fps,
    width,
    height,
    items: [],
    selectedId: null,
    trackOrder: ['track_v1'],
    tracks: { track_v1: { kind: 'video' } },
  };
}

export function emptyProjectDoc(opts: { width?: number; height?: number; fps?: number } = {}): ProjectDoc {
  return docFromTimeline(emptyState(opts));
}

function currentProjectId(ctx: AgentContext): string | null {
  return ctx.getProjectId?.() ?? null;
}

async function resolveMeta(
  projectId: string | undefined | null,
  opts?: { includeDeleted?: boolean; allowMissing?: boolean },
): Promise<ProjectMeta | null> {
  const id = String(projectId ?? '').trim();
  if (!id) return null;
  const all = await listProjects({ includeDeleted: true });
  const exact = all.find((m) => m.id === id);
  if (exact) {
    if (!opts?.includeDeleted && exact.deletedAt) return null;
    return exact;
  }
  const matches = all.filter((m) => m.id.startsWith(id) && (opts?.includeDeleted || !m.deletedAt));
  if (matches.length === 1) return matches[0]!;
  return null;
}

function row(meta: ProjectMeta, editorBaseUrl?: string) {
  return {
    id: meta.id,
    name: meta.name,
    updatedAt: meta.updatedAt,
    description: meta.description ?? null,
    deletionState: meta.deletedAt ? 'deleted' : 'active',
    deletedAt: meta.deletedAt ?? null,
    editorUrl: buildEditorUrl(meta.id, editorBaseUrl),
  };
}

export async function execProjectTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  switch (name) {
    case 'list_projects':
      return execList(args);
    case 'create_project':
      return execCreate(args);
    case 'delete_project':
      return execDelete(args, ctx);
    case 'restore_project':
      return execRestore(args);
    case 'duplicate_project':
      return execDuplicate(args, ctx);
    case 'edit_project':
      return execEdit(args, ctx);
    case 'target_project':
      return execTarget(args, ctx);
    case 'get_editor_url':
      return execGetUrl(args, ctx);
    default:
      return { error: `unknown tool ${name}` };
  }
}

async function execList(args: Args): Promise<unknown> {
  const includeDeleted = args.includeDeleted === true;
  const base = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
  const projects = await listProjects({ includeDeleted });
  return {
    ok: true,
    count: projects.length,
    projects: projects.map((m) => row(m, base)),
  };
}

async function execCreate(args: Args): Promise<unknown> {
  const name = typeof args.name === 'string' && args.name.trim()
    ? args.name.trim()
    : 'new project';
  const description = typeof args.description === 'string' ? args.description : undefined;
  const doc = emptyProjectDoc({
    width: typeof args.compositionWidth === 'number' ? args.compositionWidth : undefined,
    height: typeof args.compositionHeight === 'number' ? args.compositionHeight : undefined,
    fps: typeof args.fps === 'number' ? args.fps : undefined,
  });
  const meta = await createProject(name, doc, description ? { description } : undefined);
  const base = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
  return {
    ok: true,
    projectId: meta.id,
    name: meta.name,
    editorUrl: buildEditorUrl(meta.id, base),
    timelineId: doc.activeTimelineId,
    note: 'Project created. Call target_project to open it in the editor.',
  };
}

async function execDelete(args: Args, ctx: AgentContext): Promise<unknown> {
  const projectId = String(args.projectId ?? '').trim();
  if (!projectId) return { error: 'projectId is required (never defaults to the current project)' };
  const meta = await resolveMeta(projectId, { includeDeleted: true });
  if (!meta) return { error: `project not found: ${projectId}` };
  if (meta.deletedAt) return { ok: true, projectId: meta.id, alreadyDeleted: true };
  await deleteProject(meta.id);
  const current = currentProjectId(ctx);
  return {
    ok: true,
    projectId: meta.id,
    softDeleted: true,
    wasCurrent: current === meta.id,
    note: current === meta.id
      ? 'Current project soft-deleted; navigate home or target another project.'
      : 'Soft-deleted. restore_project undoes this.',
  };
}

async function execRestore(args: Args): Promise<unknown> {
  const projectId = String(args.projectId ?? '').trim();
  if (!projectId) return { error: 'projectId is required' };
  const meta = await resolveMeta(projectId, { includeDeleted: true });
  if (!meta) return { error: `project not found: ${projectId}` };
  const restored = await restoreProject(meta.id);
  if (!restored) return { error: 'restore failed' };
  const base = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
  return {
    ok: true,
    projectId: restored.id,
    name: restored.name,
    editorUrl: buildEditorUrl(restored.id, base),
  };
}

async function execDuplicate(args: Args, ctx: AgentContext): Promise<unknown> {
  const srcId = String(args.projectId ?? currentProjectId(ctx) ?? '').trim();
  if (!srcId) return { error: 'projectId is required (or open a project first)' };
  const src = await resolveMeta(srcId, { includeDeleted: true });
  if (!src) return { error: `project not found: ${srcId}` };
  const name = typeof args.name === 'string' ? args.name : undefined;
  const copy = await duplicateProject(src.id, name);
  if (!copy) return { error: 'duplicate failed (project document missing?)' };
  const activate = args.activate !== false;
  const base = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
  let opened = false;
  if (activate && ctx.openProject) {
    const r = await ctx.openProject(copy.id);
    opened = r?.ok !== false;
  }
  return {
    ok: true,
    sourceProjectId: src.id,
    newProjectId: copy.id,
    name: copy.name,
    editorUrl: buildEditorUrl(copy.id, base),
    activated: opened,
    note: opened
      ? 'Copy opened in editor.'
      : activate
        ? 'Copy created; open editorUrl or call target_project to switch.'
        : 'Copy created; session still on source project.',
  };
}

/** speaker-update: project-wide speaker rename/merge. This build has no speaker ROSTER —
 *  speakers are per-word diarization labels (A/B/…) — so "update the speaker list" = relabel
 *  every word speaker===from → to across all transcribed clips in the open project:
 *  only word.speaker changes; timings/durations/word count untouched). Drafted like any edit. */
function execSpeakerUpdate(args: Args, ctx: AgentContext): unknown {
  const projectId = String(args.projectId ?? '').trim();
  const open = currentProjectId(ctx);
  if (projectId && open && projectId !== open) {
    return { error: "speaker-update relabels the OPEN project's transcripts; call target_project first (or omit projectId)." };
  }
  let json: Record<string, unknown> = {};
  if (typeof args.json === 'string' && args.json.trim()) {
    try { const o = JSON.parse(args.json); if (o && typeof o === 'object') json = o as Record<string, unknown>; } catch { /* ignore, fall back to top-level args */ }
  } else if (args.json && typeof args.json === 'object') json = args.json as Record<string, unknown>;

  // Top-level `id` is the speaker locator, equivalent to json.id.
  const from = String(args.from ?? args.id ?? json.from ?? json.speaker ?? json.id ?? '').trim();
  const to = String(args.to ?? json.to ?? json.name ?? json.newName ?? '').trim();
  if (!from || !to) return { error: 'speaker-update needs {from:"A", to:"new name"} — from = existing speaker label, to = new name' };
  const items = ctx.getState().items.filter((it) => it.transcript?.some((w) => w.speaker === from));
  if (!items.length) return { error: `no word labeled speaker "${from}" in this project`, hint: 'read_captions {words:true} / read_script show speaker labels' };
  let wordsChanged = 0;
  for (const it of items) {
    wordsChanged += it.transcript!.filter((w) => w.speaker === from).length;
    ctx.commands.renameSpeaker(it.id, from, to);
  }
  return { ok: true, action: 'speaker-update', from, to, itemsChanged: items.length, wordsChanged, note: 'project-wide relabel; only word.speaker changed.' };
}

async function execEdit(args: Args, ctx: AgentContext): Promise<unknown> {
  const action = String(args.action ?? '');
  if (action === 'speaker-update') return execSpeakerUpdate(args, ctx);
  if (action === 'speaker-create' || action === 'speaker-delete') {
    return {
      unsupported: true,
      action,
      note: 'this build has no project speaker roster — speakers are per-word diarization labels (A/B/…), not a managed list. A speaker with no words cannot be created, and delete would be an ambiguous destructive relabel. Use speaker-update {from,to} to rename/merge a speaker across the whole project, or manage_transcript action=fix {from,to} for one clip.',
    };
  }
  if (action.startsWith('speaker-')) return { error: `unknown speaker action ${action}`, supported: ['speaker-update'] };
  if (action !== 'update') return { error: `unknown action ${action}` };

  const projectId = String(args.projectId ?? currentProjectId(ctx) ?? '').trim();
  if (!projectId) return { error: 'projectId is required (or open a project first)' };
  const meta = await resolveMeta(projectId, { includeDeleted: true });
  if (!meta) return { error: `project not found: ${projectId}` };
  if (meta.deletedAt) return { error: 'project is soft-deleted; restore_project first' };

  let patch: { name?: string; description?: string | null } = {};
  if (typeof args.json === 'string' && args.json.trim()) {
    try {
      const parsed = JSON.parse(args.json) as Record<string, unknown>;
      if (typeof parsed.name === 'string') patch.name = parsed.name;
      if (parsed.description === null) patch.description = null;
      else if (typeof parsed.description === 'string') patch.description = parsed.description;
    } catch {
      return { error: 'json must be valid JSON object' };
    }
  }
  // also accept top-level name for convenience
  if (typeof args.name === 'string') patch.name = args.name;
  if (!patch.name && patch.description === undefined) {
    return { error: 'update requires json {name?, description?} or name' };
  }

  const next = await updateProjectMeta(meta.id, patch);
  if (!next) return { error: 'update failed' };
  // Notify live editor title if this is the open project
  if (currentProjectId(ctx) === next.id && patch.name && ctx.onProjectRenamed) {
    ctx.onProjectRenamed(patch.name);
  }
  return { ok: true, projectId: next.id, name: next.name, description: next.description ?? null };
}

async function execTarget(args: Args, ctx: AgentContext): Promise<unknown> {
  const q = String(args.projectId ?? '').trim();
  if (!q) return { error: 'projectId is required' };
  const meta = await resolveMeta(q);
  if (!meta) return { error: `project not found or deleted: ${q}` };
  const doc = await loadProject(meta.id);
  if (!doc) return { error: 'project document missing' };
  const base = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
  let opened = false;
  if (ctx.openProject) {
    const r = await ctx.openProject(meta.id);
    opened = r?.ok !== false;
  }
  return {
    ok: true,
    projectId: meta.id,
    name: meta.name,
    timelineId: doc.activeTimelineId,
    editorUrl: buildEditorUrl(meta.id, base),
    opened,
    note: opened
      ? 'Editor navigating to project (chat will rehydrate for that project).'
      : 'Target recorded via editorUrl; host should open the URL if navigation is unavailable.',
  };
}

async function execGetUrl(args: Args, ctx: AgentContext): Promise<unknown> {
  const q = String(args.projectId ?? currentProjectId(ctx) ?? '').trim();
  if (!q) {
    return {
      error: 'no project targeted — pass projectId or call list_projects / create_project first',
    };
  }
  const meta = await resolveMeta(q, { includeDeleted: true });
  if (!meta) return { error: `project not found: ${q}` };
  const base = typeof args.editorBaseUrl === 'string' ? args.editorBaseUrl : undefined;
  return {
    ok: true,
    projectId: meta.id,
    name: meta.name,
    editorUrl: buildEditorUrl(meta.id, base),
    openPricing: args.openPricing === true ? 'ignored' : undefined,
  };
}
