import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { getKey } from '../keystore.ts';
import { isSafeUploadName, resolveUploadFile } from '../media-dir.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ src?: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { src?: string };
}

function uploadName(src: string): string | null {
  const match = decodeURIComponent(src.split('?')[0] ?? '').match(/^\/media\/uploads\/([^/]+)$/);
  return match?.[1] && isSafeUploadName(match[1]) ? match[1] : null;
}

export function assemblyAiUploadPlugin(): Plugin {
  return {
    name: 'openchatcut-assemblyai-upload',
    configureServer(server) {
      server.middlewares.use('/api/assemblyai-upload', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        try {
          const name = uploadName(String((await readJson(req)).src ?? '').trim());
          const file = name ? resolveUploadFile(name) : null;
          const apiKey = getKey('ASSEMBLYAI_API_KEY');
          if (!file) {
            sendJson(res, 400, { error: 'src must reference a local uploaded media file' });
            return;
          }
          if (!apiKey) {
            sendJson(res, 503, { error: 'AssemblyAI API key is not configured' });
            return;
          }
          const info = await stat(file);
          const started = Date.now();
          server.config.logger.info(`[assemblyai-upload] starting ${name} (${info.size} bytes)`);
          const response = await fetch('https://api.assemblyai.com/v2/upload', {
            method: 'POST',
            headers: { authorization: apiKey, 'content-type': 'application/octet-stream', 'content-length': String(info.size) },
            body: Readable.toWeb(createReadStream(file)),
            duplex: 'half',
          } as RequestInit);
          const body = await response.text();
          if (!response.ok) {
            server.config.logger.error(`[assemblyai-upload] failed ${name}: HTTP ${response.status} after ${Date.now() - started}ms`);
            sendJson(res, 502, { error: `AssemblyAI upload failed: HTTP ${response.status}`, detail: body.slice(0, 500) });
            return;
          }
          const parsed = JSON.parse(body) as { upload_url?: string };
          if (!parsed.upload_url) throw new Error('AssemblyAI returned no upload URL');
          server.config.logger.info(`[assemblyai-upload] completed ${name} in ${Date.now() - started}ms`);
          sendJson(res, 200, { uploadUrl: parsed.upload_url, bytes: info.size });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[assemblyai-upload] ${message}`);
          sendJson(res, 500, { error: message });
        }
      });
    },
  };
}
