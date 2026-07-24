// Desktop packaging configuration (starting from M2, M4 expands to three targets). product:release/.
// Running method: npm run desktop:dist(:mac-x64 / :win) - chain = vite build → esbuild main process
//      → Pre-print remotion bundle → prepare-target preparation → electron-builder.
// Description:
//   - files only carry the main process bundle; production dependency node_modules is automatically collected by electron-builder
//     (@remotion/renderer is really useful when running; @remotion/bundler is only imported and will not be executed after pre-printing).
//     The compositor platform package according to CC_EB_TARGET only keeps the target platform (each ~180MB, the whole package will be 3 times fatter).
//   - No need to use asar:@remotion/renderer to chmod the compositor binary first and then spawn it.
//     The path parsed by the module - even if unpacked under asar, the path string still refers to asar, chmod ENOTDIR
//     (actual measurement). True file rollout eliminates this kind of problem at once, at the cost of starting more small file IOs.
//   - dist/preloaded remotion-bundle and extraResources; chrome-headless-shell refers to
//     The staging directory of desktop-dist (prepare-target is populated by target platform, main.ts is populated by
//     process.resourcesPath location; bundle is first started and userData is writable).
//   - Not equipped with a signature: Mac comes out with an ad-hoc signature package. To distribute it, you need to right-click to open it or run xattr -cr to release it;
//     Windows Unsigned triggers a SmartScreen prompt. Official distribution followed by certificate/notarization.
//   - Icon: macOS uses pre-generated standard icns to avoid automatic conversion producing damaged 48px layers;
//     Windows continues to derive ico from the web-side PNG.

// The package name is based on the optionalDependencies of @remotion/renderer (win32 with -msvc, Linux with libc suffix)
const COMPOSITORS = [
  'darwin-arm64', 'darwin-x64', 'win32-x64-msvc',
  'linux-arm64-gnu', 'linux-arm64-musl', 'linux-x64-gnu', 'linux-x64-musl',
];
const TARGET_COMPOSITOR = { 'darwin-arm64': 'darwin-arm64', 'darwin-x64': 'darwin-x64', 'win32-x64': 'win32-x64-msvc' };
const target = process.env.CC_EB_TARGET ?? `${process.platform}-${process.arch}`;
const keep = TARGET_COMPOSITOR[target] ?? target;
const hasMacSigningCertificate = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

export default {
  appId: 'dev.openchatcut.app',
  productName: 'OpenChatCut',
  artifactName: '${productName}-${version}-${arch}.${ext}',
  directories: { output: 'release' },
  files: [
    'desktop-dist/main.mjs',
    'desktop-dist/preload.cjs',
    'package.json',
    // Only the compositor of the target platform (press process.platform require corresponding package when the renderer is running)
    ...COMPOSITORS.filter((c) => c !== keep).map((c) => `!node_modules/@remotion/compositor-${c}/**`),
  ],
  asar: false,
  extraResources: [
    // dist excludes media/uploads:vite Copy the entire public/ into dist, user material (up to several GB)
    // will be burned into the installation package. When running, /media/uploads is read directly from the material directory by uploadsMiddleware
    // (packaged version = userData), never reads resources/dist - bringing it is purely dead weight.
    { from: 'dist', to: 'dist', filter: ['**/*', '!media/uploads/**'] },
    { from: 'desktop-dist/remotion-bundle', to: 'remotion-bundle' },
    { from: 'desktop-dist/chrome-headless-shell', to: 'chrome-headless-shell' },
  ],
  npmRebuild: false,
  mac: {
    target: ['dmg'],
    category: 'public.app-category.video',
    icon: 'assets/branding/openchatcut-icon.icns',
    entitlements: 'desktop/entitlements.mac.plist',
    entitlementsInherit: 'desktop/entitlements.mac.plist',
    // Hardened runtime is required for Developer ID distribution. Ad-hoc local
    // and CI packages have no notarization identity, so enabling it only adds
    // library-validation restrictions without a security benefit.
    hardenedRuntime: hasMacSigningCertificate,
    // Completely sign the Bundle even without a Developer ID to prevent the Finder from marking the application as inoperable.
    // After CI subsequently injects CSC_LINK / CSC_NAME, electron-builder will automatically use the official certificate.
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
};
