const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const props = item.props || {};
  const words = String(props.quote).split(' ');
  const hi = Number(props.highlightIndex);
  const bg = props.transparentBackground ? 'transparent' : props.paperColor;
  const rootStyle = { position: 'absolute', inset: 0, backgroundColor: bg };

  return (
    <div style={{ ...rootStyle, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80 }}>
      <div style={{ fontFamily: props.font, fontWeight: 800, fontSize: 78, lineHeight: 1.12, letterSpacing: '-0.015em', color: props.inkColor, maxWidth: '92%', display: 'flex', flexWrap: 'wrap', gap: '0.1em 0.26em' }}>
        {words.map((w, i) => {
          const start = i * 4;
          const s = spring({ frame: frame - start, fps, config: { damping: 16, stiffness: 170 } });
          const op = Math.min(1, s * 2);
          const sweep = interpolate(frame - start - 6, [0, 9], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const isHi = i === hi;
          const wrapStyle = { display: 'inline-block', position: 'relative', transform: `scale(${s})`, opacity: op };
          if (isHi) {
            return (
              <span key={i} style={{ ...wrapStyle, padding: '0 0.1em' }}>
                <span style={{ position: 'relative', zIndex: 2 }}>{w}</span>
                <span style={{ position: 'absolute', inset: 0, zIndex: 1, backgroundColor: props.accentColor, transform: `scaleX(${sweep})`, transformOrigin: 'left center' }} />
              </span>
            );
          }
          return <span key={i} style={wrapStyle}>{w}</span>;
        })}
      </div>
      <div style={{ fontFamily: props.font, fontWeight: 700, fontSize: 22, letterSpacing: '0.04em', color: props.inkColor, opacity: 0.65, marginTop: 38, display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 28, height: 2, backgroundColor: props.inkColor, display: 'inline-block' }} />
        {props.citation}
      </div>
    </div>
  );
};
