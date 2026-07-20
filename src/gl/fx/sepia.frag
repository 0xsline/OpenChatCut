#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_contrast;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  g = (g - 0.5) * u_contrast + 0.5;
  vec3 sep = vec3(
    clamp(g * 1.15 + 0.08, 0.0, 1.0),
    clamp(g * 0.95 + 0.02, 0.0, 1.0),
    clamp(g * 0.72, 0.0, 1.0)
  );
  fragColor = vec4(mix(c.rgb, sep, clamp(u_intensity, 0.0, 1.0)), c.a);
}
