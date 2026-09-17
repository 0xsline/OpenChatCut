// Profile bootstrap. The project store resolves its paths from the environment
// the moment server/runtime-profile.ts is first imported, so this module must run
// BEFORE any store module is loaded: cli/main.ts parses arguments, applies the
// override here, and only then dynamically imports the command router.
//
// The env name is a literal on purpose. Importing it from server/runtime-profile.ts
// would execute that module (it resolves the active profile at module load) and
// freeze the profile before --data-dir could take effect. cli/cli.verify.ts asserts
// the literal still matches the server's DATA_DIR_ENV.

export const CLI_DATA_DIR_ENV = 'OPENCHATCUT_DATA_DIR';

export interface GlobalOptions {
  readonly dataDir?: string;
}

export function applyGlobalOptions(options: GlobalOptions): void {
  if (options.dataDir === undefined || !options.dataDir.trim()) return;
  process.env[CLI_DATA_DIR_ENV] = options.dataDir.trim();
}

export interface ProfileReport {
  readonly mode: string;
  readonly profileId: string;
  readonly rootDir: string;
  readonly mediaDir: string;
  readonly keystorePath: string;
  readonly projectStoreIndex: string;
}

/** Reads the active profile — call only after applyGlobalOptions. */
export async function profileReport(): Promise<ProfileReport> {
  const { runtimeProfile } = await import('../server/runtime-profile.ts');
  const profile = runtimeProfile();
  return {
    mode: profile.mode,
    profileId: profile.id,
    rootDir: profile.rootDir,
    mediaDir: profile.mediaDir,
    keystorePath: profile.keystorePath,
    projectStoreIndex: profile.projectStore.indexPath,
  };
}
