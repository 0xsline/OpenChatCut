#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_mode; // 0 left→right, 1 right→left, 2 top→bottom, 3 bottom→top
uniform float u_axis;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 uv = v_texCoord;
  float m = floor(u_mode + 0.5);
  if (m < 0.5) {
    if (uv.x > u_axis) uv.x = u_axis - (uv.x - u_axis);
  } else if (m < 1.5) {
    if (uv.x < u_axis) uv.x = u_axis + (u_axis - uv.x);
  } else if (m < 2.5) {
    if (uv.y > u_axis) uv.y = u_axis - (uv.y - u_axis);
  } else {
    if (uv.y < u_axis) uv.y = u_axis + (u_axis - uv.y);
  }
  fragColor = texture(u_input, clamp(uv, 0.0, 1.0));
}
