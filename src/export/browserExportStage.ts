export interface StagedBrowserExport {
  path: string;
  sizeBytes: number;
}

export async function stageBrowserExport(
  blob: Blob,
  filename: string,
  signal?: AbortSignal,
): Promise<StagedBrowserExport> {
  signal?.throwIfAborted();
  const response = await fetch(`/export/stage?name=${encodeURIComponent(filename)}`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    signal,
  });
  signal?.throwIfAborted();
  const result = (await response.json().catch(() => null)) as Partial<StagedBrowserExport> & { error?: string } | null;
  signal?.throwIfAborted();
  if (!response.ok || typeof result?.path !== 'string' || typeof result.sizeBytes !== 'number') {
    throw new Error(result?.error ?? `failed to stage browser export (${response.status})`);
  }
  return { path: result.path, sizeBytes: result.sizeBytes };
}

export async function removeStagedBrowserExport(path: string): Promise<void> {
  const prefix = '/media/uploads/openchatcut-export-stage-';
  if (!path.startsWith(prefix)) return;
  const name = path.slice('/media/uploads/'.length);
  const response = await fetch(`/export/stage/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`failed to remove staged browser export (${response.status})`);
}
