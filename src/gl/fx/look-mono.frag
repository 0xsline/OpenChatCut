#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_contrast;
uniform float u_grain;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float y = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  y = clamp((y - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float n = (hash(v_texCoord * 400.0 + floor(u_time * 20.0)) - 0.5) * u_grain;
  vec3 mono = vec3(clamp(y + n, 0.0, 1.0));
  fragColor = vec4(mix(c.rgb, mono, u_intensity), c.a);
}
