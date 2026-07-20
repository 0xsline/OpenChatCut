import './index.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadProjectFonts } from './fonts/googleFonts';
import { hydratePlugins } from './plugins/store';
import { initSkins } from './skins';

// 渲染前注入皮肤变量并应用持久化皮肤,避免首帧闪默认色。
initSkins();

// Register local font faces; TimelineComposition loads used Google faces on demand.
loadProjectFonts();

// 已安装内容插件注册进运行时注册表(资源库/agent 可见)。时间线渲染不等它——
// 应用过的内容已快照进 state,见 docs/plugin-system-design.md。
void hydratePlugins().catch(() => {});

const root = document.getElementById('root');
if (!root) throw new Error('no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
