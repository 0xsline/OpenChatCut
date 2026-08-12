// Cross-Origin-Isolation for WebAssembly threading.
//
// onnxruntime-web ships a threaded wasm build (ort-wasm-simd-threaded) that
// is only activated when SharedArrayBuffer is available, which requires
// crossOriginIsolated = true (COOP same-origin + COEP credentialless). Without
// it, local ASR runs single-threaded and long audio transcription is several
// times slower. The app serves all resources same-origin, so credentialless
// COEP keeps external font stylesheets working while enabling threading.
import type { Plugin } from 'vite';

export function crossOriginIsolationPlugin(): Plugin {
  return {
    name: 'openchatcut-cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        next();
      });
    },
  };
}
