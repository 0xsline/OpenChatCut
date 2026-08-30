import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TranscriptWindowRoot } from './media/TranscriptWindowRoot';
import { loadProjectFonts } from './fonts/googleFonts';
import { hydratePlugins } from './plugins/store';
import { initSkins } from './skins';
import { ensureLocaleDict, getLocale, prefetchLocaleDicts } from './i18n/locale';

// Kick the active locale's dictionary off FIRST so its fetch overlaps the setup
// below; the render waits on it so no frame renders untranslated copy. Only
// this one language is fetched — the other three cost nothing until switched.
const localeReady = ensureLocaleDict(getLocale());

// Inject skin variables and apply persistent skin before rendering to avoid flashing the default color in the first frame.
initSkins();

// Register local font faces; TimelineComposition loads used Google faces on demand.
loadProjectFonts();

// The installed content plugin is registered in the runtime registry (visible to resource library/agent). Timeline rendering does not wait for it —
// The applied content has been snapshotted into state, see docs/plugin-system-design.md.
void hydratePlugins().catch(() => {});

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
const isTranscriptWindow = new URLSearchParams(window.location.search).has('transcript-window');
void localeReady.then(() => {
  createRoot(root).render(
    <StrictMode>
      {isTranscriptWindow ? <TranscriptWindowRoot /> : <App />}
    </StrictMode>,
  );
  // Warm the other languages only once the first paint is out of the way, so
  // the language switcher stays instant without competing for the boot.
  if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetchLocaleDicts);
  else setTimeout(prefetchLocaleDicts, 2_000);
});
