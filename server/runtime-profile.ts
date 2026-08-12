import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const DEV_PROFILE_ID_ENV = 'OPENCHATCUT_DEV_PROFILE_ID';
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

export function resolveRuntimeProfile(
  env: RuntimeProfileEnv = process.env,
  locations: RuntimeProfileLocations = {},
): RuntimeProfile {
  const home = locations.homeDir ?? homedir();
  const cwd = locations.cwd ?? process.cwd();
  const profileId = configuredProfileId(env);
  if (profileId) {
    const rootDir = join(home, '.openchatcut', 'dev-profiles', profileId);
    const base = profileBase(
      rootDir,
      join(rootDir, 'media', 'uploads'),
      join(rootDir, 'generation-operations-v1.json'),
      join(rootDir, 'settings.env'),
    );
    return Object.freeze({ mode: 'isolated-dev', id: profileId, ...base });
  }
  const rootDir = join(home, '.openchatcut');
  const authOverride = env.OPENCHATCUT_PROJECT_STORE_AUTH_DIR?.trim();
  const generationOverride = env.OPENCHATCUT_GENERATION_JOB_STORE;
  const base = profileBase(
    rootDir,
    join(cwd, 'public', 'media', 'uploads'),
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
