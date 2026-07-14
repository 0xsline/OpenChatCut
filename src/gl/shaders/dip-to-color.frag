#version 300 es
precision highp float;

// Color-flash dissolve (like dip-to-black, but through a tint color).
// Structure mirrors dip-to-black so mid-progress thumbs still show content.

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform vec3 u_color;
uniform float u_hold;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec3 outColor = texture(u_outgoing, v_texCoord).rgb;
  vec3 inColor = texture(u_incoming, v_texCoord).rgb;
  vec3 fill = u_color;

  // u_hold = fraction of timeline spent at solid color (0..0.5)
  float hold = clamp(u_hold, 0.0, 0.5);
  float halfHold = hold * 0.5;
  float outEnd = clamp(0.5 - halfHold, 0.05, 0.49);
  float inStart = clamp(0.5 + halfHold, 0.51, 0.95);

  float outAlpha = 1.0 - smoothstep(0.0, outEnd, u_progress);
  float inAlpha = smoothstep(inStart, 1.0, u_progress);
  // residual = color flash between the two fades
  float colorAlpha = max(0.0, 1.0 - outAlpha - inAlpha);

  vec3 finalColor = outColor * outAlpha + inColor * inAlpha + fill * colorAlpha;
  fragColor = vec4(finalColor, 1.0);
}
