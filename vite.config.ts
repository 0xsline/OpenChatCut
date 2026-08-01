import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { serverPlugins } from './server/plugins/index.ts';
import { seedKeystore, getKey, computeCaps } from './server/keystore.ts';
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
  const caps = computeCaps();
  // E2B_TEMPLATE (+ its process.env fallback) is now read live via the keystore getter below.

  return {
    // Server-computed manifest of which key-gated capabilities are configured,
    // injected for the agent's system prompt (src/agent/capabilities.ts). BOOLEANS
    // ONLY — no key value is ever exposed to the browser.
    define: {
      __CONFIGURED_CAPS__: JSON.stringify({
        image: caps.image,
        voice: caps.voice,
        video: caps.video,
        music: caps.music,
        sound: caps.sound,
        stock: caps.stock,
        transcription: caps.transcription,
        sandbox: caps.sandbox,
        web: caps.web,
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
        '/assemblyai': {
          target: 'https://api.assemblyai.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/assemblyai/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              const ak = getKey('ASSEMBLYAI_API_KEY');  // live override
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
