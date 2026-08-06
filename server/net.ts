// System proxy support for all server-side fetch traffic.
// Node's fetch (undici) ignores HTTP_PROXY/HTTPS_PROXY by default, so on
// machines that reach external APIs through a local proxy (Clash, etc.) every
// direct call fails with a network error. Installing a global ProxyAgent makes
// web_*, stock search, firecrawl, and similar calls honor the proxy env vars.
// NO_PROXY is intentionally ignored here: the user chose to route through the
// proxy for this machine, and entries like NO_PROXY=api.firecrawl.dev would
// otherwise keep the walled-off endpoints on the direct path.
import { ProxyAgent, setGlobalDispatcher } from 'undici';

let installed = false;

export function installSystemProxy(): void {
  if (installed) return;
  installed = true;
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  if (!proxy) return;
  try {
    setGlobalDispatcher(new ProxyAgent({ uri: proxy }));
  } catch (error) {
    // A broken proxy must not take the server down; direct mode stays active.
    console.warn(`[net] proxy install skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}
