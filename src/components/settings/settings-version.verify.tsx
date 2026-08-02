import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

const moduleUrl = new URL('./SettingsVersionControl.tsx', import.meta.url);
const versionModule = await import(moduleUrl.href).catch(() => null);

assert.ok(versionModule, '设置标题栏应提供独立的版本与检查更新控件');

const { SettingsVersionControl } = versionModule;
let requested = false;
const markup = renderToStaticMarkup(
  <SettingsVersionControl
    versionLabel="当前版本号：V0.1.6"
    checkLabel="检查更新"
    checkingLabel="检查中…"
    checking={false}
    onCheck={() => { requested = true; }}
  />,
);

assert.match(markup, /当前版本号：V0\.1\.6/, '设置标题栏必须展示 package.json 对应版本');
assert.match(markup, />检查更新<\/button>/, '版本号旁必须提供手动检查入口');
assert.doesNotMatch(markup, /自动更新|下载|安装/, '检查控件不得提供自动更新入口');

const element = SettingsVersionControl({
  versionLabel: '当前版本号：V0.1.6',
  checkLabel: '检查更新',
  checkingLabel: '检查中…',
  checking: false,
  onCheck: () => { requested = true; },
});
const button = element.props.children[1];
button.props.onClick();
assert.equal(requested, true, '点击检查更新必须触发上游查询');

console.log('settings-version.verify: current version and manual check control OK');

