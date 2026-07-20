#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_segments;
uniform float u_angle;
uniform float u_zoom;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 uv = v_texCoord - 0.5;
  float r = length(uv) / max(u_zoom, 0.2);
  float a = atan(uv.y, uv.x) + u_angle;
  float seg = max(u_segments, 2.0);
  float slice = 6.2831853 / seg;
  a = mod(a, slice);
  a = abs(a - slice * 0.5);
  vec2 p = vec2(cos(a), sin(a)) * r + 0.5;
  fragColor = texture(u_input, clamp(p, 0.0, 1.0));
}
