import { useState, type CSSProperties } from 'react';
import type { AgentChangeSession } from '../../agent/changeLog';
import { useT } from '../../i18n/locale';
import { theme, themeAlpha } from '../../theme';
import { Icon } from '../icons';

interface AgentChangeLogMenuProps {
  changeLog: readonly AgentChangeSession[];
  running: boolean;
  canRollback: (id: string) => boolean;
  onRollback: (id: string, force?: boolean) => boolean;
}

export function AgentChangeLogMenu({
  changeLog,
  running,
  canRollback,
  onRollback,
}: AgentChangeLogMenuProps) {
  const t = useT();
  const [open, setOpen] = useState(false);

  const requestRollback = (session: AgentChangeSession) => {
    const current = canRollback(session.id);
    if (!current && !window.confirm(t('工程后来已有其他修改，继续回滚会覆盖后续修改。确定继续吗？'))) return;
    if (onRollback(session.id, !current)) setOpen(false);
  };

  if (changeLog.length === 0) return null;
  return (
    <>
      <button
        type="button"
        title={`${t('Agent 修改记录')}（${changeLog.length}）`}
        aria-label={`${t('Agent 修改记录')}（${changeLog.length}）`}
        onClick={() => setOpen(true)}
        onMouseEnter={(event) => { event.currentTarget.style.color = theme.text; event.currentTarget.style.background = theme.panelAlt; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = theme.textDim; event.currentTarget.style.background = 'none'; }}
        style={trigger}
      >
        <Icon name="clipboard" size={17} />
        <span style={badge}>{changeLog.length}</span>
      </button>

      {open && (
        <div onClick={() => setOpen(false)} style={backdrop}>
          <div role="dialog" aria-modal="true" aria-label={t('Agent 修改记录')}
            onClick={(event) => event.stopPropagation()} style={card}>
            <div style={header}>
              <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="clipboard" size={17} /></span>
              <strong style={{ flex: 1, fontSize: 14 }}>{t('Agent 修改记录')}（{changeLog.length}）</strong>
              <button type="button" onClick={() => setOpen(false)} title={t('关闭')} style={iconButton}>
                <Icon name="x" size={15} />
              </button>
            </div>
            <div className="cc-agent-change-log-list" style={list}>
              {[...changeLog].reverse().map((session) => {
                const current = canRollback(session.id);
                const disabled = running || !session.rollbackable;
                return (
                  <div key={session.id} style={row}>
                    <div style={{ color: theme.text, fontSize: 12.5, lineHeight: 1.45 }}>{session.summary}</div>
                    <div style={{ color: theme.textDim, fontSize: 11, marginTop: 3 }}>
                      {new Date(session.createdAt).toLocaleString()} · {session.operations.length} {t('项操作')}
                    </div>
                    {session.operations.map((operation, index) => (
                      <div key={`${session.id}:${index}`} style={{ color: theme.textDim, fontSize: 11.5, marginTop: 4 }}>
                        {operation.action} · {operation.target} · {operation.impact}
                      </div>
                    ))}
                    {!current && session.rollbackable && (
                      <div style={{ color: theme.gold, fontSize: 11, marginTop: 7 }}>
                        {t('工程后来已有其他修改，回滚前会再次确认')}
                      </div>
                    )}
                    <button type="button" disabled={disabled}
                      title={current ? t('恢复到这次 Agent 修改前') : t('工程后来已有其他修改')}
                      onClick={() => requestRollback(session)}
                      style={{ ...rollbackButton, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' }}>
                      {t('回滚此会话')}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const trigger: CSSProperties = {
  position: 'relative', width: 28, height: 28, display: 'grid', placeItems: 'center',
  padding: 0, border: 0, borderRadius: 4, background: 'none', color: theme.textDim,
  cursor: 'pointer', lineHeight: 0,
};
const badge: CSSProperties = {
  position: 'absolute', top: 1, right: 0, minWidth: 12, height: 12, padding: '0 2px',
  display: 'grid', placeItems: 'center', borderRadius: 8, background: theme.accent,
  color: theme.onAccent, fontSize: 8, lineHeight: '12px', fontWeight: 700,
};
const backdrop: CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center',
  justifyContent: 'center', padding: 20, background: themeAlpha.shadow(0.55),
};
const card: CSSProperties = {
  width: 520, maxWidth: '100%', maxHeight: 'min(680px, calc(100dvh - 40px))', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `0.5px solid ${theme.border}`,
  borderRadius: 6, boxShadow: `0 20px 60px ${themeAlpha.shadow(0.5)}`,
};
const header: CSSProperties = {
  display: 'flex', flex: '0 0 auto', alignItems: 'center', gap: 8, padding: '13px 16px',
  borderBottom: `0.5px solid ${theme.border}`,
};
const list: CSSProperties = {
  padding: 12, flex: '1 1 auto', minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain',
  scrollbarGutter: 'stable', display: 'flex', flexDirection: 'column', gap: 8,
};
const row: CSSProperties = {
  padding: 10, background: theme.panelAlt, border: `0.5px solid ${theme.border}`, borderRadius: 4,
};
const iconButton: CSSProperties = {
  background: 'none', border: 0, color: theme.textDim, cursor: 'pointer', padding: 3, lineHeight: 0,
};
const rollbackButton: CSSProperties = {
  marginTop: 8, padding: '5px 10px', border: `0.5px solid ${theme.border}`, borderRadius: 4,
  background: 'transparent', color: theme.text, fontSize: 12,
};
