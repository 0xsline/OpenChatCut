/**
 * Built-in Chinese display font(bundled CJK display fonts)——Runtime.
 *
 * Runtime consumption method:
 * `new FontFace(family, url(<path>), { display:'swap', weight })` → document.fonts。
 * binary falls on assets/fonts/<slug>/<file>.woff2，URL for /fonts/...。
 *
 * loading strategy:registerLocalFonts() Register only FontFace(unloaded)——Browser and
 * @font-face Same semantics,Typesetting really uses this family Only then woff2, not at startup
 * Full download;ensureLocalFont(family) is explicit await version(load Completed resolve)。
 * headless rendering:render bundle overlay Got it assets/,Homology /fonts Paths are also loadable.
 */

/** Normalized matching key(Case/blank/Punctuation insensitive)。googleFonts.ts re-export For search purposes. */
export function normalizeFontKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_\-·.,'"`]+/g, '');
}

export interface LocalCjkFont {
  /** CSS font-family canonical name(MG/subtitles fontFamily use this)。 */
  family: string;
  /** importName,Also serves as a searchable alias. */
  importName: string;
  /** Chinese alias. */
  aliasZh: string[];
  /** weight → Homology URL(/fonts/… ← assets/fonts Product static)。 */
  files: Record<number, string>;
}

// License-by-style (all are public and free licensed fonts):
export const LOCAL_CJK_FONTS: readonly LocalCjkFont[] = [
  // Deyihei — SIL Open Font License 1.1(github.com/atelier-anchor/smiley-sans, v2.0.1)
  { family: 'Smiley Sans', importName: 'SmileySans', aliasZh: ['proudly black'],
    files: { 400: '/fonts/smiley-sans/SmileySans-Oblique.woff2' } },
  // HarmonyOS Sans Fonts License Agreement (Huawei, free for commercial use)
  { family: 'HarmonyOS Sans', importName: 'HarmonyOSSans', aliasZh: ['Hongmeng Blackbody', 'Hongmeng font', 'Hongmeng'],
    files: { 400: '/fonts/harmonyos-sans/HarmonyOS_Sans_SC_Regular.woff2',
             700: '/fonts/harmonyos-sans/HarmonyOS_Sans_SC_Bold.woff2' } },
  // Easy Handwriting 1 — Free for commercial use (Easy Handwriting Series; subject to the original publisher’s authorization page)
  { family: 'Qingsong Shouxie Ti Yi', importName: 'QingsongShouxieTiYi', aliasZh: ['Easy handwriting one', 'Easy handwriting'],
    files: { 400: '/fonts/qingsong-shouxieti-yi/QingsongShouxietiYi-Regular.woff2' } },
  // Easy Handwriting 3 - Free for commercial use (same as the above series; subject to the original publisher’s authorization page)
  { family: 'Qingsong Shouxie Ti San P', importName: 'QingsongShouxieTiSanP', aliasZh: ['Easy handwriting three', 'Easy handwriting'],
    files: { 400: '/fonts/qingsong-shouxieti-san-p/QingsongShouxietiSanP-Regular.woff2' } },
  // Pangmenzhengdao title style - Pangmenzhengdao free commercial license
  { family: 'Pangmen Zhengdao Biaoti Ti', importName: 'PangmenZhengdaoBiaotiTi', aliasZh: ['Pangmenzhengdao title style', 'Pangmenzhengdao'],
    files: { 400: '/fonts/pangmen-zhengdao-biaotiti/PangmenZhengdaoBiaotiti-Regular.woff2' } },
  // Pangmen Zhengdao relaxing body — PangmenzhengdaoFree for commercial use授权
  { family: 'Pangmen Zhengdao Qingsong Ti', importName: 'PangmenZhengdaoQingsongTi', aliasZh: ['Pangmen Zhengdao relaxing body'],
    files: { 400: '/fonts/pangmen-zhengdao-qingsongti/PangmenZhengdaoQingsongti-Regular.woff2' } },
  // Hu Xiaobo's male body — 胡晓波fontFree for commercial use授权
  { family: 'Huxiaobo Nanshen Ti', importName: 'HuxiaoboNanshenTi', aliasZh: ['Hu Xiaobo's male body'],
    files: { 400: '/fonts/huxiaobo-nanshenti/HuxiaoboNanshenti-Regular.woff2' } },
  // Hu Xiaobo's sexy body — 胡晓波fontFree for commercial use授权
  { family: 'Huxiaobo Saobao Ti', importName: 'HuxiaoboSaobaoTi', aliasZh: ['Hu Xiaobo's sexy body'],
    files: { 400: '/fonts/huxiaobo-saobaoti/HuxiaoboSaobaoti-Regular.woff2' } },
  // Hu Xiaobo is so handsome — 胡晓波fontFree for commercial use授权
  { family: 'Huxiaobo Zhenshuai Ti', importName: 'HuxiaoboZhenshuaiTi', aliasZh: ['Hu Xiaobo is so handsome'],
    files: { 400: '/fonts/huxiaobo-zhenshuaiti/HuxiaoboZhenshuaiti-Regular.woff2' } },
  // Douyin Beautiful Body — Douyin Beautiful Body Authorization(ByteDance,Free for commercial use);same Bold File charging 400+700
  { family: 'Douyin Meihao Ti', importName: 'DouyinMeihaoTi', aliasZh: ['Douyin beautiful body'],
    files: { 400: '/fonts/douyin-meihaoti/DouyinMeihaoti-Bold.woff2',
             700: '/fonts/douyin-meihaoti/DouyinMeihaoti-Bold.woff2' } },
];

/** family / importName / Chinese alias → entry(normalized matching)。 */
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

// family → FontFace instance registered in document.fonts (single instance, preventing repeated registration).
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
 * Register all local fonts(unloaded FontFace,The browser pulls bytes on demand). Idempotent.
 * by googleFonts.loadProjectFonts() call → Preview and headless Rendering takes effect with the same path.
 */
export function registerLocalFonts(): void {
  if (!hasDom()) return;
  for (const font of LOCAL_CJK_FONTS) facesOf(font);
}

// family → In progress/Completed explicit load(Promise cache,Idempotent)。
const loadPromises = new Map<string, Promise<void>>();

/**
 * Explicitly load a local font(accept family/importName/Chinese alias)。
 * load After all weights are completed resolve;non-native font or none DOM environment directly resolve。
 * Failures are removed from the cache so they can be retried,and thrown to the caller.
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
