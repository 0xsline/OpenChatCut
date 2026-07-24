import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadProjectFonts } from './fonts/googleFonts';
import { hydratePlugins } from './plugins/store';
import { initSkins } from './skins';

// Inject skin variables and apply persistent skin before rendering to avoid flashing color in the first frame.
initSkins();

// Register local font faces; TimelineComposition loads used Google faces on demand.
loadProjectFonts();

// Installed content plug-ins are registered in the runtime registry (visible in the resource library/agent). Timeline rendering does not wait for it——
// The applied content has been snapshotted into state, see docs/plugin-system-design.md.
void hydratePlugins().catch(() => {});

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
