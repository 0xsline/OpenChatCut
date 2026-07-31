import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, resolve } from 'node:path';

export interface ExportDirectoryGrantDescriptor {
  readonly grantId: string;
  readonly label: string;
}

interface ExportDirectoryGrant {
  readonly directory: string;
}

const grants = new Map<string, ExportDirectoryGrant>();

function replaceControlCharacters(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    result += code <= 31 || code === 127 ? '�' : value[index];
  }
  return result;
}

/** Called only by Electron main after its native picker or trusted restore has validated the directory. */
export function createExportDirectoryGrant(directory: string): ExportDirectoryGrantDescriptor {
  if (!isAbsolute(directory)) throw new Error('export directory must be absolute');
  const normalized = resolve(directory);
  const grantId = randomBytes(32).toString('base64url');
  const label = replaceControlCharacters(basename(normalized) || normalized);
  grants.set(grantId, { directory: normalized });
  return { grantId, label };
}

/** Server-side capability lookup. The writable path never crosses into the renderer. */
export function resolveExportDirectoryGrant(grantId: string): ExportDirectoryGrant | null {
  return grants.get(grantId) ?? null;
}
