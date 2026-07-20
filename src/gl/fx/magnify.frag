#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_width;
uniform float u_height;
uniform float u_center_x;
uniform float u_center_y;
uniform float u_radius;
uniform float u_magnification;
uniform float u_border_width;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 res    = vec2(u_width, u_height);
  vec2 px     = v_texCoord * res;
  vec2 center = vec2(u_center_x, u_center_y) * res;
  float r     = u_radius * min(res.x, res.y) * 0.5;
  float bw    = u_border_width;
  float dist  = length(px - center);
  vec2 magUV  = clamp((center + (px - center) / u_magnification) / res, 0.0, 1.0);
  vec4 orig   = texture(u_input, v_texCoord);
  vec4 mag    = texture(u_input, magUV);
  float inner  = 1.0 - smoothstep(r - 1.5, r + 1.5, dist);
  float outer  = 1.0 - smoothstep((r + bw) - 1.5, (r + bw) + 1.5, dist);
  float border = clamp(outer - inner, 0.0, 1.0);
  vec4 col = orig;
  col = mix(col, vec4(1.0, 1.0, 1.0, 1.0), border);
  col = mix(col, mag, inner);
  fragColor = col;
}
