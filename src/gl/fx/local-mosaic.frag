#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_width;
uniform float u_height;
uniform float u_center_x;
uniform float u_center_y;
uniform float u_width_ratio;
uniform float u_height_ratio;
uniform float u_block_size;
uniform float u_feather;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 res = vec2(u_width, u_height);
  vec2 px = v_texCoord * res;
  vec2 center = vec2(u_center_x, u_center_y) * res;
  vec2 halfSize = vec2(u_width_ratio * res.x, u_height_ratio * res.y) * 0.5;
  // Pixelate: snap UV to nearest block center
  // Avoid division by zero by clamping block size to a small minimum
  float safe_block_size = max(u_block_size, 1.0);
  vec2 blockUV = (floor(px / safe_block_size) + 0.5) * safe_block_size / res;
  blockUV = clamp(blockUV, 0.0, 1.0);
  vec4 pixelated = texture(u_input, blockUV);
  vec4 original  = texture(u_input, v_texCoord);
  // Box SDF for region boundary
  vec2 d = abs(px - center) - halfSize;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  // Feathered blend: inside region = pixelated, outside = original
  float mask = 1.0 - smoothstep(-max(u_feather, 0.01), 0.0, dist);
  fragColor = mix(original, pixelated, mask);
}
