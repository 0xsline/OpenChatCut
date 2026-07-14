#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_contrast;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 x = (c.rgb - 0.5) * u_contrast + 0.5;
  // crush mids toward magenta/cyan split
  float g = dot(x, vec3(0.299, 0.587, 0.114));
  vec3 shadows = mix(x, vec3(0.05, 0.35, 0.55), 0.45);
  vec3 highs = mix(x, vec3(1.0, 0.25, 0.75), 0.35);
  vec3 look = mix(shadows, highs, smoothstep(0.25, 0.75, g));
  look.b = clamp(look.b + 0.08, 0.0, 1.2);
  fragColor = vec4(mix(c.rgb, look, clamp(u_intensity, 0.0, 1.0)), c.a);
}
