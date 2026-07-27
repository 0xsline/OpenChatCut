const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const props = item.props || {};
  const target = Number(props.value);
  const dur = 30;
  const eased = interpolate(frame, [0, dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
  const shown = Math.round(target * eased);
  const under = interpolate(frame - dur, [0, 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const bg = props.transparentBackground ? 'transparent' : props.paperColor;
  const rootStyle = { position: 'absolute', inset: 0, backgroundColor: bg };

  return (
    <div style={{ ...rootStyle, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 80 }}>
      <div style={{ fontFamily: props.font, fontWeight: 800, fontSize: 24, letterSpacing: '0.16em', textTransform: 'uppercase', color: props.inkColor, opacity: 0.65, marginBottom: 10 }}>{props.label}</div>
      <div style={{ fontFamily: props.font, fontWeight: 900, fontSize: 300, lineHeight: 0.88, letterSpacing: '-0.04em', color: props.inkColor, display: 'flex', alignItems: 'flex-start' }}>
        {shown}
        <span style={{ fontSize: 96, fontWeight: 800, color: props.alertColor, marginLeft: 10, marginTop: 26 }}>{props.suffix}</span>
      </div>
      <div style={{ height: 9, width: '46%', backgroundColor: props.accentColor, transform: `scaleX(${under})`, transformOrigin: 'left center', marginTop: 18 }} />
      <div style={{ fontFamily: props.font, fontSize: 18, color: props.inkColor, opacity: 0.6, marginTop: 24 }}>{props.source}</div>
    </div>
  );
};
