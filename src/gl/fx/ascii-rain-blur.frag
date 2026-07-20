#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_direction;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec2 texel = 1.0 / u_resolution;
  vec4 sum = vec4(0.0);
  sum += texture(u_input, v_texCoord - 4.0 * texel * u_direction) * 0.016216;
  sum += texture(u_input, v_texCoord - 3.0 * texel * u_direction) * 0.054054;
  sum += texture(u_input, v_texCoord - 2.0 * texel * u_direction) * 0.1216216;
  sum += texture(u_input, v_texCoord - 1.0 * texel * u_direction) * 0.1945946;
  sum += texture(u_input, v_texCoord) * 0.227027;
  sum += texture(u_input, v_texCoord + 1.0 * texel * u_direction) * 0.1945946;
  sum += texture(u_input, v_texCoord + 2.0 * texel * u_direction) * 0.1216216;
  sum += texture(u_input, v_texCoord + 3.0 * texel * u_direction) * 0.054054;
  sum += texture(u_input, v_texCoord + 4.0 * texel * u_direction) * 0.016216;
  fragColor = sum;
}
