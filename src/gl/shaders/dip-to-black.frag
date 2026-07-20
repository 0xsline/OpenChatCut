#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_blackDuration;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  float halfDuration = u_blackDuration * 0.5;

  float outEnd = clamp(0.5 - halfDuration, 0.01, 0.49);
  float inStart = clamp(0.5 + halfDuration, 0.51, 0.99);

  float outAlpha = 1.0 - smoothstep(0.0, outEnd, u_progress);
  float inAlpha = smoothstep(inStart, 1.0, u_progress);

  vec3 outColor = texture(u_outgoing, v_texCoord).rgb;
  vec3 inColor = texture(u_incoming, v_texCoord).rgb;

  vec3 finalColor = (outColor * outAlpha) + (inColor * inAlpha);

  fragColor = vec4(finalColor, 1.0);
}
