#version 300 es
precision highp float;
precision highp sampler3D;

uniform sampler2D u_input;
uniform sampler3D u_lut;
uniform float u_intensity;

in vec2 v_texCoord;
out vec4 fragColor;

vec3 linearToBt709(vec3 lin) {
  lin = max(lin, vec3(0.0));
  vec3 lo = lin * 4.5;
  vec3 hi = 1.099 * pow(lin, vec3(0.45)) - 0.099;
  return mix(lo, hi, step(0.018, lin));
}

vec3 bt709ToLinear(vec3 encoded) {
  encoded = clamp(encoded, vec3(0.0), vec3(1.0));
  vec3 lo = encoded / 4.5;
  vec3 hi = pow((encoded + 0.099) / 1.099, vec3(1.0 / 0.45));
  return mix(lo, hi, step(0.081, encoded));
}

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 encoded = linearToBt709(src.rgb);
  vec3 graded = texture(
    u_lut,
    clamp(encoded, vec3(0.0), vec3(1.0))
  ).rgb;
  fragColor = vec4(bt709ToLinear(mix(encoded, graded, u_intensity)), src.a);
}
