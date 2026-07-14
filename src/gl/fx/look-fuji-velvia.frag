#version 300 es
precision highp float;
// Inspired by Fuji Velvia / vivid landscape stock: punchy greens & blues,
// deep contrast, saturated travel photos. Not an official LUT.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_saturation;
uniform float u_contrast;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  c = (c - 0.5) * u_contrast + 0.5;
  // boost green/blue channels selectively (landscape)
  c.g = clamp(c.g * (1.0 + 0.18 * u_saturation), 0.0, 1.25);
  c.b = clamp(c.b * (1.0 + 0.14 * u_saturation), 0.0, 1.2);
  c.r = clamp(c.r * (1.0 + 0.06 * u_saturation), 0.0, 1.15);
  c = mix(vec3(lum), c, 0.55 + 0.45 * u_saturation);
  // slightly cooler shadows
  c.b = clamp(c.b + 0.03 * (1.0 - lum), 0.0, 1.0);
  float n = (hash(v_texCoord * 450.0 + floor(u_time * 16.0)) - 0.5) * u_grain;
  c = clamp(c + n, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
