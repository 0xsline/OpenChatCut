/**
 * 内置中文展示字体(bundled CJK display fonts)—— 运行时。
 *
 * 运行时消费方式:
 * `new FontFace(family, url(<path>), { display:'swap', weight })` → document.fonts。
 * 二进制落在 assets/fonts/<slug>/<file>.woff2，URL 为 /fonts/...。
 *
 * 加载策略:registerLocalFonts() 只注册 FontFace(unloaded)——浏览器与
 * @font-face 同语义,排版真正用到该 family 时才拉 woff2，不会在启动时
 * 全量下载；ensureLocalFont(family) 是显式 await 版(load 完成才 resolve)。
 * headless 渲染:render bundle overlay 了 assets/,同源 /fonts 路径同样可载。
 */

/** 归一化匹配键(大小写/空白/标点不敏感)。googleFonts.ts re-export 给搜索用。 */
export function normalizeFontKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_\-·.,'"`]+/g, '');
}

export interface LocalCjkFont {
  /** CSS font-family 规范名(MG/字幕 fontFamily 用这个)。 */
  family: string;
  /** importName,同时作为可搜别名。 */
  importName: string;
  /** 中文别名。 */
  aliasZh: string[];
  /** weight → 同源 URL(/fonts/… ← assets/fonts 产品静态)。 */
  files: Record<number, string>;
}

// 逐款 license(均为公开免费授权字体):
export const LOCAL_CJK_FONTS: readonly LocalCjkFont[] = [
  // 得意黑 — SIL Open Font License 1.1(github.com/atelier-anchor/smiley-sans, v2.0.1)
  { family: 'Smiley Sans', importName: 'SmileySans', aliasZh: ['得意黑'],
    files: { 400: '/fonts/smiley-sans/SmileySans-Oblique.woff2' } },
  // 鸿蒙黑体 — HarmonyOS Sans Fonts License Agreement(华为,免费商用)
  { family: 'HarmonyOS Sans', importName: 'HarmonyOSSans', aliasZh: ['鸿蒙黑体', '鸿蒙字体', '鸿蒙'],
    files: { 400: '/fonts/harmonyos-sans/HarmonyOS_Sans_SC_Regular.woff2',
             700: '/fonts/harmonyos-sans/HarmonyOS_Sans_SC_Bold.woff2' } },
  // 轻松手写体一 — 免费商用(轻松体系列手写体;以原发布方授权页为准)
  { family: 'Qingsong Shouxie Ti Yi', importName: 'QingsongShouxieTiYi', aliasZh: ['轻松手写体一', '轻松手写体'],
    files: { 400: '/fonts/qingsong-shouxieti-yi/QingsongShouxietiYi-Regular.woff2' } },
  // 轻松手写体三 — 免费商用(同上系列;以原发布方授权页为准)
  { family: 'Qingsong Shouxie Ti San P', importName: 'QingsongShouxieTiSanP', aliasZh: ['轻松手写体三', '轻松手写体'],
    files: { 400: '/fonts/qingsong-shouxieti-san-p/QingsongShouxietiSanP-Regular.woff2' } },
  // 庞门正道标题体 — 庞门正道免费商用授权
  { family: 'Pangmen Zhengdao Biaoti Ti', importName: 'PangmenZhengdaoBiaotiTi', aliasZh: ['庞门正道标题体', '庞门正道'],
    files: { 400: '/fonts/pangmen-zhengdao-biaotiti/PangmenZhengdaoBiaotiti-Regular.woff2' } },
  // 庞门正道轻松体 — 庞门正道免费商用授权
  { family: 'Pangmen Zhengdao Qingsong Ti', importName: 'PangmenZhengdaoQingsongTi', aliasZh: ['庞门正道轻松体'],
    files: { 400: '/fonts/pangmen-zhengdao-qingsongti/PangmenZhengdaoQingsongti-Regular.woff2' } },
  // 胡晓波男神体 — 胡晓波字体免费商用授权
  { family: 'Huxiaobo Nanshen Ti', importName: 'HuxiaoboNanshenTi', aliasZh: ['胡晓波男神体'],
    files: { 400: '/fonts/huxiaobo-nanshenti/HuxiaoboNanshenti-Regular.woff2' } },
  // 胡晓波骚包体 — 胡晓波字体免费商用授权
  { family: 'Huxiaobo Saobao Ti', importName: 'HuxiaoboSaobaoTi', aliasZh: ['胡晓波骚包体'],
    files: { 400: '/fonts/huxiaobo-saobaoti/HuxiaoboSaobaoti-Regular.woff2' } },
  // 胡晓波真帅体 — 胡晓波字体免费商用授权
  { family: 'Huxiaobo Zhenshuai Ti', importName: 'HuxiaoboZhenshuaiTi', aliasZh: ['胡晓波真帅体'],
    files: { 400: '/fonts/huxiaobo-zhenshuaiti/HuxiaoboZhenshuaiti-Regular.woff2' } },
  // 抖音美好体 — 抖音美好体授权(字节跳动,免费商用);同一 Bold 文件充 400+700
  { family: 'Douyin Meihao Ti', importName: 'DouyinMeihaoTi', aliasZh: ['抖音美好体'],
    files: { 400: '/fonts/douyin-meihaoti/DouyinMeihaoti-Bold.woff2',
             700: '/fonts/douyin-meihaoti/DouyinMeihaoti-Bold.woff2' } },
];

/** family / importName / 中文别名 → 条目(归一化匹配)。 */
export function findLocalFont(name: string): LocalCjkFont | undefined {
  const key = normalizeFontKey(name);
  if (!key) return undefined;
  return LOCAL_CJK_FONTS.find(
    (f) =>
      normalizeFontKey(f.family) === key ||
      normalizeFontKey(f.importName) === key ||
      f.aliasZh.some((a) => normalizeFontKey(a) === key),
  );
}

const hasDom = (): boolean => typeof FontFace !== 'undefined' && typeof document !== 'undefined';

// family → 已注册进 document.fonts 的 FontFace 实例(单一实例,防重复注册)。
const registeredFaces = new Map<string, FontFace[]>();

function facesOf(font: LocalCjkFont): FontFace[] {
  let faces = registeredFaces.get(font.family);
  if (!faces) {
    faces = Object.entries(font.files).map(
      ([weight, url]) =>
        new FontFace(font.family, `url(${url}) format('woff2')`, {
          weight,
          style: 'normal',
          display: 'swap',
        }),
    );
    for (const face of faces) document.fonts.add(face);
    registeredFaces.set(font.family, faces);
  }
  return faces;
}

/**
 * 注册全部本地字体(unloaded FontFace,浏览器按需拉取字节)。幂等。
 * 由 googleFonts.loadProjectFonts() 调用 → 预览与 headless 渲染同路径生效。
 */
export function registerLocalFonts(): void {
  if (!hasDom()) return;
  for (const font of LOCAL_CJK_FONTS) facesOf(font);
}

// family → 进行中/已完成的显式加载(Promise 缓存,幂等)。
const loadPromises = new Map<string, Promise<void>>();

/**
 * 显式加载某款本地字体(接受 family/importName/中文别名)。
 * load 全部权重完成后 resolve;非本地字体或无 DOM 环境直接 resolve。
 * 失败会从缓存移除以便重试,并向调用方抛出。
 */
export function ensureLocalFont(family: string): Promise<void> {
  const font = findLocalFont(family);
  if (!font) return Promise.resolve();
  const cached = loadPromises.get(font.family);
  if (cached) return cached;
  const promise = hasDom()
    ? Promise.all(facesOf(font).map((face) => face.load())).then(
        () => undefined,
        (err: unknown) => {
          loadPromises.delete(font.family);
          throw err instanceof Error ? err : new Error(`font load failed: ${font.family}`);
        },
      )
    : Promise.resolve();
  loadPromises.set(font.family, promise);
  return promise;
}
