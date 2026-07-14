#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform sampler2D u_bloom;
uniform float u_glow;
in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 base = texture(u_input, v_texCoord);
  vec4 bloom = texture(u_bloom, v_texCoord);
  vec3 color = base.rgb + bloom.rgb * u_glow;
  float alpha = clamp(base.a + bloom.a * u_glow, 0.0, 1.0);
  fragColor = vec4(clamp(color, 0.0, 1.0), alpha);
}
