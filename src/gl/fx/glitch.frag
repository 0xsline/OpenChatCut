#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_blockSize;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float t = floor(u_time * 12.0);
  float row = floor(v_texCoord.y * max(u_blockSize, 2.0));
  float slice = hash(row + t);
  float shift = 0.0;
  if (slice > 0.72) shift = (hash(row * 3.1 + t) - 0.5) * 2.0 * u_intensity * 0.12;
  vec2 uv = v_texCoord + vec2(shift, 0.0);
  float ch = hash(row * 7.7 + t);
  vec4 c = texture(u_input, clamp(uv, 0.0, 1.0));
  if (ch > 0.88) {
    float r = texture(u_input, clamp(uv + vec2(u_intensity * 0.03, 0.0), 0.0, 1.0)).r;
    float b = texture(u_input, clamp(uv - vec2(u_intensity * 0.03, 0.0), 0.0, 1.0)).b;
    c.r = r; c.b = b;
  }
  if (slice > 0.94) c.rgb = 1.0 - c.rgb;
  fragColor = c;
}
