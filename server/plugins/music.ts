import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import {
  createGenerationJob,
  generationResultCheckpoint,
  registerGenerationJobResumer,
  requireGenerationResultUrls,
  type GenerationJobSnapshot,
  type GenerationResult,
  type RegisterGenerationDownload,
  type RegisterGenerationProviderTask,
} from './generation-jobs.ts';
import { saveAudioResponse } from './music-media.ts';
import { generateMureka, pickMurekaAudioUrl } from './music-mureka.ts';
import { isMinimaxCoverModel, minimaxMusicUrl } from './music-minimax.ts';
import { generateSoniloMusic, soniloMusicResult } from './music-sonilo.ts';
import type { MusicOptions, MusicRequest, ValidMusicRequest } from './music-types.ts';
import { validateMusicRequest } from './music-validation.ts';
import { fetchGeneratedResult } from './result-download.ts';

export { isMinimaxCoverModel, pickMurekaAudioUrl, validateMusicRequest };

async function readJson(req: IncomingMessage): Promise<MusicRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as MusicRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function expectedMusicResultCount(input: Pick<ValidMusicRequest, 'provider' | 'count'>): number {
  return input.provider === 'mureka' ? input.count : 1;
}

async function minimaxResult(jobId: string, input: ValidMusicRequest, url: string): Promise<GenerationResult> {
  const response = await fetchGeneratedResult(url, 'audio');
  const saved = await saveAudioResponse(response, input.audioFormat, input.sampleRate);
  return { assetId: jobId, kind: 'audio', name: input.name, ...saved };
}

async function murekaResults(jobId: string, input: ValidMusicRequest, urls: string[]): Promise<GenerationResult[]> {
  return Promise.all(urls.map(async (url, index) => {
    const saved = await saveAudioResponse(await fetchGeneratedResult(url, 'audio'), input.audioFormat);
    return {
      assetId: urls.length === 1 ? jobId : `${jobId}:${index + 1}`,
      kind: 'audio' as const,
      name: urls.length === 1 ? input.name : `${input.name} · ${index + 1}`,
      ...saved,
    };
  }));
}

async function runMusicOperation(
  operationId: string,
  input: ValidMusicRequest,
  options: MusicOptions,
  registerDownload: RegisterGenerationDownload,
  registerProviderTask: RegisterGenerationProviderTask,
  providerTaskId?: string,
  storedResultUrls: readonly string[] = [],
): Promise<GenerationResult | GenerationResult[]> {
  const expectedResultCount = expectedMusicResultCount(input);
  const checkpoint = generationResultCheckpoint(storedResultUrls, expectedResultCount, providerTaskId);
  let urls = checkpoint.urls;
  // Sonilo license ids ride alongside the single result URL; a resume from a
  // stored URL checkpoint recovers the audio, the sidecar stays best-effort.
  let soniloLicenseIds: (string | undefined)[] = [];
  if (!checkpoint.complete) {
    let providerUrls: string[];
    if (input.provider === 'minimax') providerUrls = [await minimaxMusicUrl(options, input)];
    else if (input.provider === 'sonilo') {
      const tracks = await generateSoniloMusic(
        options,
        input,
        (taskId) => registerProviderTask('sonilo', taskId),
        providerTaskId,
      );
      providerUrls = tracks.map((track) => track.url);
      soniloLicenseIds = tracks.map((track) => track.licenseId);
    } else {
      providerUrls = await generateMureka(
        options,
        input,
        (taskId) => registerProviderTask('mureka', taskId),
        providerTaskId,
      );
    }
    urls = requireGenerationResultUrls(providerUrls, expectedResultCount);
  }
  urls = requireGenerationResultUrls(urls, expectedResultCount);
  const download = () => input.provider === 'minimax'
    ? minimaxResult(operationId, input, urls[0])
    : input.provider === 'sonilo'
      ? soniloMusicResult(operationId, input, urls[0], soniloLicenseIds[0])
      : murekaResults(operationId, input, urls);
  for (const [index, url] of urls.entries()) await registerDownload(url, download, index);
  return download();
}

export function musicGenerationPlugin(options: MusicOptions): Plugin {
  for (const provider of ['mureka', 'minimax', 'sonilo'] as const) {
    registerGenerationJobResumer('submit_music', provider, async (
      snapshot: GenerationJobSnapshot,
      _update,
      registerDownload,
      registerProviderTask,
    ) => runMusicOperation(
      snapshot.operationId,
      validateMusicRequest(snapshot.params as MusicRequest),
      options,
      registerDownload,
      registerProviderTask,
      snapshot.providerTaskId,
      snapshot.resultUrls,
    ));
  }
  return {
    name: 'openchatcut-music-generation',
    configureServer(server) {
      server.middlewares.use('/generate/music', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const raw = await readJson(req);
          const input = validateMusicRequest(raw);
          if (input.provider === 'minimax' && !options.minimaxApiKey) {
            throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or 设置面板.');
          }
          if (input.provider === 'mureka' && !options.apiKey) {
            throw new Error('Mureka is not configured. Set MUREKA_API_KEY in .env.local or 设置面板.');
          }
          if (input.provider === 'sonilo' && !options.soniloApiKey) {
            throw new Error('Sonilo is not configured. Set SONILO_API_KEY in .env.local or 设置面板.');
          }
          // Sonilo has no client-selected model: /v1 routes to the latest server-side.
          const model = input.provider === 'minimax' ? options.minimaxModel
            : input.provider === 'sonilo' ? 'v1'
              : options.model;
          const submitArgs = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'operationId'));
          const submission = await createGenerationJob(
            { kind: 'music', model, ...input },
            (operationId, _update, registerDownload, registerProviderTask) => runMusicOperation(
              operationId,
              input,
              options,
              registerDownload,
              registerProviderTask,
            ),
            {
              operationId: raw.operationId,
              provider: input.provider,
              toolName: 'submit_music',
              label: input.name,
              submitArgs,
              sourceRevisions: input.sourceRevisions,
              expectedResultCount: expectedMusicResultCount(input),
            },
          );
          sendJson(res, 202, submission);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:music] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
