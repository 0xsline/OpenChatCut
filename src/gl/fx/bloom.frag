#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_threshold;
uniform float u_intensity;
uniform float u_radius;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 base = texture(u_input, v_texCoord);
  vec2 px = u_radius / max(u_resolution, vec2(1.0));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float w = exp(-0.5 * float(x * x + y * y));
      vec3 s = texture(u_input, v_texCoord + vec2(float(x), float(y)) * px).rgb;
      float lum = dot(s, vec3(0.299, 0.587, 0.114));
      float m = smoothstep(u_threshold, u_threshold + 0.2, lum);
      acc += s * m * w;
      wsum += w;
    }
  }
  vec3 bloom = acc / max(wsum, 0.001);
  fragColor = vec4(clamp(base.rgb + bloom * u_intensity, 0.0, 1.0), base.a);
}
