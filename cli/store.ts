// Read side of the CLI: the same project library the app and the MCP server use,
// through the same entry points (server/plugins/project-store.ts for documents,
// server/external-agent/projects.ts for the project index). No second store, no
// second index, no cached copy.
//
// Reads deliberately do not go through an edit session: an offline session claims
// project ownership and would refuse while the editor has the project open. Reading
// a document is not a mutation, so `occ` reads the store directly and normalizes
// with the same migration chain the runtime uses (see normalizedProject in
// server/external-agent/offline-project-store.ts).
import { getStoredEntry } from '../server/plugins/project-store.ts';
import { createExternalProject, listExternalProjects } from '../server/external-agent/projects.ts';
import { runProjectMigrations } from '../src/persist/migrations/index.ts';
import type { ProjectDoc } from '../src/editor/types.ts';
import { CliError } from './errors.ts';

export interface ProjectHandle {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly description?: string;
  readonly deletedAt?: number;
}

export async function listProjects(includeDeleted = false): Promise<ProjectHandle[]> {
  const projects = await listExternalProjects(includeDeleted);
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    updatedAt: project.updatedAt,
    ...(project.description ? { description: project.description } : {}),
    ...(project.deletedAt ? { deletedAt: project.deletedAt } : {}),
  }));
}

function candidates(projects: readonly ProjectHandle[]): string {
  return projects
    .slice(0, 10)
    .map((project) => `  ${project.id}  ${project.name}`)
    .join('\n');
}

/**
 * Resolve a user-typed project reference: exact id, unique id prefix, or unique
 * name. Ambiguity is an error listing the candidates — guessing which project a
 * prefix meant is how a CLI edits the wrong timeline.
 */
export async function resolveProject(reference?: string): Promise<ProjectHandle> {
  const projects = await listProjects();
  if (projects.length === 0) {
    throw new CliError('No projects yet. Create one: occ project new "My project"');
  }
  if (reference === undefined) return projects[0] as ProjectHandle;

  const exact = projects.find((project) => project.id === reference);
  if (exact) return exact;

  const byPrefix = projects.filter((project) => project.id.startsWith(reference));
  if (byPrefix.length === 1) return byPrefix[0] as ProjectHandle;
  if (byPrefix.length > 1) {
    throw new CliError(`Project id prefix "${reference}" is ambiguous:\n${candidates(byPrefix)}`);
  }

  const byName = projects.filter((project) => project.name === reference);
  if (byName.length === 1) return byName[0] as ProjectHandle;
  if (byName.length > 1) {
    throw new CliError(`Project name "${reference}" is ambiguous:\n${candidates(byName)}`);
  }

  throw new CliError(`No project matches "${reference}".\n${candidates(projects)}`);
}

export async function readProjectDoc(projectId: string): Promise<ProjectDoc> {
  const entry = await getStoredEntry(`project:${projectId}`);
  if (!entry.found) throw new CliError(`Project ${projectId} has no stored document.`);
  const migrated = runProjectMigrations(entry.value);
  if (!migrated) {
    throw new CliError(`Project ${projectId} has an unsupported or corrupt document; open it once in the app.`);
  }
  return migrated.doc;
}

export interface NewProjectInput {
  readonly name: string;
  readonly fps?: number;
  readonly width?: number;
  readonly height?: number;
  readonly description?: string;
}

export async function createProject(input: NewProjectInput): Promise<ProjectHandle> {
  const created = await createExternalProject({
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    ...(input.fps ? { fps: input.fps } : {}),
    ...(input.width ? { compositionWidth: input.width } : {}),
    ...(input.height ? { compositionHeight: input.height } : {}),
  });
  return { id: created.id, name: created.name, updatedAt: created.updatedAt };
}
