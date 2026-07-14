#version 300 es
precision highp float;
// Inspired by CineStill 800T night look: cool tungsten base, cyan-ish
// highlight bloom suggestion, contrasty night city. Not an official LUT.
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_cyan;
uniform float u_contrast;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(33.7, 91.2))) * 43758.5453); }

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 c = src.rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = (c - 0.5) * u_contrast + 0.5;
  // tungsten → cooler shadows, cyan-magenta split
  c.b = clamp(c.b + 0.1 * u_cyan * (1.0 - lum), 0.0, 1.2);
  c.g = clamp(c.g + 0.04 * u_cyan, 0.0, 1.15);
  c.r = clamp(c.r - 0.05 * u_cyan * (1.0 - lum) + 0.06 * smoothstep(0.55, 1.0, lum), 0.0, 1.15);
  // highlight glow suggestion (lift brights toward cyan-white)
  float hi = smoothstep(0.65, 0.95, lum);
  c = mix(c, min(c * vec3(0.9, 1.05, 1.12) + 0.08, vec3(1.0)), hi * 0.45 * u_cyan);
  float n = (hash(v_texCoord * 500.0 + floor(u_time * 20.0)) - 0.5) * u_grain;
  c = clamp(c + n, 0.0, 1.0);
  fragColor = vec4(mix(src.rgb, c, clamp(u_intensity, 0.0, 1.0)), src.a);
}
