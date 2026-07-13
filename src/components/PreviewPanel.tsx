import { Player } from '@remotion/player';
import { theme } from '../theme';
import { MotionGraphic } from '../MotionGraphic';
import type { Tpl } from '../types';

interface PreviewPanelProps {
  template: Tpl;
  props: Record<string, unknown>;
}

export function PreviewPanel({ template, props }: PreviewPanelProps) {
  const item = { props, width: template.width, height: template.height };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', background: theme.panel, minHeight: 0 }}>
      <div style={{ padding: '10px 16px', fontSize: 12, color: theme.textDim, borderBottom: `1px solid ${theme.border}` }}>预览</div>
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 20, minHeight: 0, background: theme.bg }}>
        <Player
          key={template.id}
          component={MotionGraphic}
          inputProps={{ code: template.code, item }}
          durationInFrames={template.durationInFrames}
          fps={template.fps}
          compositionWidth={template.width}
          compositionHeight={template.height}
          style={{
            maxWidth: '100%', maxHeight: '100%',
            aspectRatio: `${template.width} / ${template.height}`,
            border: `1px solid ${theme.border}`, borderRadius: 6,
          }}
          controls
          loop
          autoPlay
        />
      </div>
    </section>
  );
}
