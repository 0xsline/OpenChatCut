#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_fade;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float g = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  // desaturate + lift blacks (bleach bypass-ish)
  vec3 desat = mix(c.rgb, vec3(g), 0.55);
  desat = mix(desat, desat * desat * (3.0 - 2.0 * desat), 0.25); // soft contrast
  desat = mix(desat, vec3(0.5), u_fade * 0.35); // faded lift
  desat = clamp(desat * 1.08, 0.0, 1.0);
  fragColor = vec4(mix(c.rgb, desat, clamp(u_intensity, 0.0, 1.0)), c.a);
}
