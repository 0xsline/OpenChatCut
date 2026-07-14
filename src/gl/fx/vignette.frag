#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_amount;
uniform float u_softness;
uniform float u_roundness;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec2 uv = v_texCoord * 2.0 - 1.0;
  uv.x *= mix(1.0, u_roundness, 0.5);
  float d = length(uv);
  float edge = 1.0 - u_amount * 0.85;
  float vig = smoothstep(edge, edge - max(u_softness, 0.01), d);
  fragColor = vec4(c.rgb * vig, c.a);
}
