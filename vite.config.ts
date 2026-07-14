import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { exportPlugin } from './vite-plugin-export.ts';
import { uploadPlugin } from './vite-plugin-upload.ts';
import { imageGenerationPlugin } from './vite-plugin-image.ts';
import { voiceGenerationPlugin } from './vite-plugin-voice.ts';
import { soundGenerationPlugin } from './vite-plugin-sound.ts';
import { musicGenerationPlugin } from './vite-plugin-music.ts';
import { videoGenerationPlugin } from './vite-plugin-video.ts';
import { subtitleExportPlugin } from './vite-plugin-subtitles.ts';
import { generationProgressPlugin } from './vite-generation-jobs.ts';
import { stockSearchPlugin } from './vite-plugin-stock.ts';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // load ALL env (incl. non-VITE_ prefixed) from .env.local — server-side only
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.LLM_BASE_URL || 'https://api.aijws.com';
  const key = env.LLM_API_KEY || '';
  const aaiKey = env.ASSEMBLYAI_API_KEY || '';
  const imageBase = env.IMAGE_BASE_URL || 'https://api.openai.com';
  const imageKey = env.IMAGE_API_KEY || env.OPENAI_API_KEY || '';
  const geminiBase = env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com';
  const geminiKey = env.GEMINI_API_KEY || '';
  const geminiModel = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const elevenBase = env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
  const elevenKey = env.ELEVENLABS_API_KEY || '';
  const elevenModel = env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
  const doubaoBase = env.DOUBAO_TTS_BASE_URL || 'https://openspeech.bytedance.com';
  const doubaoAppId = env.DOUBAO_TTS_APP_ID || '';
  const doubaoAccessKey = env.DOUBAO_TTS_ACCESS_KEY || '';
  const doubaoResourceId = env.DOUBAO_TTS_RESOURCE_ID || 'seed-tts-2.0';
  const soundModel = env.ELEVENLABS_SOUND_MODEL || 'eleven_text_to_sound_v2';
  const murekaBase = env.MUREKA_BASE_URL || 'https://api.mureka.ai';
  const murekaKey = env.MUREKA_API_KEY || '';
  const murekaModel = env.MUREKA_MUSIC_MODEL || 'auto';
  const seedanceBase = env.SEEDANCE_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3';
  const seedanceKey = env.SEEDANCE_API_KEY || '';
  const seedanceModel = env.SEEDANCE_VIDEO_MODEL || 'doubao-seedance-2-0-260128';
  const klingBase = env.KLING_BASE_URL || 'https://api-singapore.klingai.com';
  const klingKey = env.KLING_API_KEY || '';
  const klingModel = env.KLING_VIDEO_MODEL || 'kling-v3-omni';
  const pexelsKey = env.PEXELS_API_KEY || '';
  const pixabayKey = env.PIXABAY_API_KEY || '';

  return {
    plugins: [react(), exportPlugin(), uploadPlugin(), imageGenerationPlugin({
      baseUrl: imageBase,
      apiKey: imageKey,
      geminiBaseUrl: geminiBase,
      geminiApiKey: geminiKey,
      geminiModel,
    }), voiceGenerationPlugin({
      elevenBaseUrl: elevenBase,
      elevenApiKey: elevenKey,
      elevenModel,
      doubaoBaseUrl: doubaoBase,
      doubaoAppId,
      doubaoAccessKey,
      doubaoResourceId,
    }), soundGenerationPlugin({ baseUrl: elevenBase, apiKey: elevenKey, model: soundModel }),
    musicGenerationPlugin({ baseUrl: murekaBase, apiKey: murekaKey, model: murekaModel }),
    videoGenerationPlugin({ seedanceBaseUrl: seedanceBase, seedanceApiKey: seedanceKey, seedanceModel, klingBaseUrl: klingBase, klingApiKey: klingKey, klingModel }),
    generationProgressPlugin(),
    subtitleExportPlugin(),
    stockSearchPlugin({ pexelsApiKey: pexelsKey, pixabayApiKey: pixabayKey })],
    server: {
      port: 5199,
      strictPort: true,
      // Proxy /llm → relay, injecting the API key on the server so it never
      // reaches the browser (mirrors ChatCut's server-side agent key handling).
      // The agent uses Anthropic's native Messages API (/v1/messages), which
      // authenticates with x-api-key + anthropic-version.
      proxy: {
        '/llm': {
          target: base,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/llm/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (key) {
                proxyReq.setHeader('x-api-key', key);
                proxyReq.setHeader('anthropic-version', '2023-06-01');
                proxyReq.setHeader('Authorization', `Bearer ${key}`); // relay also accepts Bearer
              }
            });
            // The relay returns non-streaming bodies as valid Anthropic JSON
            // but with a wrong Content-Type; the @anthropic-ai/sdk only parses
            // bodies typed as application/json, so force it. MUST leave SSE
            // (text/event-stream) untouched or streaming breaks.
            proxy.on('proxyRes', (proxyRes) => {
              const ct = proxyRes.headers['content-type'] || '';
              if (!ct.includes('application/json') && !ct.includes('text/event-stream')) {
                proxyRes.headers['content-type'] = 'application/json';
              }
            });
          },
        },
        // AssemblyAI transcription — key injected server-side (never in browser).
        '/assemblyai': {
          target: 'https://api.assemblyai.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/assemblyai/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (aaiKey) proxyReq.setHeader('authorization', aaiKey);
            });
          },
        },
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'babel', test: /node_modules[\\/]@babel[\\/]standalone/, priority: 30 },
              { name: 'templates', test: /chatcut-templates\.json/, priority: 25, includeDependenciesRecursively: false },
              { name: 'remotion', test: /node_modules[\\/](?:@remotion|remotion)[\\/]/, priority: 20 },
              { name: 'anthropic', test: /node_modules[\\/]@anthropic-ai[\\/]sdk/, priority: 15 },
              { name: 'react', test: /node_modules[\\/](?:react|react-dom)[\\/]/, priority: 10 },
            ],
          },
        },
      },
    },
  };
});
