#version 300 es
precision highp float;

uniform sampler2D u_input;
uniform float u_intensity;
uniform float u_threshold;
uniform float u_softness;
uniform float u_gamma;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 color = texture(u_input, v_texCoord);
  vec3 rgb = color.rgb;

  // Use max channel instead of luminance — preserves colored edges better
  float maxChan = max(rgb.r, max(rgb.g, rgb.b));

  // Raw alpha calculation with threshold and softness
  float baseAlpha = smoothstep(u_threshold, u_threshold + u_softness, maxChan);
  float alpha = pow(baseAlpha, u_gamma);

  // Edge color decontamination: boost dark-edge pixels to prevent dark fringing
  float edgeMask = 1.0 - smoothstep(0.0, 0.6, alpha);
  vec3 correctedRgb = mix(rgb, rgb / max(maxChan, 0.15) * 0.5, edgeMask);

  // Screen-style intensity boost
  vec3 finalRgb = 1.0 - (1.0 - correctedRgb) * (1.0 - correctedRgb * 0.2 * u_intensity);

  // Clamp and output premultiplied alpha
  fragColor = vec4(clamp(finalRgb, 0.0, 1.0) * alpha, alpha);
}
