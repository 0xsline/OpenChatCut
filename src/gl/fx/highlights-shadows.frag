#version 300 es
precision highp float;

// Highlights/shadows: soft luminance masks lift shadows toward white while protecting highlights, and adjust highlights separately.
uniform sampler2D u_input;
uniform float u_shadows;        // -1..1; positive values lift shadows
uniform float u_highlights;     // -1..1; negative values recover highlights
uniform float u_shadowRange;    // Upper luminance bound of the shadow mask
uniform float u_highlightRange; // Highlight-mask width

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 c = texture(u_input, v_texCoord);
  float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  float shadowMask = 1.0 - smoothstep(0.0, max(u_shadowRange, 0.05), luma);
  float highlightMask = smoothstep(1.0 - max(u_highlightRange, 0.05), 1.0, luma);
  vec3 rgb = c.rgb;
  rgb += u_shadows * shadowMask * 0.45 * (1.0 - rgb);
  rgb *= 1.0 + u_highlights * highlightMask * 0.6;
  fragColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}
