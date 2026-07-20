#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_intensity;
uniform float u_time;

in vec2 v_texCoord;
out vec4 fragColor;

float hash(float n) {
  return fract(sin(n) * 43758.5453123);
}

void main() {
  float p = u_progress;
  float chaos = u_intensity * (1.0 - abs(p * 2.0 - 1.0)); // peak mid-transition
  float band = floor(v_texCoord.y * (18.0 + chaos * 40.0));
  float h = hash(band + floor(u_time * 60.0) + p * 20.0);
  float shift = (h - 0.5) * 0.12 * chaos;
  vec2 uvA = vec2(clamp(v_texCoord.x + shift, 0.0, 1.0), v_texCoord.y);
  vec2 uvB = vec2(clamp(v_texCoord.x - shift * 0.7, 0.0, 1.0), v_texCoord.y);
  vec4 a = texture(u_outgoing, uvA);
  vec4 b = texture(u_incoming, uvB);
  // RGB split on both
  float rgb = 0.01 * chaos;
  a.r = texture(u_outgoing, uvA + vec2(rgb, 0.0)).r;
  a.b = texture(u_outgoing, uvA - vec2(rgb, 0.0)).b;
  b.r = texture(u_incoming, uvB + vec2(rgb, 0.0)).r;
  b.b = texture(u_incoming, uvB - vec2(rgb, 0.0)).b;
  float m = smoothstep(0.25, 0.75, p + (h - 0.5) * 0.2 * chaos);
  fragColor = mix(a, b, m);
}
