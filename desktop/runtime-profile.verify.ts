import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { DEV_PROFILE_ID_ENV, resolveRuntimeProfile } from '../server/runtime-profile.ts';
import {
  requestProfileScopedSingleInstanceLock,
  resolveDesktopUserDataOverride,
} from './runtime-profile.ts';

const homeDir = resolve('desktop-runtime-profile-fixtures', 'home');
const cwd = resolve('desktop-runtime-profile-fixtures', 'checkout');
const profileA = resolveRuntimeProfile({
  [DEV_PROFILE_ID_ENV]: '11111111-1111-4111-8111-111111111111',
}, { homeDir, cwd });
const profileB = resolveRuntimeProfile({
  [DEV_PROFILE_ID_ENV]: '22222222-2222-4222-8222-222222222222',
}, { homeDir, cwd });
const defaultProfile = resolveRuntimeProfile({}, { homeDir, cwd });

const profileAUserData = resolveDesktopUserDataOverride(profileA, false);
const profileBUserData = resolveDesktopUserDataOverride(profileB, false);
assert.equal(profileAUserData, join(profileA.rootDir, 'electron-user-data'));
assert.equal(profileBUserData, join(profileB.rootDir, 'electron-user-data'));
assert.notEqual(profileAUserData, profileBUserData, 'worktree desktop profiles must not share Chromium state');
assert.equal(resolveDesktopUserDataOverride(defaultProfile, false), null, 'shared development keeps Electron defaults');
assert.equal(resolveDesktopUserDataOverride(profileA, true), null, 'packaged Electron ignores development profiles');

const calls: string[] = [];
let assignedUserData: string | null = null;
const acquired = requestProfileScopedSingleInstanceLock({
  isPackaged: false,
  setPath(name, path) {
    calls.push(`setPath:${name}`);
    assignedUserData = path;
  },
  requestSingleInstanceLock() {
    calls.push('requestSingleInstanceLock');
    return true;
  },
}, profileA);

assert.equal(acquired, true);
assert.equal(assignedUserData, profileAUserData);
assert.deepEqual(
  calls,
  ['setPath:userData', 'requestSingleInstanceLock'],
  'profile userData must be configured before acquiring the singleton lock',
);

console.log('desktop runtime profile: OK');
