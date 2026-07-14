#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_intensity;
in vec2 v_texCoord;
out vec4 fragColor;

// Canon Cinema Gamut / Canon Log 3 → Canon 709. Formula-based equivalent of the
// source's real .cube LUT (not fetched — backend off-limits). Input treated as
// Canon Log3 code values; constants from the published Canon Log3 ACES IDT.

float clog3ToLin(float x) {
  if (x < 0.097465473) return -(pow(10.0, (0.12783901 - x) / 0.36726845) - 1.0) / 14.98325;
  if (x <= 0.15277891) return (x - 0.12512219) / 1.9754798;
  return (pow(10.0, (x - 0.12240537) / 0.36726845) - 1.0) / 14.98325;
}

vec3 rec709(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 4.5, 1.099 * pow(c, vec3(0.45)) - 0.099, step(vec3(0.018), c));
}

void main() {
  vec4 src = texture(u_input, v_texCoord);
  vec3 lin = vec3(clog3ToLin(src.r), clog3ToLin(src.g), clog3ToLin(src.b));
  // Canon Cinema Gamut → Rec.709 (linear, published approximation)
  mat3 M = mat3(
     1.6410, -0.1324, -0.0215,
    -0.4249,  1.2726, -0.1000,
    -0.2161, -0.1402,  1.1215);
  vec3 graded = rec709(M * lin);
  fragColor = vec4(mix(src.rgb, graded, u_intensity), src.a);
}
