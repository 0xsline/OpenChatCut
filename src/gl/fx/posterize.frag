#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_levels;
uniform float u_contrast;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float lv = max(u_levels, 2.0);
  vec3 g = (c.rgb - 0.5) * u_contrast + 0.5;
  vec3 p = floor(clamp(g, 0.0, 1.0) * (lv - 1.0) + 0.5) / (lv - 1.0);
  fragColor = vec4(p, c.a);
}
