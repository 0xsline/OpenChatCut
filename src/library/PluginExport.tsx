// "Export as plug-in": Check the custom content in the session (AI-generated special effects/transitions, timeline MG)→
// Group package verification → Download JSON. Data collection is here, and the pure logic of group packaging is in plugins/export.ts.
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
  // Synchronous revoke will kill uninitiated downloads (Chrome); leave enough startup window before recycling
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

  // Collect three candidates: CUSTOM_FX (session) ∪ state.fxDefs (persistent), registry ∪ timeline transition, timeline MG
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
    if (!selected.length) { setErrors([t('First check the content you want to package')]); return; }
    if (!PACK_ID_RE.test(packId.trim())) { setErrors([t('package id Requires lowercase letters/numbers/hyphen(2..40 Bit),Such as my-pack')]); return; }
    const res = buildExportPack({ id: packId, name: packName || packId, author }, selected);
    if (!res.ok) { setErrors(res.errors.slice(0, 4)); return; }
    setErrors([]);
    download(`${res.pack.id}.json`, res.json);
    setDone(t('Exported {file}({n} content)——Share the file to let others install it', { file: `${res.pack.id}.json`, n: selected.length }));
  };

  const inputStyle = { background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '4px 8px', fontSize: 12, minWidth: 0 } as const;

  return (
    <div style={{ borderTop: `0.5px solid ${theme.border}`, paddingTop: 10 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.text, fontSize: 12, fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 150ms ease-out', fontSize: 10, color: theme.textDim }}>▶</span>
        {t('Export expansion package')}
        <span style={{ fontWeight: 400, color: theme.textDim, fontSize: 11 }}>{t('put AI Generated special effects, transitions and timelines MG Package and share')}</span>
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {total === 0 ? (
            <div style={{ fontSize: 11.5, color: theme.textDim, lineHeight: 1.6 }}>
              {t('There is currently no exported custom content for this project. let Agent use submit_shader Generate special effects/Transition,Or add it to the timeline MG Come back after the snippet.')}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={packId} onChange={(e) => setPackId(e.target.value)} placeholder={t('package id(my-pack)')} style={{ ...inputStyle, flex: 1 }} />
                <input value={packName} onChange={(e) => setPackName(e.target.value)} placeholder={t('package name(Available in Chinese)')} style={{ ...inputStyle, flex: 1 }} />
                <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder={t('Author(Optional)')} style={{ ...inputStyle, width: 90 }} />
              </div>
              <Group title={t('Custom effects · {n}', { n: groups.fx.length })} list={groups.fx} checked={checked} toggle={toggle} />
              <Group title={t('Custom transition · {n}', { n: groups.tr.length })} list={groups.tr} checked={checked} toggle={toggle} />
              <Group title={t('timeline MG · {n}', { n: groups.mg.length })} list={groups.mg} checked={checked} toggle={toggle} />
              <div>
                <button onClick={doExport}
                  style={{ background: theme.accent, color: theme.onAccent, border: 'none', borderRadius: 6, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                  {t('Export JSON')}
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
