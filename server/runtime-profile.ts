import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readDataDirPointer } from './data-dir.ts';

export const DEV_PROFILE_ID_ENV = 'OPENCHATCUT_DEV_PROFILE_ID';
export const DATA_DIR_ENV = 'OPENCHATCUT_DATA_DIR';
const DEV_PROFILE_ENV_PREFIX = 'OPENCHATCUT_DEV_PROFILE_';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ProjectStoreProfilePaths {
  readonly legacyStorePath: string;
  readonly legacyBackupPath: string;
  readonly directory: string;
  readonly indexPath: string;
  readonly quarantineDir: string;
  readonly readyPath: string;
  readonly tombstonePath: string;
}

interface RuntimeProfileBase {
  readonly id: string;
  readonly rootDir: string;
  readonly authDir: string;
  readonly mediaDir: string;
  readonly generationJobStore: string;
  readonly keystorePath: string;
  readonly projectStore: ProjectStoreProfilePaths;
}

export interface DefaultRuntimeProfile extends RuntimeProfileBase {
  readonly mode: 'default';
  readonly id: 'default';
}

export interface IsolatedDevRuntimeProfile extends RuntimeProfileBase {
  readonly mode: 'isolated-dev';
}

export type RuntimeProfile = DefaultRuntimeProfile | IsolatedDevRuntimeProfile;

type RuntimeProfileEnv = Readonly<Record<string, string | undefined>>;

export interface RuntimeProfileLocations {
  readonly homeDir?: string;
  readonly cwd?: string;
}

function projectStorePaths(rootDir: string): ProjectStoreProfilePaths {
  const legacyStorePath = join(rootDir, 'project-store-v1.json');
  const directory = join(rootDir, 'project-store-v1');
  return Object.freeze({
    legacyStorePath,
    legacyBackupPath: `${legacyStorePath}.migrated`,
    directory,
    indexPath: join(directory, 'projects.json'),
    quarantineDir: join(directory, '.quarantine'),
    readyPath: join(directory, '.ready'),
    tombstonePath: join(rootDir, 'deleted-projects-v1.json'),
  });
}

function profileBase(
  rootDir: string,
  mediaDir: string,
  generationJobStore: string,
  keystorePath: string,
) {
  return {
    rootDir,
    authDir: join(rootDir, 'project-store-auth-v1'),
    mediaDir,
    generationJobStore,
    keystorePath,
    projectStore: projectStorePaths(rootDir),
  } as const;
}

function unsupportedProfileEnv(env: RuntimeProfileEnv): string | undefined {
  return Object.keys(env).find((name) =>
    name.startsWith(DEV_PROFILE_ENV_PREFIX)
    && name !== DEV_PROFILE_ID_ENV
    && env[name] !== undefined);
}

function configuredProfileId(env: RuntimeProfileEnv): string | null {
  const unsupported = unsupportedProfileEnv(env);
  if (unsupported) throw new Error(`Unsupported isolated development profile variable: ${unsupported}`);
  if (!Object.hasOwn(env, DEV_PROFILE_ID_ENV)) return null;
  const value = env[DEV_PROFILE_ID_ENV];
  if (typeof value !== 'string' || value !== value.trim() || !UUID_V4.test(value)) {
    throw new Error(`${DEV_PROFILE_ID_ENV} must be a lowercase UUID v4`);
  }
  return value;
}

/** User-chosen storage root (games-style save folder): data survives app removal.
 *  The environment variable wins so a launch script can pin a location; the
 *  settings UI records its choice in the fixed pointer file instead.
 *  Accepts ~/ expansion, requires an absolute path, and rejects anything else
 *  loudly so a typo never silently falls back to the hidden default location. */
function configuredDataDir(env: RuntimeProfileEnv, home: string): string | null {
  const raw = env[DATA_DIR_ENV]?.trim();
  if (!raw) return readDataDirPointer(home);
  const expanded = raw === '~' ? home : raw.replace(/^~(?=\/)/, home);
  if (!isAbsolute(expanded)) {
    throw new Error(`${DATA_DIR_ENV} must be an absolute path (got: ${raw})`);
  }
  return resolve(expanded);
}

export function resolveRuntimeProfile(
  env: RuntimeProfileEnv = process.env,
  locations: RuntimeProfileLocations = {},
): RuntimeProfile {
  const home = locations.homeDir ?? homedir();
  const cwd = locations.cwd ?? process.cwd();
  const dataDir = configuredDataDir(env, home);
  const profileId = configuredProfileId(env);
  if (profileId) {
    // An explicit data dir replaces the per-checkout hidden profile root: the
    // user asked for their projects to live at a visible, durable location.
    const rootDir = dataDir ?? join(home, '.openchatcut', 'dev-profiles', profileId);
    const base = profileBase(
      rootDir,
      join(rootDir, 'media', 'uploads'),
      join(rootDir, 'generation-operations-v1.json'),
      join(rootDir, 'settings.env'),
    );
    return Object.freeze({ mode: 'isolated-dev', id: profileId, ...base });
  }
  const rootDir = dataDir ?? join(home, '.openchatcut');
  const authOverride = env.OPENCHATCUT_PROJECT_STORE_AUTH_DIR?.trim();
  const generationOverride = env.OPENCHATCUT_GENERATION_JOB_STORE;
  const base = profileBase(
    rootDir,
    // With a user-chosen data dir, media belongs next to the projects it
    // backs; the checkout-relative default only applies to the hidden root.
    dataDir ? join(dataDir, 'media', 'uploads') : join(cwd, 'public', 'media', 'uploads'),
    generationOverride ?? join(rootDir, 'generation-operations-v1.json'),
    resolve(cwd, '.env.local'),
  );
  return Object.freeze({
    mode: 'default',
    id: 'default',
    ...base,
    authDir: authOverride || base.authDir,
  });
}

const activeProfile = resolveRuntimeProfile();

export function runtimeProfile(): RuntimeProfile {
  return activeProfile;
}

export function isIsolatedDevProfile(
  profile: RuntimeProfile = activeProfile,
): profile is IsolatedDevRuntimeProfile {
  return profile.mode === 'isolated-dev';
}

/** Storage root the app would use with no data directory configured. Lets the
 *  settings UI say where clearing the field actually leads. */
export function defaultRootDir(
  profile: RuntimeProfile = activeProfile,
  home: string = homedir(),
): string {
  return isIsolatedDevProfile(profile)
    ? join(home, '.openchatcut', 'dev-profiles', profile.id)
    : join(home, '.openchatcut');
}
