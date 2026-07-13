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
      },
    },
  };
});
