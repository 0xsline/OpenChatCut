#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_easingAmount;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 outColor = texture(u_outgoing, v_texCoord);
  vec4 inColor = texture(u_incoming, v_texCoord);

  float smoothP = smoothstep(0.0, 1.0, u_progress);
  float p = mix(u_progress, smoothP, u_easingAmount);

  fragColor = mix(outColor, inColor, p);
}
