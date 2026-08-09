import type { CSSProperties } from 'react';
import { theme } from '../../theme';

export const newCard: CSSProperties = {
  width: '100%', aspectRatio: '16 / 9', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8,
  border: `0.5px dashed ${theme.border}`, borderRadius: 4, background: 'transparent', cursor: 'pointer',
};
export const card: CSSProperties = { border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.panel, overflow: 'hidden' };
export const thumb: CSSProperties = {
  width: '100%', aspectRatio: '16 / 9', background: theme.bg, border: 'none', borderBottom: `0.5px solid ${theme.border}`,
  position: 'relative', overflow: 'hidden', display: 'grid', placeItems: 'center', cursor: 'pointer',
};
export const nameInput: CSSProperties = { font: 'inherit', fontSize: 13, fontWeight: 550, background: theme.panelAlt, color: theme.text, border: `0.5px solid ${theme.accent}`, borderRadius: 5, padding: '2px 6px', width: '100%' };
export const miniBtn: CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 12, padding: '2px 4px', borderRadius: 4, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
export const settingsBtn: CSSProperties = { background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' };
export const modelSetupCard: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, padding: '13px 14px',
  border: `0.5px solid ${theme.accent}`, borderRadius: 6, background: theme.panelAlt,
};
export const modelSetupIcon: CSSProperties = {
  width: 34, height: 34, flex: '0 0 auto', display: 'grid', placeItems: 'center',
  borderRadius: 6, color: theme.textStrong, background: theme.hover,
};
export const modelSetupButton: CSSProperties = {
  flex: '0 0 auto', border: `0.5px solid ${theme.accent}`, borderRadius: 5,
  background: theme.accent, color: theme.onAccent, padding: '7px 12px',
  fontSize: 12, fontWeight: 650, cursor: 'pointer',
};
export const importBtn: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: theme.text,
  background: 'none', border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
};
export const searchBox: CSSProperties = { width: 216, position: 'relative', display: 'inline-flex', alignItems: 'center' };
export const searchIcon: CSSProperties = { position: 'absolute', left: 9, display: 'inline-flex', color: theme.textDim, pointerEvents: 'none' };
export const searchInput: CSSProperties = {
  width: '100%', height: 28, boxSizing: 'border-box', padding: '0 30px 0 28px',
  border: `0.5px solid ${theme.border}`, borderRadius: 4, background: theme.bg, color: theme.text,
  fontSize: 12, WebkitAppearance: 'none',
};
export const searchClear: CSSProperties = {
  position: 'absolute', right: 2, width: 24, height: 24, display: 'grid', placeItems: 'center',
  padding: 0, border: 0, borderRadius: 4, background: 'transparent', color: theme.textDim, cursor: 'pointer',
};
export const searchEmpty: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, marginTop: 16, color: theme.textDim, fontSize: 12 };
