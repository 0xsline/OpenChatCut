import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

import { saveVoiceAudio, saveVoiceSubtitle } from './voice-media.ts';
import { doubaoVoice, elevenLabsVoice, minimaxVoice } from './voice-providers.ts';
import type { VoiceOptions, VoiceRequest } from './voice-types.ts';
import { validateVoiceRequest } from './voice-validation.ts';

export { validateVoiceRequest };

async function readJson(req: IncomingMessage): Promise<VoiceRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 1_000_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as VoiceRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function audioDescriptor(provider: 'elevenlabs' | 'doubao' | 'minimax', outputFormat: string, audioFormat: string, sampleRate: number) {
  if (provider === 'elevenlabs') {
    const [codec, rate] = outputFormat.split('_');
    return { codec, sampleRate: Number(rate) };
  }
  if (provider === 'minimax') return { codec: audioFormat, sampleRate };
  return { codec: 'mp3', sampleRate: 24_000 };
}

export function voiceGenerationPlugin(options: VoiceOptions): Plugin {
  return {
    name: 'openchatcut-voice-generation',
    configureServer(server) {
      server.middlewares.use('/generate/voice', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          const input = validateVoiceRequest(await readJson(req));
          const minimax = input.provider === 'minimax' ? await minimaxVoice(options, input) : undefined;
          const bytes = input.provider === 'elevenlabs' ? await elevenLabsVoice(options, input)
            : input.provider === 'doubao' ? await doubaoVoice(options, input) : minimax!.audio;
          const audio = audioDescriptor(input.provider, input.outputFormat, input.audioFormat, input.sampleRate);
          const saved = await saveVoiceAudio(bytes, audio.codec, audio.sampleRate, input.provider === 'doubao' ? input.pitch ?? 0 : 0);
          const subtitlePath = minimax?.subtitleUrl ? await saveVoiceSubtitle(minimax.subtitleUrl) : undefined;
          sendJson(res, 200, { ...saved, subtitlePath });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:voice] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
