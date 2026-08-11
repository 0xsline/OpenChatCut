import { join } from 'node:path';
import type { RuntimeProfile } from '../server/runtime-profile.ts';

interface ProfileScopedDesktopApp {
  readonly isPackaged: boolean;
  setPath(name: 'userData', path: string): void;
  requestSingleInstanceLock(): boolean;
}

export function resolveDesktopUserDataOverride(
  profile: RuntimeProfile,
  packaged: boolean,
): string | null {
  if (packaged || profile.mode !== 'isolated-dev') return null;
  return join(profile.rootDir, 'electron-user-data');
}

export function requestProfileScopedSingleInstanceLock(
  application: ProfileScopedDesktopApp,
  profile: RuntimeProfile,
): boolean {
  const userDataPath = resolveDesktopUserDataOverride(profile, application.isPackaged);
  if (userDataPath) application.setPath('userData', userDataPath);
  return application.requestSingleInstanceLock();
}
