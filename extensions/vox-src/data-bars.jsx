const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const props = item.props || {};
  const parseBars = (raw) => {
    try {
      const v = JSON.parse(String(raw));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const bars = parseBars(props.dataJson);
  const bg = props.transparentBackground ? 'transparent' : props.paperColor;
  const rootStyle = { position: 'absolute', inset: 0, backgroundColor: bg };

  return (
    <div style={{ ...rootStyle, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', padding: 80 }}>
      <div style={{ fontFamily: props.font, fontWeight: 900, fontSize: 52, letterSpacing: '-0.01em', color: props.inkColor, marginBottom: 44, maxWidth: '80%' }}>{props.title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {bars.map((b, i) => {
          const start = 6 + i * 8;
          const grow = interpolate(frame - start, [0, 22], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
          const pct = (Number(b.pct) || 0) * grow;
          const fill = b.acc ? props.alertColor : props.barColor;
          const rowStyle = { display: 'grid', gridTemplateColumns: '240px 1fr 110px', alignItems: 'center', gap: 20 };
          return (
            <div key={i} style={rowStyle}>
              <div style={{ fontFamily: props.font, fontWeight: 600, fontSize: 26, color: props.inkColor }}>{b.name}</div>
              <div style={{ height: 32, backgroundColor: 'rgba(21,20,15,0.08)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: pct + '%', backgroundColor: fill, borderRadius: 4 }} />
              </div>
              <div style={{ fontFamily: props.font, fontWeight: 600, fontSize: 24, textAlign: 'right', color: props.inkColor }}>{b.val}%</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
