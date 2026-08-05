export { VERSION_TOOL_SCHEMAS, VERSION_TOOL_NAMES } from './schemas/version-tools';
import type { AgentContext } from '../context';
import {
  deleteVersion,
  listVersions,
  saveVersion,
  type ProjectVersion,
} from '../../persist/versionStore';

type Args = Record<string, unknown>;

function slimVersion(v: ProjectVersion) {
  return {
    id: v.id,
    name: v.name,
    createdAt: v.createdAt,
    automatic: v.automatic === true,
    timelines: v.doc.timelines.length,
    activeTimelineId: v.doc.activeTimelineId,
  };
}

function findVersion(versions: ProjectVersion[], ref: string): ProjectVersion | null {
  const q = ref.trim();
  if (!q) return null;
  const exact = versions.find((v) => v.id === q);
  if (exact) return exact;
  const hits = versions.filter((v) => v.id.startsWith(q) || v.name === q);
  return hits.length === 1 ? hits[0]! : null;
}

export async function execVersionTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_versions') return { error: `unknown tool ${name}` };
  const projectId = ctx.getProjectId?.();
  if (!projectId) return { error: 'manage_versions requires an open persisted project id' };

  const action = String(args.action ?? '');
  switch (action) {
    case 'list': {
      const versions = await listVersions(projectId);
      return {
        ok: true,
        count: versions.length,
        versions: versions.map(slimVersion),
        note: 'Use versionId from this list with restore or delete. Full project bodies are not listed.',
      };
    }
    case 'save': {
      const name = String(args.name ?? '').trim();
      if (!name) return { error: 'save requires name (checkpoint label)' };
      const version = await saveVersion(projectId, name, ctx.getDoc());
      return { ok: true, saved: slimVersion(version) };
    }
    case 'restore': {
      const ref = String(args.versionId ?? '').trim();
      if (!ref) return { error: 'restore requires versionId from list' };
      const versions = await listVersions(projectId);
      const version = findVersion(versions, ref);
      if (!version) {
        const ambiguous = versions.filter((v) => v.id.startsWith(ref) || v.name === ref);
        if (ambiguous.length > 1) {
          return { error: `ambiguous versionId ${ref}`, candidates: ambiguous.slice(0, 6).map(slimVersion) };
        }
        return { error: `version not found: ${ref}`, available: versions.slice(0, 12).map(slimVersion) };
      }
      if (args.confirm !== true) {
        return {
          needsConfirm: true,
          version: slimVersion(version),
          note: 'Restoring replaces the entire open project with this snapshot. Resend with confirm:true to apply.',
        };
      }
      const before = ctx.getDoc();
      ctx.commands.applyDoc(version.doc);
      return {
        ok: true,
        restored: slimVersion(version),
        note: before.activeTimelineId !== version.doc.activeTimelineId
          ? 'Active timeline switched to the snapshot\'s active sequence.'
          : 'Project document replaced with the named version.',
      };
    }
    case 'delete': {
      const ref = String(args.versionId ?? '').trim();
      if (!ref) return { error: 'delete requires versionId from list' };
      const versions = await listVersions(projectId);
      const version = findVersion(versions, ref);
      if (!version) return { error: `version not found: ${ref}` };
      await deleteVersion(projectId, version.id);
      return { ok: true, deleted: slimVersion(version) };
    }
    default:
      return { error: `unknown action ${action}; use list/save/restore/delete` };
  }
}
