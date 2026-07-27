import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { serverPlugins } from './server/plugins/index.ts';
import { seedKeystore } from './server/keystore.ts';
import { pickKey, markRateLimited, parsePoolValue, shouldFailover } from './server/key-rotation.ts';
import { productAssetsPlugin } from './server/product-assets.ts';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // load ALL env (incl. non-VITE_ prefixed) from .env.local — server-side only
  const env = loadEnv(mode, process.cwd(), '');
  // Seed the runtime keystore so the settings UI (POST /api/keys) can override any key
  // live. Server plugins (assembled in server/plugins/index.ts, shared with the
  // Electron embedded server) read the keystore through GETTERS, so a saved value
  // takes effect on the next request with no restart. The `const`s below are only the
  // startup snapshot for the `define` (initial agent capability manifest).
  seedKeystore(env);
  const aaiKey = env.ASSEMBLYAI_API_KEY || '';
  const imageKey = env.IMAGE_API_KEY || env.OPENAI_API_KEY || '';
  const geminiKey = env.GEMINI_API_KEY || '';
  const elevenKey = env.ELEVENLABS_API_KEY || '';
  const doubaoAppId = env.DOUBAO_TTS_APP_ID || '';
  const doubaoAccessKey = env.DOUBAO_TTS_ACCESS_KEY || '';
  const murekaKey = env.MUREKA_API_KEY || '';
  // MiniMax 国内开放平台 — one key gates TTS / Hailuo video / music / image.
  const minimaxKey = env.MINIMAX_API_KEY || '';
  const seedanceKey = env.SEEDANCE_API_KEY || '';
  const klingKey = env.KLING_API_KEY || '';
  const pexelsKey = env.PEXELS_API_KEY || '';
  const pixabayKey = env.PIXABAY_API_KEY || '';
  const unsplashKey = env.UNSPLASH_ACCESS_KEY || '';
  const freesoundKey = env.FREESOUND_API_KEY || '';
  const dvidsKey = env.DVIDS_API_KEY || '';
  // Rotatable pools (Assets providers): configured if the pool JSON has ≥1 key OR the
  // legacy single slot is set. Mirrors server getPool() so the boot capability snapshot
  // stays accurate when *_KEYS live in .env.local (not just the legacy single slot).
  const hasPool = (poolName: string, legacy: string): boolean =>
    parsePoolValue(env[poolName] ?? '').length > 0 || Boolean(legacy);
  const stockConfigured = hasPool('PEXELS_API_KEYS', pexelsKey)
    || hasPool('PIXABAY_API_KEYS', pixabayKey)
    || hasPool('UNSPLASH_ACCESS_KEYS', unsplashKey)
    || hasPool('FREESOUND_API_KEYS', freesoundKey)
    || hasPool('DVIDS_API_KEYS', dvidsKey);
  const transcriptionConfigured = hasPool('ASSEMBLYAI_API_KEYS', aaiKey);
  // Firecrawl (web_browser tool): .env.local or shell export (e.g. search-apis.env)
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
        stock: stockConfigured,
        transcription: transcriptionConfigured,
        sandbox: Boolean(e2bKey),
        web: Boolean(firecrawlKey),
      }),
    },
    // public/ = user runtime only (media/uploads). Product static files live in assets/
    // and are served/copied by productAssetsPlugin (URLs unchanged: /fonts, /thumbnails, …).
    publicDir: 'public',
    plugins: [react(), productAssetsPlugin(), ...serverPlugins()],
    server: {
      port: 5199,
      strictPort: true,
      proxy: {
        // AssemblyAI transcription — key injected server-side (never in browser).
        // Multi-key fail-over: pickKey() hands out the active key and we stash its
        // index on the request; if upstream returns 429/402 we park that key so the
        // NEXT request advances to a healthy one. (The in-flight 429 is still
        // forwarded to the client — retrying a streamed audio upload in-place would
        // require buffering the whole body, which is not worth it.)
        '/assemblyai': {
          target: 'https://api.assemblyai.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/assemblyai/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              const picked = pickKey('ASSEMBLYAI');
              if (picked) {
                (req as { __rotIdx?: number }).__rotIdx = picked.index;
                proxyReq.setHeader('authorization', picked.key);
              }
            });
            proxy.on('proxyRes', (proxyRes, req) => {
              const idx = (req as { __rotIdx?: number }).__rotIdx;
              if (idx != null && shouldFailover('ASSEMBLYAI', proxyRes.statusCode ?? 0)) {
                markRateLimited('ASSEMBLYAI', idx);
              }
            });
          },
        },
      },
    },
    build: {
      // Babel/Remotion/template catalogs are intentional named chunks; their
      // sizes are tracked explicitly above instead of using Vite's generic
      // 500 kB warning threshold.
      chunkSizeWarningLimit: 2_500,
      rolldownOptions: {
        checks: {
          // This diagnostic reports host I/O timing rather than a correctness
          // issue and is unstable across local and GitHub-hosted runners.
          pluginTimings: false,
        },
        output: {
          codeSplitting: {
            groups: [
              { name: 'babel', test: /node_modules[\\/]@babel[\\/]standalone/, priority: 30 },
              { name: 'templates', test: /openchatcut-templates\.json/, priority: 25, includeDependenciesRecursively: false },
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
