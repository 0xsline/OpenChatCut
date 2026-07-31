#version 300 es
precision highp float;

// Local-contrast clarity: estimate mean luminance with a Poisson-disk unsharp sample and adjust midtones by the difference.
// Positive values sharpen; negative values soften. ponytail: one 12-tap pass approximates a large-radius blur.
// Upgrade to a separable two-pass Gaussian blur if the FX registry gains sampler declarations.
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_amount; // -1..1
uniform float u_radius; // Pixels

in vec2 v_texCoord;
out vec4 fragColor;

const vec2 TAPS[12] = vec2[](
  vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696, 0.457),
  vec2(-0.203, 0.621), vec2(0.962, -0.195), vec2(0.473, -0.480),
  vec2(0.519, 0.767), vec2(0.185, -0.893), vec2(0.507, 0.064),
  vec2(0.896, 0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
);

float lumaOf(vec3 rgb) { return dot(rgb, vec3(0.2126, 0.7152, 0.0722)); }

void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec2 px = max(u_radius, 1.0) / max(u_resolution, vec2(1.0));
  float localMean = lumaOf(c.rgb);
  for (int i = 0; i < 12; i++) {
    localMean += lumaOf(texture(u_input, v_texCoord + TAPS[i] * px).rgb);
  }
  localMean /= 13.0;
  float luma = lumaOf(c.rgb);
  float detail = luma - localMean;
  // Weight midtones while protecting the black and white extremes from clipping and amplified noise.
  float midWeight = smoothstep(0.0, 0.25, luma) * (1.0 - smoothstep(0.75, 1.0, luma));
  float boosted = luma + detail * u_amount * 1.6 * midWeight;
  vec3 rgb = c.rgb * (luma > 1e-4 ? boosted / luma : 1.0);
  fragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}
