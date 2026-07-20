#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_feather;
uniform vec2 u_center;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 a = texture(u_outgoing, v_texCoord);
  vec4 b = texture(u_incoming, v_texCoord);
  vec2 uv = v_texCoord;
  float aspect = 16.0 / 9.0;
  vec2 d = (uv - u_center) * vec2(aspect, 1.0);
  float r = length(d);
  // expand circle radius past corners
  float maxR = length(vec2(aspect, 1.0) * 0.72);
  float edge = u_progress * maxR;
  float soft = max(u_feather, 0.001);
  float m = smoothstep(edge - soft, edge + soft, r);
  fragColor = mix(b, a, m);
}
