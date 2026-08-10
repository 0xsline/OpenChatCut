// Runnable contract check: `npx tsx src/agent/template-tools.check.ts`.
// Covers manage_template (get / list_assets / apply / save):
//   save 当前工程打包成模板 → get(list) 列出、get(detail) 回带其 doc(MG + 设计风格);
//   list_assets 返回携带资产;apply 经 applyDoc 单步原子提交,结果含模板的
//   MG 片段与设计风格;omitAssetIds 跳过资产及引用它的片段;placement=replace 换掉现有内容;
//   未知 templateId → 干净报错且不动工程。
// 模板库经 templateStore 的 IndexedDB helper 持久化,故安装内存 IndexedDB shim
// (同 src/persist/version-store.check.ts),在任何触及 store 的模块被 import 之前安装。
import assert from 'node:assert';
import type { MediaAsset, TimelineState } from '../../editor/types';
import type { AgentContext } from '../context';

// ── tiny in-memory IndexedDB shim (enough for the kv store's get/put/delete) ──
const mem = new Map<string, unknown>();
const fire = (req: { onsuccess?: () => void; onerror?: () => void }) => setTimeout(() => req.onsuccess?.(), 0);
function makeStore() {
  return {
    get: (k: string) => { const r: any = {}; r.result = mem.get(k); fire(r); return r; },
    put: (v: unknown, k: string) => { mem.set(k, v); const r: any = {}; fire(r); return r; },
    delete: (k: string) => { mem.delete(k); const r: any = {}; fire(r); return r; },
  };
}
(globalThis as any).indexedDB = {
  open: () => {
    const req: any = { result: { transaction: () => { const tx: any = { objectStore: makeStore }; setTimeout(() => tx.oncomplete?.(), 0); return tx; } } };
    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  },
};

const { makeDraft } = await import('../../editor/store');
const { docFromTimeline } = await import('../../persist/projectStore');
const { execTemplateTool } = await import('./template-tools');

const emptyState = (): TimelineState => ({ fps: 30, width: 1920, height: 1080, selectedId: null, items: [] });
const draftFor = (base = emptyState()) => makeDraft(docFromTimeline(base));
type Draft = ReturnType<typeof draftFor>;
const ctxFor = (d: Draft): AgentContext =>
  ({ commands: d.commands, getState: d.getState, getDoc: d.getDoc, getCreativeMode: () => null, templates: [], audio: [] });

const call = (args: Record<string, unknown>, ctx: AgentContext) => execTemplateTool('manage_template', args, ctx);

const videoAsset: MediaAsset = { id: 'asset_v', name: 'v.mp4', kind: 'video', src: '/v.mp4', durationInFrames: 90 };
const mgAsset: MediaAsset = {
  id: 'asset_mg', name: 'Title', kind: 'motion-graphic', src: '', durationInFrames: 90,
  code: 'const Title = () => null;', props: { title: 'Hi' }, width: 1920, height: 1080,
};

// ── source project A: a design style + two pool assets + two timeline clips ──
const draftA = draftFor();
draftA.commands.setDesignStyle({ colors: [{ role: 'primary', value: '#123456' }], fonts: [{ role: 'heading', family: 'Sora' }] });
draftA.commands.addAsset(videoAsset);
draftA.commands.addAsset(mgAsset);
draftA.commands.addMediaItem(videoAsset); // video clip (src === /v.mp4)
draftA.commands.addMediaItem(mgAsset);    // MG clip (templateId === asset_mg)
const ctxA = ctxFor(draftA);

// save requires a name
assert.ok('error' in (await call({ action: 'save' }, ctxA) as object));

// save → packages the whole ProjectDoc; carries both pool assets
const saveRes = await call({ action: 'save', name: '我的模板' }, ctxA) as { ok: boolean; saved: { id: string; name: string; assetCount: number } };
assert.ok(saveRes.ok);
assert.strictEqual(saveRes.saved.assetCount, 2);
const templateId = saveRes.saved.id;

// get (list) shows it
const list = await call({ action: 'get' }, ctxA) as { templates: { id: string; name: string; assetCount: number }[] };
assert.strictEqual(list.templates.length, 1);
assert.strictEqual(list.templates[0].name, '我的模板');
assert.strictEqual(list.templates[0].assetCount, 2);

// get (detail) round-trips the packaged doc: MG list + design-style summary
const detail = await call({ action: 'get', templateId }, ctxA) as {
  template: { motionGraphics: unknown[]; designStyle: { colors: { role: string; value: string }[] } | null; assetCount: number };
};
assert.strictEqual(detail.template.motionGraphics.length, 1, 'one MG clip packaged');
assert.ok(detail.template.designStyle, 'design style packaged');
assert.strictEqual(detail.template.designStyle!.colors.find((c) => c.role === 'primary')?.value, '#123456');
assert.strictEqual(detail.template.assetCount, 2);

// list_assets → the carried media assets (agent decides reuse vs regenerate)
const la = await call({ action: 'list_assets', templateId }, ctxA) as { assets: { id: string; name: string; kind: string }[] };
assert.strictEqual(la.assets.length, 2);
assert.deepStrictEqual(la.assets.map((a) => a.kind).sort(), ['motion-graphic', 'video']);

// ── apply into an EMPTY project B (default placement = append) ──
const draftB = draftFor();
const ctxB = ctxFor(draftB);
assert.deepStrictEqual(draftB.takeActions(), []); // clear the ledger
const applyRes = await call({ action: 'apply', templateId }, ctxB) as { ok: boolean; applied: boolean; placement: string };
assert.ok(applyRes.ok && applyRes.applied);
assert.strictEqual(applyRes.placement, 'append');
// Exactly one atomic, undoable change (a single tl.setDoc).
const acts = draftB.takeActions();
assert.strictEqual(acts.length, 1, 'apply is one atomic action');
assert.strictEqual(acts[0].type, 'tl.setDoc');
// the applied state carries the template's MG + video clips AND its design style + assets
const itemsB = draftB.getState().items;
assert.ok(itemsB.some((it) => it.kind === 'motion-graphic' && it.name === 'Title'), 'MG clip applied');
assert.ok(itemsB.some((it) => it.kind === 'video' && it.name === 'v.mp4'), 'video clip applied');
assert.strictEqual(draftB.getDoc().designStyle?.colors.find((c) => c.role === 'primary')?.value, '#123456');
assert.deepStrictEqual(draftB.getDoc().assets.map((a) => a.id).sort(), ['asset_mg', 'asset_v']);

// ── apply with omitAssetIds → skip the video asset AND clips referencing it ──
const draftC = draftFor();
await call({ action: 'apply', templateId, omitAssetIds: ['asset_v'] }, ctxFor(draftC));
const itemsC = draftC.getState().items;
assert.ok(itemsC.some((it) => it.kind === 'motion-graphic' && it.name === 'Title'), 'MG kept when unrelated asset omitted');
assert.ok(!itemsC.some((it) => it.kind === 'video'), 'omitted asset\'s clip is dropped');
const assetIdsC = draftC.getDoc().assets.map((a) => a.id);
assert.ok(assetIdsC.includes('asset_mg'));
assert.ok(!assetIdsC.includes('asset_v'), 'omitted asset is not carried into the pool');

// ── apply placement=replace → replaces the active timeline's existing content ──
const draftD = draftFor();
draftD.commands.addMediaItem({ id: 'asset_o', name: 'other.png', kind: 'image', src: '/o.png', durationInFrames: 60 });
assert.strictEqual(draftD.getState().items.length, 1);
await call({ action: 'apply', templateId, placement: 'replace' }, ctxFor(draftD));
const itemsD = draftD.getState().items;
assert.ok(!itemsD.some((it) => it.name === 'other.png'), 'replace drops the pre-existing clip');
assert.ok(itemsD.some((it) => it.kind === 'motion-graphic' && it.name === 'Title'), 'replace installs the template MG');

// ── unknown templateId → clean error, project untouched ──
const before = draftB.getDoc();
assert.ok('error' in (await call({ action: 'apply', templateId: 'nope' }, ctxB) as object));
assert.strictEqual(draftB.getDoc(), before, 'unknown template does not touch the project');
assert.ok('error' in (await call({ action: 'get', templateId: 'nope' }, ctxB) as object));
assert.ok('error' in (await call({ action: 'list_assets', templateId: 'nope' }, ctxB) as object));
assert.ok('error' in (await call({ action: 'list_assets' }, ctxB) as object)); // missing templateId
assert.ok('error' in (await call({ action: 'bogus' }, ctxB) as object)); // unknown action

console.log('template-tools.check: ok');
