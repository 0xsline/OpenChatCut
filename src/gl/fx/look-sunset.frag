#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_warmth;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec3 warm = c.rgb * vec3(1.0 + 0.25 * u_warmth, 1.0, 1.0 - 0.15 * u_warmth);
  warm.r = clamp(warm.r + 0.08 * u_warmth, 0.0, 1.5);
  warm.b = clamp(warm.b - 0.05 * u_warmth + g * 0.05, 0.0, 1.0);
  // soft highlight lift toward peach
  warm = mix(warm, vec3(1.0, 0.78, 0.55), smoothstep(0.55, 1.0, g) * 0.18 * u_warmth);
  fragColor = vec4(mix(c.rgb, warm, clamp(u_intensity, 0.0, 1.0)), c.a);
}
