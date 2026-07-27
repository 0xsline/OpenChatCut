const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const props = item.props || {};
  const words = String(props.headline).split(' ');
  const hi = Number(props.highlightIndex);
  const bg = props.transparentBackground ? 'transparent' : props.paperColor;
  const rootStyle = { position: 'absolute', inset: 0, backgroundColor: bg };

  return (
    <div style={{ ...rootStyle, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 32 }}>
        <div style={{ width: 44, height: 4, backgroundColor: props.inkColor }} />
        <span style={{ fontFamily: props.font, fontWeight: 800, fontSize: 22, letterSpacing: '0.18em', textTransform: 'uppercase', color: props.inkColor, opacity: 0.65 }}>{props.kicker}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.1em 0.26em', fontFamily: props.font, fontWeight: 900, fontSize: 132, lineHeight: 0.96, letterSpacing: '-0.025em', color: props.inkColor }}>
        {words.map((w, i) => {
          const start = i * 5;
          const s = spring({ frame: frame - start, fps, config: { damping: 14, stiffness: 180 } });
          const op = Math.min(1, s * 2);
          const sweep = interpolate(frame - start - 8, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
          const isHi = i === hi;
          const wrapStyle = { display: 'inline-block', position: 'relative', transform: `scale(${s})`, opacity: op };
          if (isHi) {
            return (
              <span key={i} style={{ ...wrapStyle, padding: '0 0.12em' }}>
                <span style={{ position: 'relative', zIndex: 2 }}>{w}</span>
                <span style={{ position: 'absolute', inset: 0, zIndex: 1, backgroundColor: props.accentColor, transform: `scaleX(${sweep})`, transformOrigin: 'left center' }} />
              </span>
            );
          }
          return <span key={i} style={wrapStyle}>{w}</span>;
        })}
      </div>
    </div>
  );
};
