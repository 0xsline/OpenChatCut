#version 300 es
precision highp float;
// Inspired by Kodak/Fuji portrait stock (Portra / Pro Neg Hi): soft pastel,
// creamy skin, lifted shadows, gentle warm bias. Not an official LUT.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_warmth;
uniform float u_softness;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // soft contrast (low mid punch)
  c = mix(c, (c - 0.5) * 0.88 + 0.5, u_softness);
  // lift shadows, roll off highlights
  c = mix(c, max(c, vec3(0.08 + lum * 0.05)), 0.35);
  c = min(c, vec3(0.96));
  // warm pastel: peach mids, soft green control
  c.r = clamp(c.r * (1.0 + 0.12 * u_warmth), 0.0, 1.2);
  c.g = clamp(c.g * (1.0 + 0.04 * u_warmth) - 0.02, 0.0, 1.1);
  c.b = clamp(c.b * (1.0 - 0.1 * u_warmth) + 0.02, 0.0, 1.0);
  // slight desat on high chroma (skin-friendly)
  float maxc = max(c.r, max(c.g, c.b));
  float minc = min(c.r, min(c.g, c.b));
  float sat = maxc - minc;
  c = mix(vec3(lum), c, mix(1.0, 0.82, smoothstep(0.15, 0.55, sat)));
  float n = (hash(v_texCoord * 380.0 + floor(u_time * 12.0)) - 0.5) * u_grain;
  c = clamp(c + n, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
