// Desktop packaging configuration, introduced in M2 and expanded to three targets in M4. Output: release/.
// Run npm run desktop:dist(:mac-x64 / :win). The pipeline is Vite build → esbuild main process
// → prebuild Remotion bundle → prepare target binaries → electron-builder.
// Notes:
// - files includes only the main-process bundle; electron-builder collects production node_modules automatically.
//   @remotion/renderer is required at runtime, while @remotion/bundler is used only during prebuild.
//   Keep only the CC_EB_TARGET compositor package because each one is about 180 MB.
// - The app ships as an asar archive (one file to map instead of tens of thousands of small
//   files at startup). Anything that must be spawned or dlopen'ed stays a real file via
//   asarUnpack, and code resolves it through server/media-binaries.ts unpackedPath(). The
//   Remotion compositor is the exception: @remotion/renderer chmods and spawns it at the path
//   it resolved, which names the archive even when unpacked, so desktop/remotion-binaries.ts
//   mirrors it into userData and CC_REMOTION_BINARIES_DIR points the renderer there.
// - dist and the prebuilt Remotion bundle use extraResources. prepare-target populates the
//   chrome-headless-shell staging directory, main.ts locates it through process.resourcesPath,
//   and the bundle is copied into writable userData on first launch.
// - Without signing credentials, macOS builds use ad-hoc signing and Windows builds trigger SmartScreen.
//   Add certificates and notarization for official distribution.
// - macOS uses a pre-generated standard icns to avoid corrupt 48 px layers during conversion.
//   Windows continues deriving its ico from the web PNG.

// Package names follow @remotion/renderer optionalDependencies: win32 uses -msvc and Linux includes a libc suffix.
const COMPOSITORS = [
  'darwin-arm64', 'darwin-x64', 'win32-x64-msvc',
  'linux-arm64-gnu', 'linux-arm64-musl', 'linux-x64-gnu', 'linux-x64-musl',
];
const ONNX_RUNTIME_TARGETS = [
  'darwin/arm64', 'darwin/x64', 'win32/arm64', 'win32/x64', 'linux/arm64', 'linux/x64',
];
const TARGET_COMPOSITOR = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'win32-x64': 'win32-x64-msvc', 'linux-x64': 'linux-x64-gnu' };
const target = process.env.CC_EB_TARGET ?? `${process.platform}-${process.arch}`;
const keep = TARGET_COMPOSITOR[target] ?? target;
const nativeInferenceSupported = target.startsWith('darwin-')
  || target.startsWith('win32-') || target.startsWith('linux-');
const keepOnnxRuntime = nativeInferenceSupported ? target.replace('-', '/').replace('-msvc', '') : null;
const nativeInferenceWorkers = nativeInferenceSupported
  ? [
      'desktop-dist/native-asr-worker.mjs',
      'desktop-dist/native-semantic-worker.mjs',
      'desktop-dist/native-clap-worker.mjs',
      'desktop-dist/native-rhythm-worker.mjs',
    ]
  : [];
const onnxRuntimeFilters = keepOnnxRuntime
  ? ONNX_RUNTIME_TARGETS
      .filter((runtimeTarget) => runtimeTarget !== keepOnnxRuntime)
      .map((runtimeTarget) => `!node_modules/onnxruntime-node/bin/napi-v6/${runtimeTarget}/**`)
  : ['!node_modules/onnxruntime-node/**'];
// sqlite-vec publishes separate extension packages whose suffixes do not all
// match Node's process.platform names. Keep only the package for this artifact.
const SQLITE_VEC_PACKAGES = [
  'darwin-arm64', 'darwin-x64', 'windows-x64', 'linux-arm64', 'linux-x64',
];
const TARGET_SQLITE_VEC_PACKAGE = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'win32-x64': 'windows-x64',
  'linux-arm64': 'linux-arm64',
  'linux-x64': 'linux-x64',
};
const keepSqliteVec = TARGET_SQLITE_VEC_PACKAGE[target];
const sqliteVecFilters = SQLITE_VEC_PACKAGES
  .filter((packageSuffix) => packageSuffix !== keepSqliteVec)
  .map((packageSuffix) => `!node_modules/sqlite-vec-${packageSuffix}/**`);
const updateChannel = target.includes('arm64') ? 'latest-arm64' : 'latest-x64';
const hasMacSigningCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

export default {
  appId: 'dev.openchatcut.app',
  productName: 'OpenChatCut',
  artifactName: '${productName}-${version}-${arch}.${ext}',
  directories: { output: 'release' },
  // 7z LZMA maximum compression for the distributable installers (dmg/zip/nsis/AppImage).
  // Trade-off: noticeably slower packaging time in exchange for a smaller final download.
  // The app.asar content itself is handled by the `compression` setting; native binaries
  // (onnxruntime-node, ffmpeg-static, @remotion/compositor, sqlite-vec) stay unpacked per asarUnpack.
  compression: 'maximum',
  publish: [{
    provider: 'github',
    owner: '0xsline',
    repo: 'OpenChatCut',
    channel: updateChannel,
  }],
  files: [
    'desktop-dist/main.mjs',
    'desktop-dist/preload.cjs',
    ...nativeInferenceWorkers,
    'package.json',
    // Keep only the target compositor; renderer selects its package from process.platform at runtime.
    ...COMPOSITORS.filter((c) => c !== keep).map((c) => `!node_modules/@remotion/compositor-${c}/**`),
    // onnxruntime-node publishes every platform in one package; ship only this artifact's binary.
    ...onnxRuntimeFilters,
    // sqlite-vec (semantic vectors): ship only the target platform's vec0 extension.
    ...sqliteVecFilters,
  ],
  asar: true,
  // Real files next to the archive (app.asar.unpacked): executables and shared libraries
  // that a child process or SQLite must open by path. Node's own require of a .node binding
  // is redirected here by Electron; spawn/dlopen paths go through unpackedPath().
  asarUnpack: [
    'node_modules/ffmpeg-static/**',
    'node_modules/@ffprobe-installer/**',
    'node_modules/@remotion/compositor-*/**',
    'node_modules/onnxruntime-node/**',
    'node_modules/sqlite-vec-*/**',
    'node_modules/@github/copilot-*/**',
    'node_modules/koffi/**',
  ],
  extraResources: [
    // Exclude media/uploads because Vite copies all of public/ into dist, which would embed gigabytes of user assets.
    // uploadsMiddleware serves /media/uploads directly from the asset directory (userData in packaged builds),
    // so resources/dist never needs those files.
    { from: 'dist', to: 'dist', filter: ['**/*', '!media/uploads/**'] },
    { from: 'desktop-dist/remotion-bundle', to: 'remotion-bundle' },
    { from: 'desktop-dist/chrome-headless-shell', to: 'chrome-headless-shell' },
  ],
  npmRebuild: false,
  mac: {
    target: ['dmg', 'zip'],
    category: 'public.app-category.video',
    icon: 'assets/branding/openchatcut-icon.icns',
    entitlements: 'desktop/entitlements.mac.plist',
    entitlementsInherit: 'desktop/entitlements.mac.plist',
    // Hardened runtime is required for Developer ID distribution. Ad-hoc local
    // and CI packages have no notarization identity, so enabling it only adds
    // library-validation restrictions without a security benefit.
    hardenedRuntime: hasMacSigningCertificate,
    // Sign the bundle ad hoc without a Developer ID so Finder still treats it as executable.
    // When CI injects CSC_LINK / CSC_NAME, electron-builder selects the official certificate automatically.
    ...(hasMacSigningCertificate ? {} : { identity: '-' }),
  },
  win: {
    target: ['nsis'],
    icon: 'public/openchatcut-icon.png',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: ['AppImage'],
    icon: 'public/openchatcut-icon.png',
    category: 'AudioVideo',
    // Keep the executable name stable for release/linux-unpacked/openchatcut and CI smoke tests.
    executableName: 'openchatcut',
    // Pair with package.json desktopName so desktop environments associate the window with its .desktop entry.
    syncDesktopName: true,
  },
};
