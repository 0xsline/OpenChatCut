#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
in vec2 v_texCoord;
out vec4 fragColor;

// Sony S-Log3 / S-Gamut3.Cine → Rec.709. Formula-based (source ships this as a
// real .cube 3D LUT on its CDN; per project constraints we don't fetch its
// backend, so this is the published transfer-function equivalent, not the
// exact .cube). Input pixels are treated as S-Log3 code values.

// S-Log3 code value (0..1, 10-bit normalized) → scene-linear reflection
float slog3ToLin(float x) {
  return x >= 0.16736099204 // 171.2102946929/1023
    ? pow(10.0, (x * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01
    : (x * 1023.0 - 95.0) * 0.01125000 / 76.2102946929;
}

// linear → Rec.709 (BT.709 OETF)
vec3 rec709(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 4.5, 1.099 * pow(c, vec3(0.45)) - 0.099, step(vec3(0.018), c));
}

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 lin = vec3(slog3ToLin(src.r), slog3ToLin(src.g), slog3ToLin(src.b));
  // S-Gamut3.Cine → Rec.709 (linear, published approximation; row-major written
  // as column vectors for GLSL's column-major mat3)
  mat3 M = mat3(
     1.6270, -0.1285, -0.0205,
    -0.2812,  1.1408, -0.1231,
    -0.3458, -0.0123,  1.1435);
  vec3 graded = rec709(M * lin);
  fragColor = vec4(mix(src.rgb, graded, u_intensity), src.a);
}
