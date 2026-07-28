// 「创作扩展」:勾选会话内自定义内容 → 组包校验 →
// 保存到本地资源库或下载投稿 JSON。组包纯逻辑在 plugins/export.ts。
import { useMemo, useState } from 'react';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { TimelineItem, TransitionItem } from '../editor/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import { CUSTOM_FX } from '../gl/fx/effects';
import { listCustomTransitions } from '../gl/customTransitions';
import { buildExportPack, fxCandidates, lutCandidates, mgCandidates, transitionCandidates, zoomCandidates, type ExportCandidate } from '../plugins/export';
import { installFromText } from '../plugins/install';
import { PACK_ID_RE } from '../plugins/types';

interface PluginExportProps {
  items: TimelineItem[];
  transitions: TransitionItem[];
  fxDefs: Record<string, SerializableFxDef>;
  defaultOpen?: boolean;
}

function download(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 同步 revoke 会掐掉尚未启动的下载(Chrome);留足启动窗口再回收
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Group({ title, list, checked, toggle }: { title: string; list: ExportCandidate[]; checked: Set<string>; toggle: (key: string) => void }) {
  if (!list.length) return null;
  return (
    <div>
      <div style={{ fontSize: 10.5, color: theme.textDim, margin: '6px 0 3px', letterSpacing: 0.3 }}>{title}</div>
      {list.map((c) => (
        <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: theme.text, padding: '2px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={checked.has(c.key)} onChange={() => toggle(c.key)} style={{ accentColor: theme.accent }} />
          {c.label}
        </label>
      ))}
    </div>
  );
}

export function PluginExport({ items, transitions, fxDefs, defaultOpen = false }: PluginExportProps) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const [packId, setPackId] = useState('');
  const [packName, setPackName] = useState('');
  const [author, setAuthor] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 会话注册表与工程持久数据合并去重,只导出用户创作内容。
  const groups = useMemo(() => {
    const defs = new Map<string, SerializableFxDef>();
    for (const d of Object.values(fxDefs)) defs.set(d.id, d);
    for (const d of Object.values(CUSTOM_FX)) if (!d.pipeline) defs.set(d.id, d as SerializableFxDef);
    const allDefs = [...defs.values()];
    return {
      fx: fxCandidates(allDefs),
      lut: lutCandidates(allDefs),
      tr: transitionCandidates(listCustomTransitions(), transitions),
      zoom: zoomCandidates(items),
      mg: mgCandidates(items),
    };
  }, [items, transitions, fxDefs]);
  const allCandidates = [...groups.fx, ...groups.lut, ...groups.tr, ...groups.zoom, ...groups.mg];
  const total = allCandidates.length;

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const buildSelected = () => {
    setDone(null);
    const selected = allCandidates.filter((c) => checked.has(c.key)).map((c) => c.item);
    if (!selected.length) { setErrors([t('先勾选要打包的内容')]); return null; }
    if (!PACK_ID_RE.test(packId.trim())) { setErrors([t('包 id 需为小写字母/数字/连字符(2..40 位),如 my-pack')]); return null; }
    const res = buildExportPack({ id: packId, name: packName || packId, author }, selected);
    if (!res.ok) { setErrors(res.errors.slice(0, 4)); return null; }
    setErrors([]);
    return res;
  };

  const doExport = () => {
    const res = buildSelected();
    if (!res) return;
    download(`${res.pack.id}.json`, res.json);
    setDone(t('已导出 {file}({n} 条内容)——可直接上传资源网站', { file: `${res.pack.id}.json`, n: res.pack.items.length }));
  };

  const doSave = async () => {
    const res = buildSelected();
    if (!res) return;
    setSaving(true);
    try {
      const installed = await installFromText(res.json);
      if (!installed.ok) { setErrors(installed.errors.slice(0, 4)); return; }
      setDone(t('已保存到资源库({n} 条内容)，可在对应分类直接使用', { n: res.pack.items.length }));
    } catch (error) {
      setErrors([t('保存失败：{message}', { message: error instanceof Error ? error.message : String(error) })]);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = { background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 0 } as const;

  return (
    <div style={{ borderTop: `0.5px solid ${theme.border}`, paddingTop: 10 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.text, fontSize: 12, fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 150ms ease-out', fontSize: 10, color: theme.textDim }}>▶</span>
        {t('创作扩展')}
        <span style={{ fontWeight: 400, color: theme.textDim, fontSize: 11 }}>{t('把 Agent 生成和时间线创作保存到资源库，或导出投稿包')}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {total === 0 ? (
            <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.6 }}>
              {t('本工程暂无可保存的创作。让 Agent 生成内容，或在时间线制作 MG/缩放后再来。')}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={packId} onChange={(e) => setPackId(e.target.value)} placeholder={t('包 id(my-pack)')} style={{ ...inputStyle, flex: 1 }} />
                <input value={packName} onChange={(e) => setPackName(e.target.value)} placeholder={t('包名(可中文)')} style={{ ...inputStyle, flex: 1 }} />
                <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('作者(可选)')} style={{ ...inputStyle, width: 90 }} />
              </div>
              <Group title={t('自定义特效 · {n}', { n: groups.fx.length })} list={groups.fx} checked={checked} toggle={toggle} />
              <Group title={t('自定义 LUT · {n}', { n: groups.lut.length })} list={groups.lut} checked={checked} toggle={toggle} />
              <Group title={t('自定义转场 · {n}', { n: groups.tr.length })} list={groups.tr} checked={checked} toggle={toggle} />
              <Group title={t('时间线缩放 · {n}', { n: groups.zoom.length })} list={groups.zoom} checked={checked} toggle={toggle} />
              <Group title={t('时间线 MG · {n}', { n: groups.mg.length })} list={groups.mg} checked={checked} toggle={toggle} />
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => { void doSave(); }} disabled={saving}
                  style={{ background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.65 : 1 }}>
                  {saving ? t('保存中…') : t('保存到资源库')}
                </button>
                <button onClick={doExport} disabled={saving}
                  style={{ background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {t('导出投稿包')}
                </button>
              </div>
            </>
          )}
          {errors.length > 0 && <div style={{ fontSize: 11.5, color: theme.danger, lineHeight: 1.5 }}>{errors.join(';')}</div>}
          {done && <div style={{ fontSize: 11.5, color: `color-mix(in srgb, ${theme.success} 65%, ${theme.textStrong})`, lineHeight: 1.5 }}>{done}</div>}
        </div>
      )}
    </div>
  );
}
