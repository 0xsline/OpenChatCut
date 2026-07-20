#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_amount;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 px = u_amount / max(u_resolution, vec2(1.0));
  vec4 acc = vec4(0.0);
  acc += texture(u_input, v_texCoord) * 0.2;
  acc += texture(u_input, v_texCoord + vec2(px.x, 0.0)) * 0.15;
  acc += texture(u_input, v_texCoord - vec2(px.x, 0.0)) * 0.15;
  acc += texture(u_input, v_texCoord + vec2(0.0, px.y)) * 0.15;
  acc += texture(u_input, v_texCoord - vec2(0.0, px.y)) * 0.15;
  acc += texture(u_input, v_texCoord + px) * 0.1;
  acc += texture(u_input, v_texCoord - px) * 0.1;
  fragColor = acc;
}
