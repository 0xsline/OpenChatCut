const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const props = item.props || {};
  const barGrow = interpolate(frame, [0, 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const wipe = interpolate(frame - 8, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const bg = props.transparentBackground ? 'transparent' : props.paperColor;
  const rootStyle = { position: 'absolute', inset: 0, backgroundColor: bg, display: 'flex', alignItems: 'flex-end', padding: 80 };

  return (
    <div style={rootStyle}>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{ width: 10, backgroundColor: props.accentColor, alignSelf: 'stretch', transform: `scaleY(${barGrow})`, transformOrigin: 'top center' }} />
        <div style={{ overflow: 'hidden' }}>
          <div style={{ transform: `translateX(${(1 - wipe) * 100}%)`, padding: '12px 26px' }}>
            <div style={{ fontFamily: props.font, fontWeight: 900, fontSize: 58, letterSpacing: '-0.01em', lineHeight: 1, color: props.inkColor }}>{props.name}</div>
            <div style={{ fontFamily: props.font, fontWeight: 600, fontSize: 22, letterSpacing: '0.04em', color: props.inkSoftColor, marginTop: 8 }}>{props.role}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
