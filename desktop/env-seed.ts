import { seedKeystore } from '../server/keystore.ts';
import { applyProcessEnvSettings } from '../server/process-env-settings.ts';
import { parseEnvText } from './env-file.ts';

/**
 * Seed the desktop runtime from the text of userData `.env.local`: keys go to the
 * keystore, and the documented process-env settings (encoder override, export
 * tuning) go to process.env, where the server reads them at call time.
 */
export function seedDesktopEnv(text: string): void {
  const env = parseEnvText(text);
  seedKeystore(env);
  applyProcessEnvSettings(env);
}
