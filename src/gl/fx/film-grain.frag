#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_amount;
uniform float u_size;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float s = max(u_size, 0.5);
  vec2 g = floor(v_texCoord * vec2(320.0, 180.0) / s);
  float n = hash(g + floor(u_time * 24.0));
  float grain = (n - 0.5) * 2.0 * u_amount;
  fragColor = vec4(clamp(c.rgb + grain, 0.0, 1.0), c.a);
}
