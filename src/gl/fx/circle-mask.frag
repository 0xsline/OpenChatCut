#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_width;
uniform float u_height;
uniform float u_center_x;
uniform float u_center_y;
uniform float u_radius;
uniform float u_feather;
uniform float u_invert;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 color = texture(u_input, v_texCoord);
  vec2 res = vec2(u_width, u_height);
  vec2 pixelPos = v_texCoord * res;
  // The user coordinate system is 0-1, so we map it to pixel space
  vec2 center = vec2(u_center_x, u_center_y) * res;
  // Radius is given as a fraction of the shortest dimension to stay a perfect circle
  float r = u_radius * min(res.x, res.y) * 0.5;
  float dist = length(pixelPos - center) - r;
  // Prevent division by zero if feather is set to exactly 0
  float f = max(u_feather, 0.001);
  // Calculate the smooth edge mask based on the distance
  float mask = smoothstep(f * 0.5, -f * 0.5, dist);
  if (u_invert > 0.5) {
    mask = 1.0 - mask;
  }
  fragColor = vec4(color.rgb, color.a * mask);
}
