#version 300 es
precision highp float;

// Three-way color wheels (lift/gamma/gain): shadow offset, midtone exponent, and highlight gain; 0.5 gray is neutral.
// Apply out = pow(clamp(in * gain + lift), gamma) per channel, then use intensity for dry/wet blending.
uniform sampler2D u_input;
uniform vec3 u_liftColor;   // 0.5 is neutral; deviation sets the shadow tint direction
uniform vec3 u_gammaColor;  // 0.5 is neutral; values above 0.5 brighten that midtone channel
uniform vec3 u_gainColor;   // 0.5 is neutral; values above 0.5 boost that highlight channel
uniform float u_intensity;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 lift = (u_liftColor - 0.5) * 0.5;            // -0.25 .. +0.25
  vec3 gain = 0.25 + u_gainColor * 1.5;             // 0.25 .. 1.75, 0.5 -> 1
  vec3 gamma = exp2((0.5 - u_gammaColor) * 2.0);    // 0.5 maps to 1; lower values darken midtones
  vec3 graded = pow(clamp(c.rgb * gain + lift, 0.0, 1.0), gamma);
  fragColor = vec4(mix(c.rgb, graded, clamp(u_intensity, 0.0, 1.0)), c.a);
}
