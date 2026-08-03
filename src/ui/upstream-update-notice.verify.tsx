import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopWindowControlButtons } from '../components/DesktopWindowControls';

const moduleUrl = new URL('./UpstreamUpdateNoticeView.tsx', import.meta.url);
const noticeModule = await import(moduleUrl.href).catch(() => null);

assert.ok(noticeModule, '应用应提供非阻塞的上游版本提示');

const { UpstreamUpdateNoticeView } = noticeModule;
const markup = renderToStaticMarkup(
  <div data-dashboard-chrome>
    <UpstreamUpdateNoticeView
      message="发现 OpenChatCut 新版本 V0.1.7，当前版本 V0.1.6。请前往项目仓库查看更新。"
      closeLabel="关闭"
      onDismiss={() => undefined}
    />
    <DesktopWindowControlButtons
      translate={(text) => text}
      onAction={() => undefined}
    />
  </div>,
);

assert.match(markup, /发现 OpenChatCut 新版本 V0\.1\.7/, '新版提示必须明确给出官方产品与版本');
assert.match(markup, /请前往项目仓库查看更新/, '提示应引导用户查看项目仓库');
assert.match(markup, /role="status"/, '非阻塞提示应使用状态语义');
assert.doesNotMatch(markup, /<a\b|下载|安装|自动更新/, '提示不得包含下载或自动安装入口');
assert.match(markup, /top:50%/, '更新提示应在首页垂直居中');
assert.match(markup, /left:50%/, '更新提示应在首页水平居中');
assert.match(markup, /transform:translate\(-50%,\s*-50%\)/, '更新提示应以自身中心对准窗口中心');
assert.match(markup, /aria-label="窗口控制"/, '桌面窗口控制必须与首页更新提示在同一 dashboard chrome 中可渲染');
assert.equal((markup.match(/class="cc-window-control /g) ?? []).length, 3, 'macOS 标题栏应保留三个窗口控制按钮');


console.log('upstream-update-notice.verify: dashboard-only centered upstream update notice OK');
