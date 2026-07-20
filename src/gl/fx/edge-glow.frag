#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_strength;
uniform float u_threshold;
uniform vec3 u_color;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 px = 1.0 / max(u_resolution, vec2(1.0));
  float l = lum(texture(u_input, v_texCoord).rgb);
  float lx = lum(texture(u_input, v_texCoord + vec2(px.x, 0.0)).rgb) - lum(texture(u_input, v_texCoord - vec2(px.x, 0.0)).rgb);
  float ly = lum(texture(u_input, v_texCoord + vec2(0.0, px.y)).rgb) - lum(texture(u_input, v_texCoord - vec2(0.0, px.y)).rgb);
  float e = length(vec2(lx, ly));
  e = smoothstep(u_threshold, u_threshold + 0.15, e);
  vec4 base = texture(u_input, v_texCoord);
  fragColor = vec4(clamp(base.rgb + u_color * e * u_strength, 0.0, 1.0), base.a);
}
