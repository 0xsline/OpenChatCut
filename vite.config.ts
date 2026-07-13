import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // load ALL env (incl. non-VITE_ prefixed) from .env.local — server-side only
  const env = loadEnv(mode, process.cwd(), '');
  const base = env.LLM_BASE_URL || 'https://api.aijws.com';
  const key = env.LLM_API_KEY || '';

  return {
    plugins: [react()],
    server: {
      // Proxy /llm → relay, injecting the API key on the server so it never
      // reaches the browser (mirrors ChatCut's server-side agent key handling).
      proxy: {
        '/llm': {
          target: base,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/llm/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (key) proxyReq.setHeader('Authorization', `Bearer ${key}`);
            });
          },
        },
      },
    },
  };
});
