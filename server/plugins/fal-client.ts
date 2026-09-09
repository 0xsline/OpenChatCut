import { createFalClient } from '@fal-ai/client';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { getKey } from '../keystore.ts';
import { mimeFor } from '../media-dir.ts';
import { proxyDispatcher } from '../outbound-proxy.ts';
import { localImageAssetPath, type ProviderImage } from './image-provider-clients.ts';
import { falTask, runFalQueue } from './fal-provider.ts';
import type { RegisterGenerationProviderTask } from './generation-jobs.ts';
import { falVideoCatalogInput, type ValidVideoRequest } from './video-validation.ts';
import { buildFalCatalogImageRequest, buildFalCatalogVideoRequest, type FalCatalogInput } from './fal-catalog-input.ts';

function client() {
  const credentials = getKey('FAL_KEY').trim();
  if (!credentials) throw new Error('Fal is not configured. Set FAL_KEY in .env.local and restart.');
  return createFalClient({ credentials, fetch: (url, init) => fetch(url, {
    ...init, dispatcher: proxyDispatcher(), signal: init?.signal ?? AbortSignal.timeout(5 * 60_000),
  } as RequestInit) });
}

async function uploadReference(fal: ReturnType<typeof client>, path: string): Promise<string> {
  const file = localImageAssetPath(path);
  const mime = mimeFor(file);
  const limit = mime.startsWith('audio/') ? 15 : mime.startsWith('video/') ? 50 : 30;
  if ((await stat(file)).size > limit * 1024 * 1024) throw new Error(`Fal reference exceeds ${limit} MB`);
  return fal.storage.upload(new File([await readFile(file)], basename(file), { type: mime }));
}

/** Catalog generation keeps model selection explicit and validates before uploads. */
export async function generateFalCatalogImage(body: FalCatalogInput): Promise<ProviderImage[]> {
  buildFalCatalogImageRequest(body);
  const fal = client();
  const imageUrls = await Promise.all((body.imageUrls ?? []).map((path) => uploadReference(fal, path)));
  const result = await runFalQueue(fal, buildFalCatalogImageRequest({ ...body, imageUrls }), async () => {}) as { images?: ProviderImage[]; image?: ProviderImage };
  const images = result.images ?? (result.image ? [result.image] : []);
  if (!images.length || images.some((image) => !image.url)) throw new Error('Fal returned no image URLs');
  return images;
}

export async function generateFalVideo(
  body: ValidVideoRequest,
  register: RegisterGenerationProviderTask,
  existingTaskId?: string,
): Promise<string> {
  const fal = client();
  // Resume uses the recorded endpoint and request ID, without re-uploading media.
  let request;
  if (existingTaskId) {
    request = { endpoint: falTask(existingTaskId).endpoint, input: {} };
  } else {
    if (body.model !== 'fal') throw new Error('New Fal video requests require model=fal and a concrete falModel');
    const build = (input: ValidVideoRequest) => buildFalCatalogVideoRequest(falVideoCatalogInput(input));
    build(body);
    const upload = (path: string) => uploadReference(fal, path);
    request = build({
      ...body,
      firstFramePath: body.firstFramePath ? await upload(body.firstFramePath) : undefined,
      lastFramePath: body.lastFramePath ? await upload(body.lastFramePath) : undefined,
      refImagePaths: await Promise.all(body.refImagePaths.map(upload)),
      refVideoPaths: await Promise.all(body.refVideoPaths.map(upload)),
      refAudioPaths: await Promise.all(body.refAudioPaths.map(upload)),
    });
  }
  const result = await runFalQueue(fal, request, register, existingTaskId) as { video?: { url?: string } };
  if (!result.video?.url) throw new Error('Fal returned no video URL');
  return result.video.url;
}
