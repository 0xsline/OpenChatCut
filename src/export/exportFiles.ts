export interface ExportDirectoryHandle {
  getFileHandle(name: string, options: { create: true }): Promise<{
    createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
  }>;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function selectExportDirectory(): Promise<ExportDirectoryHandle | null> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<ExportDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) return null;
  return picker.call(window, { mode: 'readwrite' });
}

export async function writeExportFile(
  directory: ExportDirectoryHandle,
  name: string,
  data: Blob | string,
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}
