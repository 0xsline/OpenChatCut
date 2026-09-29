import { join } from 'node:path';
import { safeStorage } from 'electron';
import { runtimeProfile } from '../server/runtime-profile.ts';
import { stopCopilotClient } from '../server/copilot/client.ts';
import { GitHubCopilotOAuth } from '../server/copilot/oauth-api.ts';
import { EncryptedCopilotCredentialStore } from '../server/copilot/oauth-store.ts';
import { configureCopilotOAuth, CopilotOAuthService } from '../server/copilot/oauth-service.ts';

export function installDesktopCopilotAuth(): CopilotOAuthService {
  const store = new EncryptedCopilotCredentialStore(
    join(runtimeProfile().rootDir, 'copilot-auth-v1.enc'),
    {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable()
        && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    },
  );
  const auth = new CopilotOAuthService({
    store, api: new GitHubCopilotOAuth(process.env.OPENCHATCUT_COPILOT_CLIENT_ID?.trim() || undefined),
    credentialsChanged: stopCopilotClient,
  });
  configureCopilotOAuth(auth);
  return auth;
}
