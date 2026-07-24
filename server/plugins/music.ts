import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { createGenerationJob, type GenerationResult } from './generation-jobs.ts';
import { saveAudioResponse } from './music-media.ts';
import { generateMureka, pickMurekaAudioUrl } from './music-mureka.ts';
import { isMinimaxCoverModel, minimaxMusicUrl } from './music-minimax.ts';
import type { MusicOptions, MusicRequest, ValidMusicRequest } from './music-types.ts';
import { validateMusicRequest } from './music-validation.ts';

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

async function minimaxResult(jobId: string, options: MusicOptions, input: ValidMusicRequest): Promise<GenerationResult> {
  const response = await fetch(await minimaxMusicUrl(options, input));
  const saved = await saveAudioResponse(response, input.audioFormat, input.sampleRate);
  return { assetId: jobId, kind: 'audio', name: input.name, ...saved };
}

async function murekaResults(jobId: string, options: MusicOptions, input: ValidMusicRequest): Promise<GenerationResult[]> {
  const urls = await generateMureka(options, input);
  return Promise.all(urls.map(async (url, index) => {
    const saved = await saveAudioResponse(await fetch(url), input.audioFormat);
    return {
      assetId: urls.length === 1 ? jobId : `${jobId}:${index + 1}`,
      kind: 'audio' as const,
      name: urls.length === 1 ? input.name : `${input.name} · ${index + 1}`,
      ...saved,
    };
  }));
}

function enqueueMusic(options: MusicOptions, input: ValidMusicRequest) {
  const model = input.provider === 'minimax' ? options.minimaxModel : options.model;
  return createGenerationJob({
    kind: 'music', provider: input.provider, mode: input.mode, prompt: input.prompt,
    name: input.name, model, count: input.count,
  }, async (jobId) => input.provider === 'minimax'
    ? minimaxResult(jobId, options, input)
    : murekaResults(jobId, options, input));
}

export function musicGenerationPlugin(options: MusicOptions): Plugin {
  return {
    name: 'openchatcut-music-generation',
    configureServer(server) {
      server.middlewares.use('/generate/music', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validateMusicRequest(await readJson(req));
          if (input.provider === 'minimax' && !options.minimaxApiKey) {
            throw new Error('MiniMax is not configured. Set MINIMAX_API_KEY in .env.local or settings panel.');
          }
          if (input.provider === 'mureka' && !options.apiKey) {
            throw new Error('Mureka is not configured. Set MUREKA_API_KEY in .env.local or settings panel.');
          }
          sendJson(res, 202, enqueueMusic(options, input));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:music] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
