#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_angle;
uniform float u_spread;
uniform vec3 u_tint;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec2 uv = v_texCoord - 0.5;
  float ca = cos(u_angle), sa = sin(u_angle);
  float x = uv.x * ca + uv.y * sa;
  float pulse = 0.85 + 0.15 * sin(u_time * 1.7);
  float band = exp(-pow(x / max(u_spread, 0.05), 2.0)) * pulse;
  vec3 leak = u_tint * band * u_intensity;
  // screen blend so highlights bloom without crushing
  vec3 outc = 1.0 - (1.0 - c.rgb) * (1.0 - leak);
  fragColor = vec4(clamp(outc, 0.0, 1.0), c.a);
}
