#version 300 es
precision highp float;
// Inspired by Kodak Gold / consumer color negative: warm yellow-green nostalgia,
// soft contrast, "千禧年随手拍" vibe. Not an official LUT.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_yellow;
uniform float u_fade;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(15.3, 92.1))) * 43758.5453); }

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.299, 0.587, 0.114));
  // soft S + lift
  c = mix(c, c * c * (3.0 - 2.0 * c), 0.2);
  c = mix(c, max(c, vec3(0.07)), u_fade * 0.5);
  // gold: push yellow (r+g), pull blue
  c.r = clamp(c.r * (1.0 + 0.14 * u_yellow), 0.0, 1.2);
  c.g = clamp(c.g * (1.0 + 0.1 * u_yellow) + 0.02, 0.0, 1.15);
  c.b = clamp(c.b * (1.0 - 0.16 * u_yellow), 0.0, 1.0);
  // slight green cast in shadows (old consumer neg)
  c.g = clamp(c.g + 0.03 * (1.0 - lum) * u_yellow, 0.0, 1.1);
  c = mix(vec3(lum), c, 0.9);
  float n = (hash(v_texCoord * 340.0 + floor(u_time * 14.0)) - 0.5) * u_grain;
  c = clamp(c + n, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
