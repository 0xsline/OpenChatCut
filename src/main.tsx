import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadProjectFonts } from './fonts/googleFonts';

// Load Google Fonts up front so the Player preview matches the export.
loadProjectFonts();

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
