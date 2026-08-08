export const DESKTOP_UPDATE_CHANNELS = {
  state: 'openchatcut:update-state',
  getState: 'openchatcut:update-get-state',
  check: 'openchatcut:update-check',
  download: 'openchatcut:update-download',
  install: 'openchatcut:update-install',
} as const;

export type DesktopUpdateCheckSource = 'auto' | 'manual';
export type DesktopUpdateOperation = 'check' | 'download' | 'install';
export type DesktopUpdatePhase =
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'current'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface DesktopUpdateState {
  readonly phase: DesktopUpdatePhase;
  readonly source: DesktopUpdateCheckSource;
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly percent?: number;
  readonly failedOperation?: DesktopUpdateOperation;
}

const UPDATE_PHASES = new Set<DesktopUpdatePhase>([
  'unsupported',
  'idle',
  'checking',
  'available',
  'current',
  'downloading',
  'downloaded',
  'installing',
  'error',
]);

export function isDesktopUpdateCheckSource(value: unknown): value is DesktopUpdateCheckSource {
  return value === 'auto' || value === 'manual';
}

export function isDesktopUpdateState(value: unknown): value is DesktopUpdateState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DesktopUpdateState>;
  if (!candidate.phase || !UPDATE_PHASES.has(candidate.phase)) return false;
  if (!isDesktopUpdateCheckSource(candidate.source)) return false;
  if (typeof candidate.currentVersion !== 'string' || !candidate.currentVersion.trim()) return false;
  if (candidate.latestVersion !== undefined && typeof candidate.latestVersion !== 'string') return false;
  if (candidate.percent !== undefined
    && (typeof candidate.percent !== 'number' || !Number.isFinite(candidate.percent))) return false;
  if (candidate.failedOperation !== undefined
    && !['check', 'download', 'install'].includes(candidate.failedOperation)) return false;
  return true;
}
