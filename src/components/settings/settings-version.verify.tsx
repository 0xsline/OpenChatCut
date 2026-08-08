import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

const moduleUrl = new URL('./SettingsVersionControl.tsx', import.meta.url);
const versionModule = await import(moduleUrl.href).catch(() => null);

assert.ok(versionModule, '设置标题栏应提供独立的版本与检查更新控件');

const { SettingsVersionControl } = versionModule;
let requested = false;
const markup = renderToStaticMarkup(
  <SettingsVersionControl
    versionLabel="当前版本号：V0.1.9"
    actionLabel="下载更新"
    disabled={false}
    onAction={() => { requested = true; }}
  />,
);

assert.match(markup, /当前版本号：V0\.1\.9/, '设置标题栏必须展示 package.json 对应版本');
assert.match(markup, />下载更新<\/button>/, '桌面版发现新版后必须提供直接下载入口');
assert.doesNotMatch(markup, /自动更新/, '下载必须保留用户确认，不得变成静默自动更新');

const element = SettingsVersionControl({
  versionLabel: '当前版本号：V0.1.9',
  actionLabel: '下载更新',
  disabled: false,
  onAction: () => { requested = true; },
});
const button = element.props.children[1];
button.props.onClick();
assert.equal(requested, true, '点击下载更新必须触发受控更新动作');

console.log('settings-version.verify: current version and manual check control OK');
