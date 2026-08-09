import type { ModelPackCatalogEntry, ModelPackId, ModelPackTask } from './catalog';

interface CatalogResponse {
  packs?: ModelPackCatalogEntry[];
  error?: string;
}

async function responseJson<T extends { error?: string }>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T;
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}
function modelPackMutationHeaders(headers: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set('content-type', 'application/json');
  return result;
}

export async function fetchModelPackCatalog(): Promise<readonly ModelPackCatalogEntry[]> {
  const response = await fetch('/api/model-packs', { cache: 'no-store' });
  const body = await responseJson<CatalogResponse>(response);
  if (!Array.isArray(body.packs)) throw new Error('Invalid model pack catalog response');
  return body.packs;
}

export async function areModelPacksInstalled(ids: readonly ModelPackId[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const catalog = await fetchModelPackCatalog();
  const statusById = new Map(catalog.map((pack) => [pack.id, pack.status]));
  return ids.every((id) => statusById.get(id) === 'installed');
}

export async function installModelPack(id: ModelPackId, headers: HeadersInit): Promise<ModelPackTask> {
  const response = await fetch('/api/model-packs/download', {
    method: 'POST',
    headers: modelPackMutationHeaders(headers),
    body: JSON.stringify({ id }),
  });
  const body = await responseJson<{ task?: ModelPackTask; error?: string }>(response);
  if (!body.task) throw new Error('Invalid model pack download response');
  return body.task;
}

export async function fetchModelPackTask(id: ModelPackId): Promise<ModelPackTask | null> {
  const response = await fetch(`/api/model-packs/download/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const body = await responseJson<{ task?: ModelPackTask | null; error?: string }>(response);
  return body.task ?? null;
}
export async function cancelModelPackInstall(id: ModelPackId, headers: HeadersInit): Promise<void> {
  const response = await fetch('/api/model-packs/cancel', {
    method: 'POST',
    headers: modelPackMutationHeaders(headers),
    body: JSON.stringify({ id }),
  });
  await responseJson<{ ok?: boolean; error?: string }>(response);
}


export async function deleteModelPack(id: ModelPackId, headers: HeadersInit): Promise<void> {
  const response = await fetch('/api/model-packs/delete', {
    method: 'POST',
    headers: modelPackMutationHeaders(headers),
    body: JSON.stringify({ id }),
  });
  await responseJson<{ ok?: boolean; error?: string }>(response);
}
