// 「导出为插件」:勾选会话内自定义内容(AI 生成的特效/转场、时间线 MG)→
// 组包校验 → 下载 JSON。数据采集在这里,组包纯逻辑在 plugins/export.ts。
import { useMemo, useState } from 'react';
import { theme } from '../theme';
import { useT } from '../i18n/locale';
import type { TimelineItem, TransitionItem } from '../editor/types';
import type { SerializableFxDef } from '../gl/fx/uniforms';
import { CUSTOM_FX } from '../gl/fx/effects';
import { listCustomTransitions } from '../gl/customTransitions';
import { buildExportPack, fxCandidates, mgCandidates, transitionCandidates, type ExportCandidate } from '../plugins/export';
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

  // 采集三路候选:CUSTOM_FX(会话)∪ state.fxDefs(持久)、注册表 ∪ 时间线转场、时间线 MG
  const groups = useMemo(() => {
    const defs = new Map<string, SerializableFxDef>();
    for (const d of Object.values(fxDefs)) defs.set(d.id, d);
    for (const d of Object.values(CUSTOM_FX)) if (!d.pipeline) defs.set(d.id, d as SerializableFxDef);
    return {
      fx: fxCandidates([...defs.values()]),
      tr: transitionCandidates(listCustomTransitions(), transitions),
      mg: mgCandidates(items),
    };
  }, [items, transitions, fxDefs]);
  const total = groups.fx.length + groups.tr.length + groups.mg.length;

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const doExport = () => {
    setDone(null);
    const selected = [...groups.fx, ...groups.tr, ...groups.mg].filter((c) => checked.has(c.key)).map((c) => c.item);
    if (!selected.length) { setErrors([t('先勾选要打包的内容')]); return; }
    if (!PACK_ID_RE.test(packId.trim())) { setErrors([t('包 id 需为小写字母/数字/连字符(2..40 位),如 my-pack')]); return; }
    const res = buildExportPack({ id: packId, name: packName || packId, author }, selected);
    if (!res.ok) { setErrors(res.errors.slice(0, 4)); return; }
    setErrors([]);
    download(`${res.pack.id}.json`, res.json);
    setDone(t('已导出 {file}({n} 条内容)——分享该文件即可让他人安装', { file: `${res.pack.id}.json`, n: selected.length }));
  };

  const inputStyle = { background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 0 } as const;

  return (
    <div style={{ borderTop: `0.5px solid ${theme.border}`, paddingTop: 10 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.text, fontSize: 12, fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 150ms ease-out', fontSize: 10, color: theme.textDim }}>▶</span>
        {t('导出扩展包')}
        <span style={{ fontWeight: 400, color: theme.textDim, fontSize: 11 }}>{t('把 AI 生成的特效、转场和时间线 MG 打包分享')}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {total === 0 ? (
            <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.6 }}>
              {t('本工程暂无可导出的自定义内容。让 Agent 用 submit_shader 生成特效/转场,或往时间线加 MG 片段后再来。')}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={packId} onChange={(e) => setPackId(e.target.value)} placeholder={t('包 id(my-pack)')} style={{ ...inputStyle, flex: 1 }} />
                <input value={packName} onChange={(e) => setPackName(e.target.value)} placeholder={t('包名(可中文)')} style={{ ...inputStyle, flex: 1 }} />
                <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('作者(可选)')} style={{ ...inputStyle, width: 90 }} />
              </div>
              <Group title={t('自定义特效 · {n}', { n: groups.fx.length })} list={groups.fx} checked={checked} toggle={toggle} />
              <Group title={t('自定义转场 · {n}', { n: groups.tr.length })} list={groups.tr} checked={checked} toggle={toggle} />
              <Group title={t('时间线 MG · {n}', { n: groups.mg.length })} list={groups.mg} checked={checked} toggle={toggle} />
              <div>
                <button onClick={doExport}
                  style={{ background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {t('导出 JSON')}
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
