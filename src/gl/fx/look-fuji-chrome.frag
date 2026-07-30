#version 300 es
precision highp float;
// Inspired by Fuji Classic Chrome film sim: muted chroma, soft S-curve,
// cool-leaning mids, documentary / "小红书旅行" look. Not an official LUT.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_fade;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 softContrast(vec3 c, float k) {
  // gentle S-curve
  vec3 x = clamp(c, 0.0, 1.0);
  return mix(x, x * x * (3.0 - 2.0 * x), k);
}

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // desaturate (chrome = restrained)
  c = mix(vec3(lum), c, 0.72);
  // lift blacks slightly (matte print)
  c = mix(c, max(c, vec3(0.06)), u_fade * 0.45);
  c = softContrast(c, 0.28);
  // cool mids + slightly warm highs
  c.b = clamp(c.b + 0.04 * (1.0 - lum), 0.0, 1.0);
  c.r = clamp(c.r + 0.025 * smoothstep(0.45, 0.95, lum), 0.0, 1.0);
  c.g = clamp(c.g * 0.98, 0.0, 1.0);
  // fine grain
  float n = (hash(v_texCoord * 520.0 + floor(u_time * 18.0)) - 0.5) * u_grain;
  c = clamp(c + n, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
