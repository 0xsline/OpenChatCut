#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_temperature;
uniform float u_shadows;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 col = c.rgb;
  col.b *= 1.0 + u_temperature * 0.22;
  col.r *= 1.0 - u_temperature * 0.12;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, col * vec3(0.75, 0.9, 1.15), (1.0 - lum) * u_shadows);
  fragColor = vec4(mix(c.rgb, clamp(col, 0.0, 1.0), u_intensity), c.a);
}
