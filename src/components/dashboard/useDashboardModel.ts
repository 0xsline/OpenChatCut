import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { getAgentModelSnapshot, subscribeAgentModels, type AgentModelSnapshot } from '../../agent/model-selection';
import { useT } from '../../i18n/locale';
import { loadProject, loadProjectThumb, saveProjectThumb } from '../../persist/projectStore';
import type { ProjectMeta } from '../../persist/projectStoreCoordinators';

export interface DashboardProps {
  projects: ProjectMeta[];
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
  onExport: (id: string, name: string) => Promise<string>;
  onImport: (file: File) => Promise<string>;
}

export type DashboardDialog = 'settings' | 'shortcuts' | 'mcp' | 'cleanup' | 'storage';

interface RenameModel {
  editingId: string | null;
  draft: string;
  confirmId: string | null;
  setDraft: (value: string) => void;
  setConfirmId: (value: string | null) => void;
  start: (project: ProjectMeta) => void;
  commit: () => void;
  cancel: () => void;
}

interface TransferModel {
  note: string | null;
  busy: boolean;
  fileRef: RefObject<HTMLInputElement | null>;
  run: (work: Promise<string>) => Promise<void>;
  pickImport: (event: ChangeEvent<HTMLInputElement>) => void;
}

export interface DashboardModel {
  modelSnapshot: AgentModelSnapshot;
  query: string;
  normalizedQuery: string;
  visibleProjects: ProjectMeta[];
  setQuery: (value: string) => void;
  dialogs: Readonly<Record<DashboardDialog, boolean>>;
  setDialog: (dialog: DashboardDialog, open: boolean) => void;
  rename: RenameModel;
  transfer: TransferModel;
  thumbs: Readonly<Record<string, string>>;
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

const THUMB_RENDER_CONCURRENCY = 2;
const THUMB_RENDER_VERSION = 1;
const thumbKey = (project: ProjectMeta) => project.updatedAt + THUMB_RENDER_VERSION;

export function relativeProjectTime(ms: number, translate: Translate): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return translate('刚刚');
  if (seconds < 3600) return translate('{n} 分钟前', { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return translate('{n} 小时前', { n: Math.floor(seconds / 3600) });
  return translate('{n} 天前', { n: Math.floor(seconds / 86400) });
}

async function renderProjectPoster(project: ProjectMeta): Promise<string | null> {
  const doc = await loadProject(project.id);
  const timeline = doc?.timelines.find((entry) => entry.id === doc.activeTimelineId) ?? doc?.timelines[0];
  if (!timeline?.items?.length) return null;
  const posterItem = timeline.items.filter((item) => item.kind !== 'audio')
    .sort((left, right) => right.durationInFrames - left.durationInFrames)[0];
  if (!posterItem) return null;
  const posterFrame = posterItem.startFrame + Math.floor(posterItem.durationInFrames / 2);
  const response = await fetch('/render-still', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: timeline, frames: [posterFrame], grid: false }),
  });
  if (!response.ok) return null;
  const json = (await response.json()) as { frames?: { base64?: string }[] };
  const base64 = json.frames?.[0]?.base64;
  return base64 ? `data:image/jpeg;base64,${base64}` : null;
}

async function hydrateProjectPosters(
  projects: ProjectMeta[],
  rendering: Set<string>,
  setThumbs: Dispatch<SetStateAction<Record<string, string>>>,
  isAlive: () => boolean,
): Promise<void> {
  const active = projects.filter((project) => !project.deletedAt);
  const cached = await Promise.all(active.map(async (project) => ({ project, thumb: await loadProjectThumb(project.id) })));
  if (!isAlive()) return;
  setThumbs(Object.fromEntries(cached.filter(({ project, thumb }) => thumb?.key === thumbKey(project))
    .map(({ project, thumb }) => [project.id, thumb!.dataUrl])));
  const queue = cached.filter(({ project, thumb }) => thumb?.key !== thumbKey(project)
    && !rendering.has(`${project.id}@${thumbKey(project)}`));
  let cursor = 0;
  const worker = async () => {
    while (isAlive()) {
      const entry = queue[cursor++];
      if (!entry) return;
      const key = thumbKey(entry.project);
      const cacheKey = `${entry.project.id}@${key}`;
      rendering.add(cacheKey);
      try {
        const dataUrl = await renderProjectPoster(entry.project);
        if (!dataUrl) continue;
        await saveProjectThumb(entry.project.id, key, dataUrl);
        if (isAlive()) setThumbs((previous) => ({ ...previous, [entry.project.id]: dataUrl }));
      } catch { /* Keep old pictures or placeholders. */ } finally {
        rendering.delete(cacheKey);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(THUMB_RENDER_CONCURRENCY, queue.length) }, worker));
}

function useProjectPosters(projects: ProjectMeta[]): Readonly<Record<string, string>> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const renderingRef = useRef(new Set<string>());
  useEffect(() => {
    let alive = true;
    void hydrateProjectPosters(projects, renderingRef.current, setThumbs, () => alive);
    return () => { alive = false; };
  }, [projects]);
  return thumbs;
}

function useProjectRename(onRename: DashboardProps['onRename']): RenameModel {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const start = (project: ProjectMeta) => {
    setEditingId(project.id);
    setDraft(project.name);
    setConfirmId(null);
  };
  const commit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim());
    setEditingId(null);
  };
  return { editingId, draft, confirmId, setDraft, setConfirmId, start, commit, cancel: () => setEditingId(null) };
}

function useProjectTransfer(onImport: DashboardProps['onImport']): TransferModel {
  const translate = useT();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = async (work: Promise<string>) => {
    setBusy(true);
    setNote(translate('处理中…'));
    try { setNote(await work); }
    catch (error) { setNote(translate('失败:{error}', { error: error instanceof Error ? error.message : String(error) })); }
    finally { setBusy(false); }
  };
  const pickImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void run(onImport(file));
  };
  return { note, busy, fileRef, run, pickImport };
}

function useDashboardDialogs() {
  const [dialogs, setDialogs] = useState<Record<DashboardDialog, boolean>>({ settings: false, shortcuts: false, mcp: false, cleanup: false, storage: false });
  const setDialog = (dialog: DashboardDialog, open: boolean) => {
    setDialogs((current) => ({ ...current, [dialog]: open }));
  };
  return { dialogs, setDialog };
}

export function useDashboardModel(props: DashboardProps): DashboardModel {
  const modelSnapshot = useSyncExternalStore(subscribeAgentModels, getAgentModelSnapshot);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = normalizedQuery
    ? props.projects.filter((project) => project.name.toLocaleLowerCase().includes(normalizedQuery))
    : props.projects;
  const { dialogs, setDialog } = useDashboardDialogs();
  const rename = useProjectRename(props.onRename);
  const transfer = useProjectTransfer(props.onImport);
  const thumbs = useProjectPosters(props.projects);
  return {
    modelSnapshot,
    query,
    normalizedQuery,
    visibleProjects,
    setQuery,
    dialogs,
    setDialog,
    rename,
    transfer,
    thumbs,
  };
}
