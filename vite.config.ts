import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin } from 'vite';
import { parse as parseDotenv } from 'dotenv';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { serverPlugins } from './server/plugins/index.ts';
import { seedKeystore, getKey } from './server/keystore.ts';
import { productAssetsPlugin } from './server/product-assets.ts';
import { runtimeProfile } from './server/runtime-profile.ts';

const appPackage = JSON.parse(readFileSync('package.json', 'utf8')) as { version?: unknown };
if (typeof appPackage.version !== 'string') throw new Error('package.json is missing a valid version');
export function applyAuthoritativeLocalProvider(
  env: Record<string, string>,
  source: string,
): void {
  const parsed = parseDotenv(source);
  const fileProvider = parsed.LLM_PROVIDER;
  if (fileProvider !== undefined) env.LLM_PROVIDER = fileProvider.trim();
}

// User/runtime media (public/media/uploads) and on-device models
// (public/media/asr-models) are served at runtime by the upload middleware and
// media-dir resolvers, NEVER from the static `dist/` build output — Vite copies
// the whole `public/` tree into `outDir`, which would otherwise bake gigabytes
// of user uploads into `dist/` on every `vite build`. This plugin strips those
// two runtime-only subtrees from the build output after the build finishes.
// It is pure build-output hygiene: it touches no runtime path, no URL semantics,
// and no persisted data (electron-builder's own `!media/uploads/**` filter stays
// as a second belt-and-suspenders guard).
const USER_MEDIA_IN_BUILD = ['media/uploads', 'media/asr-models'];

function excludeUserMediaFromBuild(): Plugin {
  let outDir = resolve(process.cwd(), 'dist');
  return {
    name: 'openchatcut-exclude-user-media',
    apply: 'build',
    configResolved(config) {
      // Honour Vite's resolved `build.outDir` (defaults to <root>/dist), so the
      // prune stays correct even if the build root or output dir is reconfigured.
      outDir = config.build.outDir;
    },
    closeBundle() {
      for (const rel of USER_MEDIA_IN_BUILD) {
        const target = resolve(outDir, rel);
        if (existsSync(target)) {
          try {
            rmSync(target, { recursive: true, force: true });
            process.stdout.write(`[vite] pruned runtime media out of build output: ${rel}\n`);
          } catch {
            // A cleanup failure must never fail the build: the runtime already
            // ignores `dist/media/` and electron-builder filters uploads too.
          }
        }
      }
    },
  };
}


// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const profile = runtimeProfile();
  // The first isolated start may bootstrap from checkout env. Once profile settings
  // exist, only the wrapper-merged process env is authoritative for that profile.
  const env = profile.mode === 'isolated-dev' && existsSync(profile.keystorePath)
    ? Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
    : loadEnv(mode, process.cwd(), '');
  // Keep the default checkout's explicit .env.local provider authoritative over
  // unrelated host-shell values; isolated profiles remain wrapper-controlled.
  if (profile.mode !== 'isolated-dev' && existsSync('.env.local')) {
    applyAuthoritativeLocalProvider(env, readFileSync('.env.local', 'utf8'));
  }
  if (profile.mode === 'isolated-dev') {
    process.stdout.write(`[OpenChatCut] isolated profile ${profile.id} · ${profile.rootDir}\n`);
  }
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
  // MiniMax domestic open platform — one key gates TTS / Hailuo video / music / image.
  const minimaxKey = env.MINIMAX_API_KEY || '';
  const seedanceKey = env.SEEDANCE_API_KEY || '';
  const klingKey = env.KLING_API_KEY || '';
  const pexelsKey = env.PEXELS_API_KEY || '';
  const pixabayKey = env.PIXABAY_API_KEY || '';
  const unsplashKey = env.UNSPLASH_ACCESS_KEY || '';
  const freesoundKey = env.FREESOUND_API_KEY || '';
  // Firecrawl (web_browser tool): .env.local or shell export (e.g. search-apis.env)
  const firecrawlKey = env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY || '';
  const e2bKey = env.E2B_API_KEY || process.env.E2B_API_KEY || '';
  // E2B_TEMPLATE (+ its process.env fallback) is now read live via the keystore getter below.

  return {
    // Server-computed manifest of which key-gated capabilities are configured,
    // injected for the agent's system prompt (src/agent/capabilities.ts). BOOLEANS
    // ONLY — no key value is ever exposed to the browser.
    define: {
      __APP_VERSION__: JSON.stringify(appPackage.version),
      __CONFIGURED_CAPS__: JSON.stringify({
        image: Boolean(imageKey || geminiKey || minimaxKey),
        voice: Boolean((doubaoAppId && doubaoAccessKey) || elevenKey || minimaxKey),
        video: Boolean(seedanceKey || klingKey || minimaxKey),
        music: Boolean(murekaKey || minimaxKey),
        sound: Boolean(elevenKey),
        stock: Boolean(pexelsKey || pixabayKey || unsplashKey || freesoundKey),
        transcription: Boolean(aaiKey),
        sandbox: Boolean(e2bKey),
        web: Boolean(firecrawlKey),
      }),
    },
    // public/ = user runtime only (media/uploads). Product static files live in assets/
    // and are served/copied by productAssetsPlugin (URLs unchanged: /fonts, /thumbnails, …).
    publicDir: 'public',
    plugins: [react(), productAssetsPlugin(), excludeUserMediaFromBuild(), ...serverPlugins()],
    server: {
      port: 5199,
      strictPort: true,
      // Pre-transform the editor entry graph at startup so the first tab
      // (and chat hydration) renders without a multi-second compile stall.
      warmup: {
        clientFiles: ['/src/main.tsx'],
      },
      fs: {
        // Worktrees may symlink node_modules to the primary checkout. Keep
        // imported runtime assets (for example ONNX Runtime WASM) readable.
        allow: [searchForWorkspaceRoot(process.cwd()), realpathSync('node_modules')],
      },
      open: '/',
      proxy: {
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
