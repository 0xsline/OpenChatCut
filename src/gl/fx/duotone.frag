#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec3 u_shadowColor;
uniform vec3 u_highlightColor;
uniform float u_contrast;
uniform float u_intensity;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  lum = clamp((lum - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  vec3 duo = mix(u_shadowColor, u_highlightColor, lum);
  fragColor = vec4(mix(c.rgb, duo, u_intensity), c.a);
}
