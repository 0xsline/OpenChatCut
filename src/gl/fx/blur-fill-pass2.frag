#version 300 es
precision highp float;
// pass 2: composite — sharp contain foreground over blurred cover background.
// The blurred cover (pass 0 output) was produced at full canvas size, so its
// u_pass0 sample at v_texCoord gives the correct background pixel.
// u_input holds the contain-fitted foreground (with alpha=0 in letterbox area).
uniform sampler2D u_input;         // contain staging (foreground, sharp)
uniform sampler2D u_pass0;         // blurred cover (from pass 0)
uniform float u_intensity;         // consumed by setUniform (ignored in shader)
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 fg = texture(u_input, v_texCoord);
  vec4 bg = texture(u_pass0, v_texCoord);
  // foreground alpha > 0 means pixel inside the contain area (sharp clip);
  // alpha == 0 means letterbox — show blurred background instead.
  float mask = fg.a > 0.0 ? 1.0 : 0.0;
  fragColor = mix(bg, fg, mask);
}
