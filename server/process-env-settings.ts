// Settings that .env.example documents but the server reads from process.env at
// call time instead of the keystore. None of them is a secret. A packaged desktop
// app has no shell to export them from, so its startup copies exactly these names
// from userData `.env.local` into process.env (desktop/env-seed.ts). Only these:
// keystore secrets, or a stray PATH / NODE_OPTIONS line, would otherwise land in
// process.env, which every child process the app spawns inherits.
export const PROCESS_ENV_SETTING_NAMES = [
  'UPLOAD_MAX_BYTES',
  'OPENCHATCUT_RENDER_CONCURRENCY',
  'OPENCHATCUT_MAX_ACTIVE_EXPORTS',
  'OPENCHATCUT_DISABLE_HARDWARE_ENCODING',
  'OPENCHATCUT_H264_ENCODER',
] as const;

/**
 * Copy the process-env settings present in a parsed env file onto `target` and
 * return the names copied. A value from the file wins over an inherited one, the
 * precedence seedKeystore gives keys; names the file leaves out or empty stay as
 * they were.
 */
export function applyProcessEnvSettings(
  env: Readonly<Record<string, string>>,
  target: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const applied = PROCESS_ENV_SETTING_NAMES.filter((name) => Boolean(env[name]));
  for (const name of applied) target[name] = env[name];
  return applied;
}
