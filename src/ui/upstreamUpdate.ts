import type {
  DesktopUpdateOperation,
  DesktopUpdateState,
} from '../../shared/desktop-update';

export const UPSTREAM_LATEST_RELEASE_URL = 'https://api.github.com/repos/0xsline/OpenChatCut/releases/latest';
export const UPSTREAM_RELEASES_URL = 'https://github.com/0xsline/OpenChatCut/releases/latest';

export const CURRENT_APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CheckSource = 'auto' | 'manual';

type DesktopUpdateApi = NonNullable<Window['openChatCutDesktop']>['updates'];
export interface UpstreamReleaseResult {
  latestVersion: string;
  updateAvailable: boolean;
}

interface VersionedUpdateState {
  visible: boolean;
  source: CheckSource;
  currentVersion: string;
  latestVersion: string;
}

export type UpstreamUpdateState =
  | { phase: 'idle'; visible: false }
  | { phase: 'checking'; visible: false; source: CheckSource }
  | (VersionedUpdateState & { phase: 'available' | 'current' })
  | (VersionedUpdateState & { phase: 'downloading'; percent: number })
  | (VersionedUpdateState & { phase: 'downloaded' | 'installing' })
  | {
    phase: 'error';
    visible: boolean;
    source: CheckSource;
    currentVersion: string;
    latestVersion?: string;
    failedOperation: DesktopUpdateOperation;
  };

interface ParsedVersion {
  core: readonly [number, number, number];
  prerelease: readonly string[];
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/i;
const listeners = new Set<() => void>();
let state: UpstreamUpdateState = { phase: 'idle', visible: false };
let requestSequence = 0;
let autoCheckStarted = false;
let activeController: AbortController | null = null;
let unsubscribeDesktopUpdates: (() => void) | null = null;
let desktopStateRevision = 0;
let desktopUpdateSupported: boolean | null = null;

function parseVersion(version: string): ParsedVersion | null {
  const match = version.trim().match(SEMVER);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(candidate: readonly string[], current: readonly string[]): number {
  if (candidate.length === 0 || current.length === 0) {
    return candidate.length === current.length ? 0 : candidate.length === 0 ? 1 : -1;
  }
  const length = Math.max(candidate.length, current.length);
  for (let index = 0; index < length; index += 1) {
    const next = candidate[index];
    const installed = current[index];
    if (next === undefined || installed === undefined) return next === installed ? 0 : next === undefined ? -1 : 1;
    if (next === installed) continue;
    const nextNumber = /^\d+$/.test(next) ? Number(next) : null;
    const installedNumber = /^\d+$/.test(installed) ? Number(installed) : null;
    if (nextNumber !== null || installedNumber !== null) {
      if (nextNumber === null) return 1;
      if (installedNumber === null) return -1;
      return nextNumber > installedNumber ? 1 : -1;
    }
    return next > installed ? 1 : -1;
  }
  return 0;
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) throw new Error('Upstream did not return a valid release version');
  for (let index = 0; index < next.core.length; index += 1) {
    if (next.core[index] !== installed.core[index]) return next.core[index]! > installed.core[index]!;
  }
  return comparePrerelease(next.prerelease, installed.prerelease) > 0;
}

export function formatDisplayVersion(version: string): string {
  return `V${version.trim().replace(/^v/i, '')}`;
}

export async function queryLatestUpstreamRelease(
  currentVersion: string,
  fetcher: Fetcher = fetch,
  signal?: AbortSignal,
): Promise<UpstreamReleaseResult> {
  const response = await fetcher(UPSTREAM_LATEST_RELEASE_URL, { signal });
  if (!response.ok) throw new Error(`Upstream release check failed (${response.status})`);
  const payload = await response.json() as { tag_name?: unknown };
  if (typeof payload.tag_name !== 'string' || !parseVersion(payload.tag_name)) {
    throw new Error('Upstream did not return a valid release version');
  }
  return {
    latestVersion: payload.tag_name,
    updateAvailable: isNewerVersion(payload.tag_name, currentVersion),
  };
}

function publish(next: UpstreamUpdateState): void {
  state = next;
  listeners.forEach((notify) => { notify(); });
}

export function mapDesktopUpdateState(update: DesktopUpdateState): UpstreamUpdateState {
  const latestVersion = update.latestVersion ?? update.currentVersion;
  if (update.phase === 'unsupported' || update.phase === 'idle') {
    return { phase: 'idle', visible: false };
  }
  if (update.phase === 'checking') {
    return { phase: 'checking', visible: false, source: update.source };
  }
  if (update.phase === 'error') {
    return {
      phase: 'error',
      visible: update.source === 'manual',
      source: update.source,
      currentVersion: update.currentVersion,
      latestVersion: update.latestVersion,
      failedOperation: update.failedOperation ?? 'check',
    };
  }
  const versioned = {
    source: update.source,
    currentVersion: update.currentVersion,
    latestVersion,
  };
  if (update.phase === 'available') return { ...versioned, phase: 'available', visible: true };
  if (update.phase === 'current') {
    return { ...versioned, phase: 'current', visible: update.source === 'manual' };
  }
  if (update.phase === 'downloading') {
    return { ...versioned, phase: 'downloading', visible: true, percent: Math.max(0, Math.min(100, update.percent ?? 0)) };
  }
  if (update.phase === 'downloaded') return { ...versioned, phase: 'downloaded', visible: true };
  return { ...versioned, phase: 'installing', visible: true };
}

function desktopUpdateApi(): DesktopUpdateApi | null {
  if (typeof window === 'undefined') return null;
  return window.openChatCutDesktop?.updates ?? null;
}

function syncDesktopUpdate(update: DesktopUpdateState): void {
  desktopUpdateSupported = update.phase !== 'unsupported';
  desktopStateRevision += 1;
  publish(mapDesktopUpdateState(update));
}

function ensureDesktopUpdateSubscription(): DesktopUpdateApi | null {
  const desktop = desktopUpdateApi();
  if (!desktop || unsubscribeDesktopUpdates) return desktop;
  unsubscribeDesktopUpdates = desktop.subscribe(syncDesktopUpdate);
  const revision = desktopStateRevision;
  void desktop.getState().then((update) => {
    if (desktopStateRevision === revision) syncDesktopUpdate(update);
  }).catch(() => undefined);
  return desktop;
}

export function hasDesktopUpdateSupport(): boolean {
  return desktopUpdateApi() !== null && desktopUpdateSupported !== false;
}

export function subscribeUpstreamUpdate(notify: () => void): () => void {
  listeners.add(notify);
  ensureDesktopUpdateSubscription();
  return () => { listeners.delete(notify); };
}

export function getUpstreamUpdateState(): UpstreamUpdateState {
  return state;
}

export function dismissUpstreamUpdate(): void {
  requestSequence += 1;
  activeController?.abort();
  activeController = null;
  if (state.phase === 'idle') return;
  if (state.phase === 'checking') {
    publish({ phase: 'idle', visible: false });
    return;
  }
  publish({ ...state, visible: false });
}

async function requestWebUpdateCheck(source: CheckSource): Promise<void> {
  const sequence = ++requestSequence;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  publish({ phase: 'checking', source, visible: false });
  const timeout = globalThis.setTimeout(() => controller.abort(), 6_000);

  try {
    const result = await queryLatestUpstreamRelease(CURRENT_APP_VERSION, fetch, controller.signal);
    if (sequence !== requestSequence) return;
    publish({
      phase: result.updateAvailable ? 'available' : 'current',
      source,
      visible: result.updateAvailable || source === 'manual',
      currentVersion: CURRENT_APP_VERSION,
      latestVersion: result.latestVersion,
    });
  } catch {
    if (sequence === requestSequence) {
      publish({
        phase: 'error',
        source,
        visible: source === 'manual',
        currentVersion: CURRENT_APP_VERSION,
        failedOperation: 'check',
      });
    }
  } finally {
    globalThis.clearTimeout(timeout);
    if (sequence === requestSequence) activeController = null;
  }
}

export async function requestUpstreamUpdateCheck(source: CheckSource = 'manual'): Promise<void> {
  const desktop = hasDesktopUpdateSupport() ? ensureDesktopUpdateSubscription() : null;
  if (!desktop) return requestWebUpdateCheck(source);

  publish({ phase: 'checking', source, visible: false });
  try {
    const update = await desktop.check(source);
    syncDesktopUpdate(update);
    if (update.phase === 'unsupported') await requestWebUpdateCheck(source);
  } catch {
    publish({
      phase: 'error',
      source,
      visible: source === 'manual',
      currentVersion: CURRENT_APP_VERSION,
      failedOperation: 'check',
    });
  }
}

export async function requestUpstreamUpdateDownload(): Promise<void> {
  const desktop = hasDesktopUpdateSupport() ? ensureDesktopUpdateSubscription() : null;
  if (!desktop) {
    openUpstreamReleasePage();
    return;
  }
  try {
    syncDesktopUpdate(await desktop.download());
  } catch {
    publish({
      phase: 'error',
      source: state.phase === 'idle' ? 'manual' : state.source,
      visible: true,
      currentVersion: CURRENT_APP_VERSION,
      latestVersion: state.phase === 'idle' || state.phase === 'checking' ? undefined : state.latestVersion,
      failedOperation: 'download',
    });
  }
}

export async function requestUpstreamUpdateInstall(): Promise<void> {
  const desktop = hasDesktopUpdateSupport() ? ensureDesktopUpdateSubscription() : null;
  if (!desktop) return;
  try {
    syncDesktopUpdate(await desktop.install());
  } catch {
    publish({
      phase: 'error',
      source: state.phase === 'idle' ? 'manual' : state.source,
      visible: true,
      currentVersion: CURRENT_APP_VERSION,
      latestVersion: state.phase === 'idle' || state.phase === 'checking' ? undefined : state.latestVersion,
      failedOperation: 'install',
    });
  }
}

export function openUpstreamReleasePage(): void {
  if (typeof window === 'undefined') return;
  window.open(UPSTREAM_RELEASES_URL, '_blank', 'noopener,noreferrer');
}

export function startAutomaticUpstreamUpdateCheck(): void {
  if (autoCheckStarted) return;
  autoCheckStarted = true;
  void requestUpstreamUpdateCheck('auto');
}
