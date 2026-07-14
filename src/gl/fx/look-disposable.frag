#version 300 es
precision highp float;
// Inspired by disposable / 拍立得 / cheap point-and-shoot: soft focus feel via
// mild blur-like desat, green-magenta cast, heavy grain, vignette-ish edges.
// Not an official film stock.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_cast;
uniform float u_grain;
uniform float u_vignette;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(19.1, 67.3))) * 43758.5453); }

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.3, 0.59, 0.11));
  // low contrast, lifted black / crushed white
  c = mix(c, vec3(0.15 + lum * 0.7), 0.35);
  c = mix(vec3(lum), c, 0.75);
  // green-yellow cast + slight magenta in highs
  c.g = clamp(c.g + 0.06 * u_cast, 0.0, 1.1);
  c.r = clamp(c.r + 0.03 * u_cast * smoothstep(0.5, 1.0, lum), 0.0, 1.1);
  c.b = clamp(c.b - 0.04 * u_cast + 0.03 * smoothstep(0.6, 1.0, lum), 0.0, 1.0);
  // vignette
  vec2 uv = v_texCoord * 2.0 - 1.0;
  float v = smoothstep(1.4, 0.35, length(uv));
  c *= mix(1.0, v, u_vignette);
  // chunky grain
  float n = (hash(v_texCoord * 280.0 + floor(u_time * 10.0)) - 0.5) * u_grain;
  float n2 = (hash(v_texCoord * 90.0 + 3.7) - 0.5) * u_grain * 0.5;
  c = clamp(c + n + n2, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
