export const UPSTREAM_LATEST_RELEASE_URL = 'https://api.github.com/repos/0xsline/OpenChatCut/releases/latest';

export const CURRENT_APP_VERSION =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type CheckSource = 'auto' | 'manual';

export interface UpstreamReleaseResult {
  latestVersion: string;
  updateAvailable: boolean;
}

export type UpstreamUpdateState =
  | { phase: 'idle'; visible: false }
  | { phase: 'checking'; visible: false; source: CheckSource }
  | {
    phase: 'available' | 'current';
    visible: boolean;
    source: CheckSource;
    currentVersion: string;
    latestVersion: string;
  }
  | { phase: 'error'; visible: boolean; source: CheckSource };

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
  listeners.forEach((notify) => notify());
}

export function subscribeUpstreamUpdate(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}

export function getUpstreamUpdateState(): UpstreamUpdateState {
  return state;
}

export function dismissUpstreamUpdate(): void {
  requestSequence += 1;
  activeController?.abort();
  activeController = null;
  if (state.phase !== 'idle') publish({ phase: 'idle', visible: false });
}

export async function requestUpstreamUpdateCheck(source: CheckSource = 'manual'): Promise<void> {
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
    if (sequence === requestSequence) publish({ phase: 'error', source, visible: source === 'manual' });
  } finally {
    globalThis.clearTimeout(timeout);
    if (sequence === requestSequence) activeController = null;
  }
}

export function startAutomaticUpstreamUpdateCheck(): void {
  if (autoCheckStarted) return;
  autoCheckStarted = true;
  void requestUpstreamUpdateCheck('auto');
}
