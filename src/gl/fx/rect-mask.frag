#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_canvas_width;
uniform float u_canvas_height;
uniform float u_center_x;
uniform float u_center_y;
uniform float u_rect_width;
uniform float u_rect_height;
uniform float u_corner_radius;
uniform float u_feather;
uniform float u_invert;
in vec2 v_texCoord;
out vec4 fragColor;
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  vec4 color = texture(u_input, v_texCoord);
  vec2 res = vec2(u_canvas_width, u_canvas_height);
  vec2 pixelPos = v_texCoord * res;
  // The user coordinate system is 0-1, map it to pixel space
  vec2 center = vec2(u_center_x, u_center_y) * res;
  // Box half-dimensions in pixel space
  vec2 b = vec2(u_rect_width * u_canvas_width, u_rect_height * u_canvas_height) * 0.5;
  // Prevent corner radius from exceeding half of the shortest side
  float r = min(u_corner_radius, min(b.x, b.y));
  // Calculate the signed distance field for the rounded box
  float dist = sdRoundedBox(pixelPos - center, b, r);
  // Prevent division by zero if feather is set to exactly 0
  float f = max(u_feather, 0.001);
  // Calculate the smooth edge mask based on distance
  float mask = smoothstep(f * 0.5, -f * 0.5, dist);
  if (u_invert > 0.5) {
    mask = 1.0 - mask;
  }
  fragColor = vec4(color.rgb, color.a * mask);
}
