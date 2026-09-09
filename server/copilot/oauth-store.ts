import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { atomicWriteFile, durableRemove } from '../plugins/project-store-durable.ts';
import {
  CopilotAuthError, parseStoredCopilotAuth,
  type CopilotCredentialStore, type CopilotStoredAuth,
} from './oauth-types.ts';

export interface CopilotEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Uint8Array;
  decryptString(value: Buffer): string;
}

/** Only ciphertext is stored, outside project documents, exports, and browser storage. */
export class EncryptedCopilotCredentialStore implements CopilotCredentialStore {
  private readonly path: string;
  private readonly encryption: CopilotEncryption;

  constructor(path: string, encryption: CopilotEncryption) {
    this.path = path;
    this.encryption = encryption;
  }

  available(): boolean { return this.encryption.isEncryptionAvailable(); }

  async read(): Promise<CopilotStoredAuth | null> {
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new CopilotAuthError('Could not read the encrypted Copilot sign-in.');
    }
    this.requireEncryption();
    try {
      if (encrypted.length > 128 * 1024) throw new Error('oversized credential');
      return parseStoredCopilotAuth(JSON.parse(this.encryption.decryptString(encrypted)));
    } catch {
      throw new CopilotAuthError('Could not unlock the saved Copilot sign-in. Sign out and sign in again.');
    }
  }

  async write(value: CopilotStoredAuth | null): Promise<void> {
    this.requireEncryption();
    try {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      if (value === null) await durableRemove(this.path);
      else await atomicWriteFile(this.path, this.encryption.encryptString(JSON.stringify(value)), { mode: 0o600 });
    } catch {
      throw new CopilotAuthError('Could not securely save the Copilot sign-in. Check storage access and try again.');
    }
  }

  private requireEncryption(): void {
    if (!this.available()) throw new CopilotAuthError('Secure system credential storage is unavailable. Copilot credentials were not saved.');
  }
}
