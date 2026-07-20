#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 inv = 1.0 - c.rgb;
  fragColor = vec4(mix(c.rgb, inv, clamp(u_intensity, 0.0, 1.0)), c.a);
}
