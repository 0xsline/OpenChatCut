import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

interface DurableHandle {
  writeFile?: (data: string | Uint8Array) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

export interface AtomicWriteOperations {
  open: (path: string, flags: string, mode?: number) => Promise<DurableHandle>;
  rename: (source: string, target: string) => Promise<void>;
  rm: (path: string, options: { force: boolean }) => Promise<void>;
}

const DEFAULT_ATOMIC_OPERATIONS: AtomicWriteOperations = {
  open: async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return {
      writeFile: async (data) => handle.writeFile(data),
      sync: async () => handle.sync(),
      close: async () => handle.close(),
    };
  },
  rename,
  rm,
};

function unsupportedDirectorySync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && ['EACCES', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code ?? '');
}

export async function syncDirectory(
  directory: string,
  operations: AtomicWriteOperations = DEFAULT_ATOMIC_OPERATIONS,
): Promise<void> {
  let handle: DurableHandle | undefined;
  try {
    handle = await operations.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!unsupportedDirectorySync(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function cleanupTemp(
  temp: string,
  directory: string,
  operations: AtomicWriteOperations,
): Promise<void> {
  try {
    await operations.rm(temp, { force: true });
    await syncDirectory(directory, operations);
  } catch {
    // Preserve the original write failure. A random temp can never replace another writer's file.
  }
}

export async function atomicWriteFile(
  target: string,
  data: string | Uint8Array,
  options: { mode?: number; operations?: AtomicWriteOperations } = {},
): Promise<void> {
  const operations = options.operations ?? DEFAULT_ATOMIC_OPERATIONS;
  const directory = dirname(target);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle: DurableHandle | undefined;
  let renamed = false;
  try {
    handle = await operations.open(temp, 'wx', options.mode ?? 0o600);
    if (!handle.writeFile) throw new Error('atomic write handle is not writable');
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await operations.rename(temp, target);
    renamed = true;
    await syncDirectory(directory, operations);
  } catch (error) {
    try {
      await handle?.close();
    } catch {
      // Preserve the original write failure.
    }
    if (!renamed) await cleanupTemp(temp, directory, operations);
    throw error;
  }
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('project store value is not JSON serializable');
  await atomicWriteFile(target, encoded);
}

export async function durableMkdir(path: string, recursive = false): Promise<void> {
  await mkdir(path, { recursive, mode: 0o700 });
  await syncDirectory(dirname(path));
}

export async function durableRemove(path: string, recursive = false): Promise<void> {
  await rm(path, { force: true, recursive });
  await syncDirectory(dirname(path));
}

export async function durableRename(source: string, target: string): Promise<void> {
  await rename(source, target);
  const sourceDirectory = dirname(source);
  const targetDirectory = dirname(target);
  await syncDirectory(sourceDirectory);
  if (targetDirectory !== sourceDirectory) await syncDirectory(targetDirectory);
}
