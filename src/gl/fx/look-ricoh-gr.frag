#version 300 es
precision highp float;
// Inspired by Ricoh GR street aesthetic: hard-ish contrast, cool-neutral
// mids, crisp edges feel, slight green-gray city cast. Not an official profile.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_contrast;
uniform float u_cool;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.2, 289.7))) * 43758.5453); }

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // punchy mid contrast (street snap)
  c = (c - 0.5) * u_contrast + 0.5;
  // slight green-gray + cool (GR "realistic" street)
  c.g = clamp(c.g * (1.0 + 0.04 * u_cool), 0.0, 1.1);
  c.b = clamp(c.b * (1.0 + 0.08 * u_cool), 0.0, 1.15);
  c.r = clamp(c.r * (1.0 - 0.05 * u_cool), 0.0, 1.05);
  // mild desat for documentary
  c = mix(vec3(lum), c, 0.88);
  // crush deep blacks a bit
  c = max(c - vec3(0.02), vec3(0.0));
  c *= 1.04;
  float n = (hash(v_texCoord * 600.0 + floor(u_time * 22.0)) - 0.5) * u_grain;
  c = clamp(c + n, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
