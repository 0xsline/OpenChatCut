import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

interface PublishConfig {
  provider?: string;
  owner?: string;
  repo?: string;
  channel?: string;
}

interface BuilderConfig {
  publish?: PublishConfig[];
  mac?: { target?: string[] };
  files?: string[];
}

async function configFor(target: string): Promise<BuilderConfig> {
  // Query isolation is intentional: the config reads CC_EB_TARGET once at module evaluation.
  process.env.CC_EB_TARGET = target;
  const moduleUrl = new URL(`../electron-builder.config.mjs?target=${target}`, import.meta.url);
  const loaded = await import(moduleUrl.href) as { default: BuilderConfig };
  return loaded.default;
}

const arm64 = await configFor('darwin-arm64');
assert.deepEqual(arm64.publish, [{
  provider: 'github',
  owner: '0xsline',
  repo: 'OpenChatCut',
  channel: 'latest-arm64',
}]);
assert.deepEqual(arm64.mac?.target, ['dmg', 'zip'], 'macOS updates need a zip artifact in addition to the DMG');
assert.ok(arm64.files?.includes('desktop-dist/native-asr-worker.mjs'));
assert.ok(arm64.files?.includes('desktop-dist/native-semantic-worker.mjs'));
assert.ok(arm64.files?.includes('desktop-dist/native-clap-worker.mjs'));
assert.ok(arm64.files?.includes('desktop-dist/native-rhythm-worker.mjs'));
assert.equal(
  arm64.files?.includes('!node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/**'),
  false,
  'the target ONNX Runtime binary must remain packaged',
);
assert.ok(
  arm64.files?.includes('!node_modules/onnxruntime-node/bin/napi-v6/win32/x64/**'),
  'foreign ONNX Runtime binaries must be excluded',
);

const x64 = await configFor('darwin-x64');
assert.equal(x64.publish?.[0]?.channel, 'latest-x64');
assert.equal(
  x64.files?.includes('!node_modules/onnxruntime-node/bin/napi-v6/darwin/x64/**'),
  false,
  'x64 packages must retain the x64 ONNX Runtime binary',
);

const linux = await configFor('linux-x64');
assert.equal(
  linux.files?.includes('desktop-dist/native-asr-worker.mjs'),
  false,
  'unsupported Linux packages must not ship native inference workers',
);
assert.ok(
  linux.files?.includes('!node_modules/onnxruntime-node/**'),
  'unsupported Linux packages must exclude ONNX Runtime entirely',
);

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};
assert.match(
  packageJson.scripts['desktop:build:main'],
  /native-rhythm-worker\.ts.*native-rhythm-worker\.mjs/,
  'desktop build must bundle the native rhythm utility process',
);
assert.match(packageJson.scripts['desktop:dist'], /--mac --arm64/, 'arm64 packaging must build every configured mac target');
assert.match(packageJson.scripts['desktop:dist:mac-x64'], /--mac --x64/, 'x64 packaging must build every configured mac target');
assert.doesNotMatch(packageJson.scripts['desktop:dist'], /--mac dmg/, 'mac packaging must not suppress update zip metadata');

const workflow = await readFile(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
for (const metadata of ['latest-arm64-mac.yml', 'latest-x64-mac.yml', 'latest-x64.yml', 'latest-x64-linux.yml']) {
  assert.ok(workflow.includes(`release/${metadata}`), `desktop jobs must upload ${metadata}`);
}
assert.doesNotMatch(workflow, /release\/\*\.yml/, 'debug YAML must not leak into release artifacts');
assert.match(workflow, /EXPECTED_VERSION="\$\{GITHUB_REF_NAME#v\}"/, 'release gate must derive its package version');
assert.match(workflow, /release\/\*\.blockmap/, 'desktop jobs must upload differential download metadata');
assert.match(workflow, /-name '\*\.zip'.* = 2/, 'release aggregation must retain both macOS update archives');
for (const blockmap of [
  'arm64.zip.blockmap',
  'x64.zip.blockmap',
  'x64.exe.blockmap',
  'x64.AppImage.blockmap',
]) {
  assert.ok(
    workflow.includes(`release-files/OpenChatCut-\${EXPECTED_VERSION}-${blockmap}`),
    `release gate must require ${blockmap}`,
  );
}
assert.match(workflow, /test -f release-files\/latest-arm64-mac\.yml/);
assert.match(workflow, /test -f release-files\/latest-x64-mac\.yml/);
assert.match(workflow, /test -f release-files\/latest-x64\.yml/);
assert.match(workflow, /test -f release-files\/latest-x64-linux\.yml/);
assert.match(workflow, /release-files\/\*/, 'GitHub Release must publish installers and update metadata together');

console.log('update-packaging.verify: per-architecture channels and release metadata contract OK');
