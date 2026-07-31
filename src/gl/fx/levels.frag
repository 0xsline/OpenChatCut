#version 300 es
precision highp float;

// Per-channel levels: remap input black/white points, apply midtone gamma, then map output black/white points.
uniform sampler2D u_input;
uniform float u_inBlack;
uniform float u_inWhite;
uniform float u_gamma;
uniform float u_outBlack;
uniform float u_outWhite;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 v = clamp((c.rgb - u_inBlack) / max(u_inWhite - u_inBlack, 1e-4), 0.0, 1.0);
  v = pow(v, vec3(1.0 / max(u_gamma, 0.05)));
  v = u_outBlack + v * (u_outWhite - u_outBlack);
  fragColor = vec4(clamp(v, 0.0, 1.0), c.a);
}
