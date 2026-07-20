#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_blurStrength;
uniform vec2 u_center;

in vec2 v_texCoord;
out vec4 fragColor;

const int SAMPLES = 16;

vec4 radialSample(sampler2D tex, vec2 uv, float strength) {
  vec2 dir = uv - u_center;
  vec4 acc = vec4(0.0);
  for (int i = 0; i < SAMPLES; i++) {
    float t = float(i) / float(SAMPLES - 1);
    vec2 p = u_center + dir * (1.0 - strength * t);
    acc += texture(tex, clamp(p, 0.0, 1.0));
  }
  return acc / float(SAMPLES);
}

void main() {
  float p = smoothstep(0.0, 1.0, u_progress);
  float blur = u_blurStrength * sin(p * 3.14159265);
  // outgoing zooms out / blurs, incoming zooms in
  float outScale = 1.0 + p * 0.35;
  float inScale = 1.0 + (1.0 - p) * 0.35;
  vec2 outUv = u_center + (v_texCoord - u_center) * outScale;
  vec2 inUv = u_center + (v_texCoord - u_center) * inScale;
  vec4 a = radialSample(u_outgoing, outUv, blur);
  vec4 b = radialSample(u_incoming, inUv, blur);
  fragColor = mix(a, b, p);
}
