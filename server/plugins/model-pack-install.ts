import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function recoverDirectorySwap(installedRoot: string, backupRoot: string): Promise<void> {
  if (!existsSync(backupRoot)) return;
  if (existsSync(installedRoot)) {
    await rm(backupRoot, { recursive: true, force: true });
    return;
  }
  await mkdir(dirname(installedRoot), { recursive: true });
  await rename(backupRoot, installedRoot);
}

export async function replaceDirectoryAtomically(
  stagedRoot: string,
  installedRoot: string,
  backupRoot: string,
): Promise<void> {
  await mkdir(dirname(installedRoot), { recursive: true });
  await rm(backupRoot, { recursive: true, force: true });
  const hadInstalledRoot = existsSync(installedRoot);
  if (hadInstalledRoot) await rename(installedRoot, backupRoot);
  try {
    await rename(stagedRoot, installedRoot);
  } catch (installError) {
    if (hadInstalledRoot && existsSync(backupRoot) && !existsSync(installedRoot)) {
      try {
        await rename(backupRoot, installedRoot);
      } catch (restoreError) {
        throw new AggregateError(
          [installError, restoreError],
          `Unable to install ${installedRoot} or restore its previous directory`,
        );
      }
    }
    throw installError;
  }
  await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
}
