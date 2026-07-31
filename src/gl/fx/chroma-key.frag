#version 300 es
precision highp float;

// Chroma key / green-screen removal using YCbCr distance, adjustable tolerance/feathering, and spill suppression.
uniform sampler2D u_input;
uniform vec3 u_keyColor;    // Key color to remove; defaults to pure green (0,1,0)
uniform float u_similarity; // Chroma-distance tolerance; larger values remove a wider range
uniform float u_smoothness; // Feather width at the tolerance edge for a smooth, anti-aliased transition
uniform float u_spill;      // Key-color spill suppression on retained pixels, from 0 to 1

in vec2 v_texCoord;
out vec4 fragColor;

// Convert RGB to YCbCr (BT.601). Comparing Cb/Cr resists luminance changes better than direct RGB distance.
vec2 chroma(vec3 rgb) {
  float cb = -0.168736 * rgb.r - 0.331264 * rgb.g + 0.5 * rgb.b;
  float cr = 0.5 * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b;
  return vec2(cb, cr);
}

void main() {
  vec4 color = texture(u_input, v_texCoord);
  vec3 rgb = color.rgb;

  vec2 pixelCbCr = chroma(rgb);
  vec2 keyCbCr = chroma(u_keyColor);
  float dist = distance(pixelCbCr, keyCbCr);

  // Treat dist < similarity as the key color, then feather alpha to opaque across the smoothness width.
  float alpha = smoothstep(u_similarity, u_similarity + u_smoothness, dist);

  // Suppress reflected key color around retained edges by pulling it toward desaturated gray.
  // Pixels closer to the key color receive more correction, scaled by u_spill.
  float spillAmount = (1.0 - smoothstep(u_similarity, u_similarity + u_smoothness * 3.0, dist)) * u_spill;
  float gray = dot(rgb, vec3(0.299, 0.587, 0.114));
  vec3 despilled = mix(rgb, vec3(gray), spillAmount);

  // Follow the pipeline's premultiplied-alpha convention.
  fragColor = vec4(despilled * alpha, alpha);
}
