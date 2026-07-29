/**
 * Built-in Chinese display fonts (bundled CJK display fonts) - runtime.
 *
 * Runtime consumption method:
 * `new FontFace(family, url(<path>), { display:'swap', weight })` → document.fonts.
 * The binary is located in assets/fonts/<slug>/<file>.woff2 and the URL is /fonts/....
 *
 * Loading strategy: registerLocalFonts() only registers FontFace(unloaded) - browser and
 * @font-face has the same semantics. Woff2 will be pulled only when the family is actually used for typesetting, not at startup.
 * Full download; ensureLocalFont(family) is an explicit await version (resolved only after load is completed).
 * Headless rendering: render bundle overlay assets/, the same source /fonts path can also be loaded.
 */

/** Normalized matching key (case/whitespace/punctuation insensitive). googleFonts.ts re-export for search. */
export function normalizeFontKey(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s_\-·.,'"`]+/g, '');
}

export interface LocalCjkFont {
  /** CSS font-family canonical name (MG/caption fontFamily uses this). */
  family: string;
  /** importName, also serves as a searchable alias. */
  importName: string;
  /** Chinese alias. */
  aliasZh: string[];
  /** weight → same-origin URL (/fonts/… ← assets/fonts product static). */
  files: Record<number, string>;
}

// License by style (all are public and free licensed fonts):
export const LOCAL_CJK_FONTS: readonly LocalCjkFont[] = [
  // Deyihei — SIL Open Font License 1.1(github.com/atelier-anchor/smiley-sans, v2.0.1)
  { family: 'Smiley Sans', importName: 'SmileySans', aliasZh: ['得意黑'],
    files: { 400: '/fonts/smiley-sans/SmileySans-Oblique.woff2' } },
  // HarmonyOS Sans Fonts License Agreement (Huawei, free for commercial use)
  { family: 'HarmonyOS Sans', importName: 'HarmonyOSSans', aliasZh: ['鸿蒙黑体', '鸿蒙字体', '鸿蒙'],
    files: { 400: '/fonts/harmonyos-sans/HarmonyOS_Sans_SC_Regular.woff2',
             700: '/fonts/harmonyos-sans/HarmonyOS_Sans_SC_Bold.woff2' } },
  // Easy Handwriting 1 — Free for commercial use (Easy Handwriting Series; subject to the original publisher’s authorization page)
  { family: 'Qingsong Shouxie Ti Yi', importName: 'QingsongShouxieTiYi', aliasZh: ['轻松手写体一', '轻松手写体'],
    files: { 400: '/fonts/qingsong-shouxieti-yi/QingsongShouxietiYi-Regular.woff2' } },
  // Easy handwriting three - free for commercial use (same as the above series; subject to the original publisher’s authorization page)
  { family: 'Qingsong Shouxie Ti San P', importName: 'QingsongShouxieTiSanP', aliasZh: ['轻松手写体三', '轻松手写体'],
    files: { 400: '/fonts/qingsong-shouxieti-san-p/QingsongShouxietiSanP-Regular.woff2' } },
  // Pangmen Zhengdao title style — Pangmen Zhengdao free commercial license
  { family: 'Pangmen Zhengdao Biaoti Ti', importName: 'PangmenZhengdaoBiaotiTi', aliasZh: ['庞门正道标题体', '庞门正道'],
    files: { 400: '/fonts/pangmen-zhengdao-biaotiti/PangmenZhengdaoBiaotiti-Regular.woff2' } },
  // Pangmen Zhengdao Relaxation Body - Pangmen Zhengdao free commercial license
  { family: 'Pangmen Zhengdao Qingsong Ti', importName: 'PangmenZhengdaoQingsongTi', aliasZh: ['庞门正道轻松体'],
    files: { 400: '/fonts/pangmen-zhengdao-qingsongti/PangmenZhengdaoQingsongti-Regular.woff2' } },
  // Hu Xiaobo Male God Body — Hu Xiaobo font free commercial license
  { family: 'Huxiaobo Nanshen Ti', importName: 'HuxiaoboNanshenTi', aliasZh: ['胡晓波男神体'],
    files: { 400: '/fonts/huxiaobo-nanshenti/HuxiaoboNanshenti-Regular.woff2' } },
  // Hu Xiaobo's Sao Bao Body - Hu Xiaobo Font Free Commercial License
  { family: 'Huxiaobo Saobao Ti', importName: 'HuxiaoboSaobaoTi', aliasZh: ['胡晓波骚包体'],
    files: { 400: '/fonts/huxiaobo-saobaoti/HuxiaoboSaobaoti-Regular.woff2' } },
  // Hu Xiaobo is really handsome — Hu Xiaobo font is licensed for free commercial use
  { family: 'Huxiaobo Zhenshuai Ti', importName: 'HuxiaoboZhenshuaiTi', aliasZh: ['胡晓波真帅体'],
    files: { 400: '/fonts/huxiaobo-zhenshuaiti/HuxiaoboZhenshuaiti-Regular.woff2' } },
  // Douyin Beauty — Douyin Beauty Authorization (ByteDance, free for commercial use); charge 400+700 for the same Bold file
  { family: 'Douyin Meihao Ti', importName: 'DouyinMeihaoTi', aliasZh: ['抖音美好体'],
    files: { 400: '/fonts/douyin-meihaoti/DouyinMeihaoti-Bold.woff2',
             700: '/fonts/douyin-meihaoti/DouyinMeihaoti-Bold.woff2' } },
];

/** family / importName / Chinese alias → entry (normalized matching). */
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
 * Register all local fonts (unloaded FontFace, the browser pulls bytes on demand). Idempotent.
 * Called by googleFonts.loadProjectFonts() → The preview and headless rendering take effect in the same path.
 */
export function registerLocalFonts(): void {
  if (!hasDom()) return;
  for (const font of LOCAL_CJK_FONTS) facesOf(font);
}

// family → Explicit loading in progress/completed (Promise cache, idempotent).
const loadPromises = new Map<string, Promise<void>>();

/**
 * Explicitly load a local font (accept family/importName/Chinese alias).
 * Resolve after loading all weights; non-local fonts or no DOM environment resolve directly.
 * Failures are removed from the cache for retry and thrown to the caller.
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
