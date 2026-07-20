#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_strength;
uniform float u_zoom;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 uv = v_texCoord * 2.0 - 1.0;
  float r = length(uv);
  float k = u_strength;
  float f = 1.0 + k * r * r;
  uv = uv * f / max(u_zoom, 0.2);
  uv = uv * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  fragColor = texture(u_input, uv);
}
