#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_amount;
uniform float u_angle;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
const int SAMPLES = 12;
void main() {
  vec2 dir = vec2(cos(u_angle), sin(u_angle)) / max(u_resolution, vec2(1.0));
  float a = u_amount * 8.0;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float t = (float(i) / float(SAMPLES - 1) - 0.5) * 2.0;
    acc += texture(u_input, clamp(v_texCoord + dir * a * t, 0.0, 1.0));
  }
  fragColor = acc / float(SAMPLES);
}
