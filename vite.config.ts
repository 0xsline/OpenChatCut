import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { exportPlugin } from './vite-plugin-export.ts';
import { uploadPlugin } from './vite-plugin-upload.ts';
import { imageGenerationPlugin } from './vite-plugin-image.ts';
import { voiceGenerationPlugin } from './vite-plugin-voice.ts';
import { soundGenerationPlugin } from './vite-plugin-sound.ts';
import { musicGenerationPlugin } from './vite-plugin-music.ts';
import { videoGenerationPlugin } from './vite-plugin-video.ts';
import { e2bPlugin } from './vite-plugin-e2b.ts';
import { subtitleExportPlugin } from './vite-plugin-subtitles.ts';
import { generationProgressPlugin } from './vite-generation-jobs.ts';
import { stockSearchPlugin } from './vite-plugin-stock.ts';
import { isolatePlugin } from './vite-plugin-isolate.ts';
import { firecrawlPlugin } from './vite-plugin-firecrawl.ts';
import { settingsPlugin } from './vite-plugin-settings.ts';
import { seedKeystore, getKey } from './vite-keystore.ts';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // load ALL env (incl. non-VITE_ prefixed) from .env.local — server-side only
  const env = loadEnv(mode, process.cwd(), '');
  // Seed the runtime keystore so the settings UI (POST /api/keys) can override any key
  // live. Plugin key/baseUrl fields below are GETTERS reading the keystore (with the
  // official default as fallback for base URLs), so a saved value takes effect on the
  // next request with no restart. The `const`s below are only the startup snapshot for
  // the `define` (initial agent capability manifest) — except `base`, the LLM proxy
  // target, which is fixed at server startup (the settings UI marks it restart-required).
  seedKeystore(env);
  const base = env.LLM_BASE_URL || 'https://api.aijws.com';
  const key = env.LLM_API_KEY || '';
  const aaiKey = env.ASSEMBLYAI_API_KEY || '';
  const imageKey = env.IMAGE_API_KEY || env.OPENAI_API_KEY || '';
  const geminiKey = env.GEMINI_API_KEY || '';
  const geminiModel = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  const elevenKey = env.ELEVENLABS_API_KEY || '';
  const elevenModel = env.ELEVENLABS_TTS_MODEL || 'eleven_multilingual_v2';
  const doubaoAppId = env.DOUBAO_TTS_APP_ID || '';
  const doubaoAccessKey = env.DOUBAO_TTS_ACCESS_KEY || '';
  const doubaoResourceId = env.DOUBAO_TTS_RESOURCE_ID || 'seed-tts-2.0';
  const soundModel = env.ELEVENLABS_SOUND_MODEL || 'eleven_text_to_sound_v2';
  const murekaKey = env.MUREKA_API_KEY || '';
  const murekaModel = env.MUREKA_MUSIC_MODEL || 'auto';
  // MiniMax 国内开放平台 — one key gates TTS / Hailuo video / music / image.
  const minimaxKey = env.MINIMAX_API_KEY || '';
  const minimaxTtsModel = env.MINIMAX_TTS_MODEL || 'speech-2.6-hd';
  const minimaxVideoModel = env.MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-02';
  const minimaxMusicModel = env.MINIMAX_MUSIC_MODEL || 'music-2.6';
  const minimaxImageModel = env.MINIMAX_IMAGE_MODEL || 'image-01';
  const seedanceKey = env.SEEDANCE_API_KEY || '';
  const seedanceModel = env.SEEDANCE_VIDEO_MODEL || 'doubao-seedance-2-0-260128';
  const klingKey = env.KLING_API_KEY || '';
  const klingModel = env.KLING_VIDEO_MODEL || 'kling-v3-omni';
  const pexelsKey = env.PEXELS_API_KEY || '';
  const pixabayKey = env.PIXABAY_API_KEY || '';
  // Firecrawl (source web_browser): .env.local or shell export (e.g. search-apis.env)
  const firecrawlKey = env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY || '';
  const e2bKey = env.E2B_API_KEY || process.env.E2B_API_KEY || '';
  // E2B_TEMPLATE (+ its process.env fallback) is now read live via the keystore getter below.

  return {
    // Server-computed manifest of which key-gated capabilities are configured,
    // injected for the agent's system prompt (src/agent/capabilities.ts). BOOLEANS
    // ONLY — no key value is ever exposed to the browser.
    define: {
      __CONFIGURED_CAPS__: JSON.stringify({
        image: Boolean(imageKey || geminiKey || minimaxKey),
        voice: Boolean((doubaoAppId && doubaoAccessKey) || elevenKey || minimaxKey),
        video: Boolean(seedanceKey || klingKey || minimaxKey),
        music: Boolean(murekaKey || minimaxKey),
        sound: Boolean(elevenKey),
        stock: Boolean(pexelsKey || pixabayKey),
        transcription: Boolean(aaiKey),
        sandbox: Boolean(e2bKey),
        web: Boolean(firecrawlKey),
      }),
    },
    plugins: [react(), settingsPlugin(), exportPlugin(), uploadPlugin(), imageGenerationPlugin({
      get baseUrl() { return getKey('IMAGE_BASE_URL') || 'https://api.openai.com'; },
      get apiKey() { return getKey('IMAGE_API_KEY') || getKey('OPENAI_API_KEY'); },
      get geminiBaseUrl() { return getKey('GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com'; },
      get geminiApiKey() { return getKey('GEMINI_API_KEY'); },
      geminiModel,
      get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
      get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
      minimaxModel: minimaxImageModel,
    }), voiceGenerationPlugin({
      get elevenBaseUrl() { return getKey('ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io'; },
      get elevenApiKey() { return getKey('ELEVENLABS_API_KEY'); },
      elevenModel,
      get doubaoBaseUrl() { return getKey('DOUBAO_TTS_BASE_URL') || 'https://openspeech.bytedance.com'; },
      get doubaoAppId() { return getKey('DOUBAO_TTS_APP_ID'); },
      get doubaoAccessKey() { return getKey('DOUBAO_TTS_ACCESS_KEY'); },
      doubaoResourceId,
      get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
      get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
      minimaxModel: minimaxTtsModel,
    }), soundGenerationPlugin({ get baseUrl() { return getKey('ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io'; }, get apiKey() { return getKey('ELEVENLABS_API_KEY'); }, model: soundModel }),
    musicGenerationPlugin({
      get baseUrl() { return getKey('MUREKA_BASE_URL') || 'https://api.mureka.ai'; }, get apiKey() { return getKey('MUREKA_API_KEY'); }, model: murekaModel,
      get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
      get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
      minimaxModel: minimaxMusicModel,
    }),
    videoGenerationPlugin({
      get seedanceBaseUrl() { return getKey('SEEDANCE_BASE_URL') || 'https://ark.cn-beijing.volces.com/api/v3'; }, get seedanceApiKey() { return getKey('SEEDANCE_API_KEY'); }, seedanceModel,
      get klingBaseUrl() { return getKey('KLING_BASE_URL') || 'https://api-singapore.klingai.com'; }, get klingApiKey() { return getKey('KLING_API_KEY'); }, klingModel,
      get minimaxBaseUrl() { return getKey('MINIMAX_BASE_URL') || 'https://api.minimaxi.com'; },
      get minimaxApiKey() { return getKey('MINIMAX_API_KEY'); },
      minimaxModel: minimaxVideoModel,
    }),
    generationProgressPlugin(),
    subtitleExportPlugin(),
    stockSearchPlugin({ get pexelsApiKey() { return getKey('PEXELS_API_KEY'); }, get pixabayApiKey() { return getKey('PIXABAY_API_KEY'); } }),
    isolatePlugin(),
    firecrawlPlugin({ get apiKey() { return getKey('FIRECRAWL_API_KEY'); } }),
    e2bPlugin({ get apiKey() { return getKey('E2B_API_KEY'); }, get template() { return getKey('E2B_TEMPLATE') || undefined; } }),
    ],
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
              const k = getKey('LLM_API_KEY') || key;  // live: settings UI can override .env.local
              if (k) {
                proxyReq.setHeader('x-api-key', k);
                proxyReq.setHeader('anthropic-version', '2023-06-01');
                proxyReq.setHeader('Authorization', `Bearer ${k}`); // relay also accepts Bearer
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
              const ak = getKey('ASSEMBLYAI_API_KEY') || aaiKey;  // live override
              if (ak) proxyReq.setHeader('authorization', ak);
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
