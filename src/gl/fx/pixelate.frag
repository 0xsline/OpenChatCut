#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_blockSize;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  float b = max(u_blockSize, 1.0);
  vec2 res = max(u_resolution, vec2(1.0));
  vec2 blocks = res / b;
  vec2 uv = (floor(v_texCoord * blocks) + 0.5) / blocks;
  fragColor = texture(u_input, uv);
}
