import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

const moduleUrl = new URL('./UpstreamUpdateNoticeView.tsx', import.meta.url);
const noticeModule = await import(moduleUrl.href).catch(() => null);

assert.ok(noticeModule, '应用应提供非阻塞的上游版本提示');

const { UpstreamUpdateNoticeView } = noticeModule;
const markup = renderToStaticMarkup(
  <UpstreamUpdateNoticeView
    message="发现 OpenChatCut 新版本 V0.1.7，当前版本 V0.1.6。请前往项目仓库查看更新。"
    closeLabel="关闭"
    onDismiss={() => undefined}
  />,
);

assert.match(markup, /发现 OpenChatCut 新版本 V0\.1\.7/, '新版提示必须明确给出官方产品与版本');
assert.match(markup, /请前往项目仓库查看更新/, '提示应引导用户查看项目仓库');
assert.match(markup, /role="status"/, '非阻塞提示应使用状态语义');
assert.doesNotMatch(markup, /<a\b|下载|安装|自动更新/, '提示不得包含下载或自动安装入口');
assert.match(markup, /top:50%/, '更新提示应在首页垂直居中');
assert.match(markup, /left:50%/, '更新提示应在首页水平居中');
assert.match(markup, /transform:translate\(-50%,\s*-50%\)/, '更新提示应以自身中心对准窗口中心');

const mainSource = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');
const dashboardSource = readFileSync(new URL('../components/Dashboard.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(mainSource, /UpstreamUpdateNotice/, '更新提示不得全局挂载并进入编辑器页面');
assert.match(dashboardSource, /<UpstreamUpdateNotice\s*\/>/, '更新提示只应挂载在“我的工程”首页');

console.log('upstream-update-notice.verify: dashboard-only centered upstream update notice OK');
