# Canvas Pipeline Rules (for hand-editing MG code)

When you edit Motion Graphic asset code through any path that mutates `MotionGraphicAsset.code`, the **local export canvas pipeline** (Chrome's html-in-canvas API) samples the rendered output via `gl.texElementImage2D`, which reads the paint-phase snapshot — NOT the GPU compositor output. Preview uses a DOM layer instead and is not subject to these limits.

The backend may run additional review during asset creation, but not every asset-code update path has that same review. So when you (the editing agent) modify code by hand, **you are the only safeguard** against introducing patterns that make the entire MG render black in local export. The rules below are the ones the backend reviewer enforces during asset creation; mirror them here.

If you violate any pattern, the symptom is consistent: the affected motion graphic appears entirely black or empty in local export, even though preview in ChatCut and a normal browser both look correct. Preview rendering correctly is NOT evidence that export will work.

## The three canvas-pipeline traps

### 1. SVG inner-element `transform` attribute

Inside any `<svg>`, the OUTERMOST `<g transform="...">` is allowed. Any `transform=""` attribute on an inner `<path>`, `<line>`, `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, or a nested `<g>` breaks the canvas pipeline.

**Wrong:**

```jsx
<svg width={W} height={H}>
  <g transform="translate(960, 540)">
    {leaves.map((l, i) => (
      <g key={i} transform={`translate(${l.x},${l.y}) rotate(${l.rot})`}>
        <path d="M0,0 C-25,-35 0,-90 0,-90" />
      </g>
    ))}
  </g>
</svg>
```

**Right** — bake rotation+translation into absolute path coordinates at `React.useMemo` time:

```jsx
const leafPaths = React.useMemo(() => {
  const tx = (px, py, cx, cy, deg) => {
    const r = (deg * Math.PI) / 180;
    return [
      Math.cos(r) * px - Math.sin(r) * py + cx,
      Math.sin(r) * px + Math.cos(r) * py + cy,
    ];
  };
  const CONTROL_POINTS = [
    [0, 0],
    [-25, -35],
    [0, -90],
    [0, -90],
  ];
  return leaves.map((l, i) => {
    const pts = CONTROL_POINTS.map(([x, y]) => tx(x, y, l.x, l.y, l.rot));
    return {
      key: i,
      d: `M${pts[0][0]},${pts[0][1]} C${pts[1][0]},${pts[1][1]} ${pts[2][0]},${pts[2][1]} ${pts[3][0]},${pts[3][1]}`,
    };
  });
}, [leaves]);

<svg width={W} height={H}>
  <g transform="translate(960, 540)">
    {leafPaths.map((p) => (
      <path key={p.key} d={p.d} />
    ))}
  </g>
</svg>;
```

### 2. Animated CSS on the `<svg>` element itself

`style.opacity` or `style.transform` directly on a `<svg>` element with a per-frame interpolated value breaks the canvas pipeline.

**Wrong:**

```jsx
<svg style={{ opacity: interpolate(frame, [0,30], [0,1]) }}>...</svg>
<svg style={{ transform: `scale(${animScale})` }}>...</svg>
```

**Right** — wrap in an HTML `<div>` for opacity; use SVG `transform=""` attribute on outermost `<g>` for scale:

```jsx
<div style={{ opacity: interpolate(frame, [0, 30], [0, 1]) }}>
  <svg>
    <g transform={`scale(${animScale})`}>...</g>
  </svg>
</div>
```

### 3. SVG `opacity` presentation attribute on inner elements

`opacity={0.6}` on inner SVG elements (`<line>`, `<path>`, `<circle>`, etc.) has the same compositor-driven semantics as CSS `style.opacity` and breaks the pipeline.

**Wrong:**

```jsx
<line opacity={0.6} stroke={accentColor} />
<circle opacity={0.3} fill={mainColor} />
```

**Right** — bake alpha into stroke/fill color:

```jsx
<line stroke="rgba(255,255,255,0.6)" />
<circle fill="rgba(255,165,0,0.3)" />
```

(If the color comes from an editable prop like `props.accentColor` and you can't precompute rgba, do the alpha conversion in `useMemo`: parse the hex prop, compute `rgba(r,g,b,a)`, and bind that as the stroke/fill string.)

## When to re-read this

- Before any update that changes `motion-graphic` asset `code`
- When debugging a "preview looks fine but the exported MP4 renders black" report — almost always one of these three
- When integrating an external SVG snippet that uses inner-element `transform=` (most hand-authored SVGs do; you'll need to bake the transforms)

## Safe patterns (paint-phase, work correctly)

- HTML element `style`: `boxShadow`, `textShadow`, static `opacity`, `transform` (translate/scale/rotate), `borderRadius`, gradients via `background` / `backgroundImage`
- SVG: outer `<g transform="">` only; all inner shapes use absolute `d=""` coordinates
- SVG-native filters in `<defs>` (`<feGaussianBlur>`, `<feBlend>`, `<feColorMatrix>`, `<feDropShadow>`) applied via the SVG `filter="url(#id)"` ATTRIBUTE on an inner element — these DO work (they run in the paint phase, not the compositor)
