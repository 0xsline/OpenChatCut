#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_amount;
uniform float u_angle;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec2 dir = vec2(cos(u_angle), sin(u_angle)) * u_amount;
  float r = texture(u_input, v_texCoord + dir).r;
  float g = texture(u_input, v_texCoord).g;
  float b = texture(u_input, v_texCoord - dir).b;
  float a = texture(u_input, v_texCoord).a;
  fragColor = vec4(r, g, b, a);
}
