import type { CSSProperties } from 'react';

const frame = (inset: string, opacity: number): CSSProperties => ({
  position: 'absolute',
  inset,
  boxSizing: 'border-box',
  border: `0.5px dashed rgba(255,255,255,${opacity})`,
  borderRadius: 2,
});

const centerLine: CSSProperties = {
  position: 'absolute',
  background: 'rgba(255,255,255,0.18)',
};

/** Editor-only title/action safety guides; never rendered into the export. */
export function SafeZoneOverlay() {
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div style={frame('5%', 0.55)} />
      <div style={frame('10%', 0.35)} />
      <div style={{ ...centerLine, left: '50%', top: '46%', width: 1, height: '8%' }} />
      <div style={{ ...centerLine, top: '50%', left: '46%', height: 1, width: '8%' }} />
    </div>
  );
}
