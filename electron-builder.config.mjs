// 桌面打包配置(M2 起,M4 扩三目标)。产物:release/。
// 跑法:npm run desktop:dist(:mac-x64 / :win)——链条 = vite build → esbuild 主进程
//      → 预打 remotion bundle → prepare-target 备料 → electron-builder。
// 说明:
//   - files 只带主进程 bundle;生产依赖 node_modules 由 electron-builder 自动收
//     (@remotion/renderer 等运行时真用;@remotion/bundler 仅 import 到,预打后不执行)。
//     compositor 平台包按 CC_EB_TARGET 只留目标平台的(每个 ~180MB,全带会胖 3 倍)。
//   - 不用 asar:@remotion/renderer 对 compositor 二进制先 chmod 再 spawn,拿的是
//     模块解析出的路径——asar 下即使 unpack 了,路径字符串仍指 asar 内,chmod ENOTDIR
//     (实测)。真文件铺开一次性消灭这类问题,代价只是启动多些小文件 IO。
//   - dist / 预打 remotion-bundle 走 extraResources;chrome-headless-shell 指
//     desktop-dist 的 staging 目录(prepare-target 按目标平台填充,main.ts 按
//     process.resourcesPath 定位;bundle 首启拷 userData 换可写)。
//   - 未配签名:mac 出的是 ad-hoc 签名包,分发要右键打开或 xattr -cr 放行;
//     Windows 未签名会触发 SmartScreen 提示。正式分发再接证书/公证。
//   - 图标:macOS 使用预生成的标准 icns，避免自动转换产生损坏的 48px 图层；
//     Windows 继续由 Web 端 PNG 派生 ico。

// 包名以 @remotion/renderer 的 optionalDependencies 为准(win32 带 -msvc,linux 带 libc 后缀)
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
    // 只带目标平台的 compositor(renderer 运行时按 process.platform require 对应包)
    ...COMPOSITORS.filter((c) => c !== keep).map((c) => `!node_modules/@remotion/compositor-${c}/**`),
  ],
  asar: false,
  extraResources: [
    // dist 排除 media/uploads:vite 把 public/ 整个拷进 dist,用户素材(可达数 GB)
    // 会被烧进安装包。运行时 /media/uploads 由 uploadsMiddleware 从素材目录直读
    // (打包版 = userData),从不读 resources/dist —— 带上纯属死重。
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
    // 没有 Developer ID 时也完整签署 Bundle，防止 Finder 将应用标成不可运行。
    // CI 后续注入 CSC_LINK / CSC_NAME 后，由 electron-builder 自动使用正式证书。
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
