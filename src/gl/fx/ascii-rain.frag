#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_gridSize;
uniform vec3 u_color;
in vec2 v_texCoord;
out vec4 fragColor;

const int chars[16] = int[16](
  9367, 9389, 5101, 18575, 29874, 18855, 23530, 29847,
  31143, 23407, 29647, 27502, 31599, 29679, 27566, 31727
);

float random(vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898,78.233))) * 43758.5453123);
}

void main() {
  vec2 uvPx = v_texCoord * u_resolution;
  vec2 cellSizePx = vec2(max(4.0, u_gridSize));

  vec2 cellId = floor(uvPx / cellSizePx);
  vec2 cellUv = fract(uvPx / cellSizePx);

  vec2 cellCenterUv = (cellId + 0.5) * cellSizePx / u_resolution;

  vec3 vidColor = texture(u_input, cellCenterUv).rgb;
  float lum = dot(vidColor, vec3(0.299, 0.587, 0.114));

  float rnd = random(cellId);

  // Pipeline convention: FBO textures carry premultiplied alpha; the display
  // pass converts back to straight for the canvas. Track-composite shaders
  // that produce opaque output on dark/void pixels block every track below
  // them in the DOM stack — see canvas/composition-worker/eligibility.ts on
  // why per-track canvases can't be merged: MG/captions/JSX need DOM and
  // must stay on their own layer.
  if (lum < 0.05 + rnd * 0.08) {
    fragColor = vec4(0.0);
    return;
  }

  float mappedLum = clamp((lum + rnd * 0.3 - 0.15), 0.0, 1.0);
  int charIdx = int(mappedLum * 15.99);

  vec2 localUv = cellUv * vec2(5.0, 7.0) - vec2(1.0, 1.0);
  vec2 gridPos = floor(localUv);
  vec2 gridFract = fract(localUv);

  float charAlpha = 0.0;
  int cx = int(gridPos.x);
  int cy = int(gridPos.y);

  if (cx >= 0 && cx < 3 && cy >= 0 && cy < 5) {
    int bitIdx = cy * 3 + cx;
    int charData = chars[charIdx];
    float bitOn = float((charData >> bitIdx) & 1);
    float box = smoothstep(0.65, 0.2, max(abs(gridFract.x - 0.5), abs(gridFract.y - 0.5)));
    charAlpha = bitOn * box;
  }

  float distToCenter = length(cellUv - 0.5);
  float cellGlow = smoothstep(0.8, 0.0, distToCenter) * lum * 0.4;

  float intensity = clamp(charAlpha + cellGlow, 0.0, 1.0);
  vec3 finalColor = u_color * intensity * (0.6 + lum * 1.2);

  fragColor = vec4(finalColor, intensity);
}
