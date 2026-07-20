import { randomUUID } from 'node:crypto';
import { readStore, setStoredEntry } from '../plugins/project-store.ts';

interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  deletedAt?: number;
  description?: string;
}

function projectMetas(value: unknown): ProjectMeta[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ProjectMeta => (
    !!entry
    && typeof entry === 'object'
    && typeof (entry as ProjectMeta).id === 'string'
    && typeof (entry as ProjectMeta).name === 'string'
    && typeof (entry as ProjectMeta).updatedAt === 'number'
  ));
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

function emptyProject(args: Record<string, unknown>): unknown {
  const timelineId = `tl_${randomUUID()}`;
  const timeline = {
    id: timelineId,
    name: '序列 1',
    order: 0,
    fps: positiveNumber(args.fps, 30),
    width: positiveNumber(args.compositionWidth, 1920),
    height: positiveNumber(args.compositionHeight, 1080),
    items: [],
    selectedId: null,
    trackOrder: ['track_v1'],
    tracks: { track_v1: { kind: 'video' } },
  };
  return {
    version: 2,
    assets: [],
    mediaFolders: [],
    timelines: [timeline],
    activeTimelineId: timelineId,
  };
}

export async function listExternalProjects(includeDeleted = false): Promise<ProjectMeta[]> {
  const store = await readStore();
  return projectMetas(store.entries.projects)
    .filter((project) => includeDeleted || !project.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createExternalProject(
  args: Record<string, unknown>,
): Promise<ProjectMeta> {
  const name = String(args.name ?? '').trim() || 'External MCP Project';
  const description = String(args.description ?? '').trim();
  const meta: ProjectMeta = {
    id: randomUUID(),
    name,
    updatedAt: Date.now(),
    ...(description ? { description } : {}),
  };
  const projects = await listExternalProjects(true);
  await setStoredEntry(`project:${meta.id}`, emptyProject(args));
  await setStoredEntry('projects', [meta, ...projects]);
  return meta;
}
