#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_contrast;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 g = (c.rgb - 0.5) * u_contrast + 0.5;
  float lum = dot(g, vec3(0.299, 0.587, 0.114));
  // push shadows teal, highlights orange
  vec3 teal = vec3(0.15, 0.45, 0.55);
  vec3 orange = vec3(0.95, 0.55, 0.25);
  vec3 grade = mix(teal * lum * 1.4, orange * (0.4 + lum * 0.9), smoothstep(0.25, 0.75, lum));
  // keep some original chroma
  vec3 mixed = mix(g, mix(g * 0.55 + grade * 0.45, grade, 0.35), 1.0);
  fragColor = vec4(mix(c.rgb, clamp(mixed, 0.0, 1.0), u_intensity), c.a);
}
