// Remotion composition that hosts one ChatCut template.
// This is what a "motion-graphic" timeline item renders to.
import { AbsoluteFill } from 'remotion';
import { compileTemplate, type MgItem } from './template-host';

export type MotionGraphicProps = {
  code: string;
  item: MgItem;
  /** show a checkerboard so transparent templates are visible */
  showTransparencyGrid?: boolean;
};

const GRID =
  'repeating-conic-gradient(#2a2a2a 0% 25%, #1e1e1e 0% 50%) 50% / 40px 40px';

export const MotionGraphic: React.FC<MotionGraphicProps> = ({
  code,
  item,
  showTransparencyGrid = true,
}) => {
  let Template;
  try {
    Template = compileTemplate(code);
  } catch (e) {
    return (
      <AbsoluteFill
        style={{
          background: '#300',
          color: '#f88',
          fontFamily: 'monospace',
          fontSize: 28,
          padding: 60,
          whiteSpace: 'pre-wrap',
        }}
      >
        {'compile error:\n' + (e instanceof Error ? e.message : String(e))}
      </AbsoluteFill>
    );
  }
  return (
    <AbsoluteFill style={{ background: showTransparencyGrid ? GRID : 'transparent' }}>
      <Template item={item} />
    </AbsoluteFill>
  );
};
