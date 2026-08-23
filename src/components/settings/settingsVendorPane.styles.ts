import type { CSSProperties } from 'react';
import { theme } from '../../theme';

export const ON = theme.success;
export const WARN = '#f77';

export const pane: CSSProperties = {
  flex: 1, minWidth: 0, overflowY: 'auto', padding: '14px 20px 16px',
  display: 'flex', flexDirection: 'column', gap: 12,
};
export const fieldCardBox: CSSProperties = {
  background: theme.bg, border: `0.5px solid ${theme.border}`,
  borderRadius: 4, padding: '11px 13px',
};
export const pageNote: CSSProperties = { fontSize: 10.5, color: theme.textDim };
export const fieldHead: CSSProperties = {
  fontSize: 11.5, color: theme.text, display: 'flex', gap: 6,
  alignItems: 'center', justifyContent: 'space-between',
};
export const input: CSSProperties = {
  font: 'inherit', fontSize: 12.5, background: theme.panelAlt, color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 6,
  padding: '6px 9px', width: '100%', outline: 'none',
};
export const select: CSSProperties = {
  ...input, cursor: 'pointer', colorScheme: 'var(--cc-color-scheme)',
};
export const sourceTag: CSSProperties = {
  fontSize: 10, color: theme.textDim, border: `0.5px solid ${theme.border}`,
  borderRadius: 4, padding: '0 5px',
};
export const clearBtn: CSSProperties = {
  font: 'inherit', fontSize: 10.5, background: 'none', border: 'none',
  cursor: 'pointer', padding: '0 2px', flex: '0 0 auto', textDecoration: 'underline',
};
export const browseBtn: CSSProperties = {
  font: 'inherit', fontSize: 11.5, color: theme.text, background: theme.panelAlt,
  border: `0.5px solid ${theme.border}`, borderRadius: 6, padding: '6px 11px',
  cursor: 'pointer', flex: '0 0 auto', whiteSpace: 'nowrap',
};
export const fieldHint: CSSProperties = { fontSize: 10.5, color: theme.textDim };
export const testRow: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, minHeight: 26,
};
export const testBtn: CSSProperties = {
  font: 'inherit', fontSize: 11.5, background: 'transparent', color: theme.text,
  border: `0.5px solid ${theme.border}`, borderRadius: 4,
  padding: '4px 11px', flex: '0 0 auto',
};
export const testMsg: CSSProperties = {
  flex: 1, minWidth: 0, fontSize: 11, lineHeight: 1.5,
  overflow: 'hidden', display: '-webkit-box',
  WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
};
