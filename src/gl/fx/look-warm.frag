#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_temperature;
uniform float u_fade;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 w = c.rgb;
  w.r *= 1.0 + u_temperature * 0.25;
  w.b *= 1.0 - u_temperature * 0.2;
  w = mix(w, vec3(dot(w, vec3(0.3))), u_fade * 0.35); // slight desat
  w = mix(w, w * vec3(1.05, 0.95, 0.8), 0.35); // warm matte
  fragColor = vec4(mix(c.rgb, clamp(w, 0.0, 1.0), u_intensity), c.a);
}
