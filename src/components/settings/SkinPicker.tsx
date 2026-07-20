// 皮肤选择器:笔刷按钮 + 下拉小卡,行 = 三色点(底/面板/accent)
// 预览 + 名称 + 选中对勾。切换即时生效(applySkin 改 <html data-cc-skin>),
// localStorage 持久;TopBar 与 Dashboard 头部共用。
import { useState } from 'react';
import { theme } from '../../theme';
import { useT } from '../../i18n/locale';
import { SKINS, applySkin, getSkin } from '../../skins';
import { Icon } from '../icons';

export function SkinPicker() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(getSkin);
  const pick = (id: string): void => { applySkin(id); setCurrent(id); };

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <button type="button" title={t('皮肤')} className="cc-header-btn" onClick={() => setOpen((o) => !o)}
        style={{ ...trigger, color: open ? theme.text : theme.textDim, background: open ? theme.panelAlt : 'none' }}>
        <Icon name="brush" size={16} />
      </button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 120 }} />
          <div style={pop}>
            <div style={head}>{t('皮肤')}</div>
            {SKINS.map((s) => {
              const active = current === s.id;
              return (
                <button key={s.id} type="button" onClick={() => pick(s.id)}
                  style={{ ...row, background: active ? theme.panel : 'none' }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.panel; }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}>
                  <span style={{ display: 'inline-flex', gap: 3, flexShrink: 0 }}>
                    <span style={dot(s.tokens.bg)} />
                    <span style={dot(s.tokens.panelAlt)} />
                    <span style={dot(s.tokens.accent)} />
                  </span>
                  <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(s.nameZh)}</span>
                  {active && <span style={{ color: theme.accent, display: 'inline-flex' }}><Icon name="check" size={12} strokeWidth={2.4} /></span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const trigger: React.CSSProperties = {
  border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'inline-flex',
  alignItems: 'center', justifyContent: 'center', background: 'none',
};
const pop: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 121, minWidth: 168,
    background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`, borderRadius: 4,
  boxShadow: '0 12px 36px rgba(0,0,0,0.45)', padding: 4, display: 'flex', flexDirection: 'column', gap: 1,
};
const head: React.CSSProperties = { fontSize: 10.5, color: theme.textDim, padding: '4px 8px 5px', letterSpacing: 0.4 };
const row: React.CSSProperties = {
  font: 'inherit', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '6px 8px', border: 'none', borderRadius: 3, cursor: 'pointer', color: theme.text,
};
function dot(color: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: '50%', background: color, border: '0.5px solid rgba(127,127,127,0.45)' };
}
