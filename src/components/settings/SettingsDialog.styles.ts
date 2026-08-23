import type { CSSProperties } from 'react';
import { theme, themeAlpha } from '../../theme';
import { ON } from './settingsVendorPane.styles';

const TREE_WIDTH = 200;
const VENDOR_COL_WIDTH = 185;

export function navRowStyle(active: boolean, hovered: boolean): CSSProperties {
  return {
    font: 'inherit', fontSize: 12, display: 'flex', alignItems: 'center', gap: 7,
    width: '100%', padding: '6px 9px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
    border: 'none', borderLeft: `2px solid ${active ? theme.accent : 'transparent'}`,
    background: active || hovered ? theme.panelAlt : 'transparent',
    color: active ? theme.text : theme.textDim,
  };
}

export function dot(on: boolean): CSSProperties {
  return {
    width: 7, height: 7, borderRadius: '50%',
    background: on ? ON : theme.borderLight, flex: '0 0 auto',
  };
}

export const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: themeAlpha.shadow(0.62), display: 'grid', placeItems: 'center',
  zIndex: 200, padding: 24, fontFamily: 'Geist, system-ui, -apple-system, sans-serif',
};
export const panel: CSSProperties = {
  width: 'min(940px, 100%)', height: 'min(640px, 86vh)', display: 'flex', flexDirection: 'column',
  background: theme.panel, color: theme.text, border: `0.5px solid ${theme.border}`, borderRadius: 6,
  boxShadow: `0 24px 64px ${themeAlpha.shadow(0.5)}`, overflow: 'hidden',
};
export const head: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '13px 16px 13px 20px', borderBottom: `0.5px solid ${theme.border}`,
};
export const bodyRow: CSSProperties = { display: 'flex', flex: 1, minHeight: 0 };
export const sidebar: CSSProperties = {
  width: TREE_WIDTH, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
  borderRight: `0.5px solid ${theme.border}`, overflow: 'hidden',
};
export const treeScroll: CSSProperties = {
  flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex',
  flexDirection: 'column', gap: 2, padding: '10px 8px',
};
export const catRow: CSSProperties = {
  font: 'inherit', fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
  width: '100%', padding: '7px 9px 7px 7px', borderRadius: 6, cursor: 'pointer',
  border: 'none', background: 'transparent', color: theme.text,
};
export const chevronBox: CSSProperties = {
  display: 'inline-flex', color: theme.textDim, transition: 'transform 0.15s', flex: '0 0 auto',
};
export const navLabel: CSSProperties = {
  flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
export const sidebarNote: CSSProperties = {
  margin: 0, padding: '10px 12px', fontSize: 10.5, lineHeight: 1.6,
  color: theme.textDim, borderTop: `0.5px solid ${theme.border}`,
};
export const vendorCol: CSSProperties = {
  width: VENDOR_COL_WIDTH, flex: '0 0 auto', minWidth: 0, minHeight: 0, overflowY: 'auto',
  display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px',
  borderRight: `0.5px solid ${theme.border}`,
};
export const routeBox: CSSProperties = {
  padding: '0 2px 10px', marginBottom: 6, borderBottom: `0.5px solid ${theme.border}`,
};
export const foot: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px 12px 20px',
  borderTop: `0.5px solid ${theme.border}`, background: theme.panel,
};
export const footMsg: CSSProperties = {
  flex: 1, minWidth: 0, textAlign: 'right', fontSize: 11.5,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
export const revealLabel: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
  color: theme.textDim, cursor: 'pointer', userSelect: 'none',
};
export const licenseLink: CSSProperties = {
  color: theme.textDim, fontSize: 11.5, textDecoration: 'underline', textUnderlineOffset: 2,
};
export const iconBtn: CSSProperties = {
  background: 'none', border: 'none', color: theme.textDim,
  cursor: 'pointer', padding: 4, borderRadius: 5, display: 'inline-flex',
};
export const btnGhost: CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: 'transparent', color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 4, padding: '6px 13px', cursor: 'pointer',
};
export const btnPrimary: CSSProperties = {
  font: 'inherit', fontSize: 12.5, fontWeight: 600, background: theme.accent,
  color: theme.onAccent, border: 'none', borderRadius: 4, padding: '6px 16px',
};
export const code: CSSProperties = {
  fontFamily: 'ui-monospace, monospace', fontSize: 10,
  background: theme.panelAlt, padding: '1px 4px', borderRadius: 4,
};
