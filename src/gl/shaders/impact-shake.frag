#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;

uniform float u_shakeIntensity;
uniform float u_zoomPunch;
uniform float u_chromaticAmount;

in vec2 v_texCoord;
out vec4 fragColor;

float hash(float n) {
  return fract(sin(n) * 43758.5453123);
}

float noise(float p) {
  float fl = floor(p);
  float fc = fract(p);
  float u = fc * fc * (3.0 - 2.0 * fc);
  return mix(hash(fl), hash(fl + 1.0), u);
}

vec3 sampleWithChromaticAberration(sampler2D tex, vec2 uv, float amount) {
  vec2 dir = uv - 0.5;
  float dist = length(dir);
  if (dist > 0.0) {
      dir /= dist;
  }

  vec2 offsetAmount = dir * amount * dist * 2.0;

  float r = texture(tex, uv + offsetAmount).r;
  float g = texture(tex, uv).g;
  float b = texture(tex, uv - offsetAmount).b;

  return vec3(r, g, b);
}

void main() {
  float distToCut = abs(u_progress - 0.5) * 2.0;
  float intensity = pow(1.0 - distToCut, 3.0);

  float scale = 1.0 + (u_zoomPunch - 1.0) * intensity;

  float t = u_progress * 80.0;
  vec2 shakeOffset = vec2(
    noise(t) * 2.0 - 1.0,
    noise(t + 42.0) * 2.0 - 1.0
  ) * u_shakeIntensity * intensity;

  vec2 uv = (v_texCoord - 0.5) / scale + 0.5 + shakeOffset;

  vec3 color;
  float currentChrom = u_chromaticAmount * intensity;

  if (u_progress >= 0.5) {
    color = sampleWithChromaticAberration(u_incoming, uv, currentChrom);
  } else {
    color = sampleWithChromaticAberration(u_outgoing, uv, currentChrom);
  }

  float flash = pow(intensity, 8.0) * 0.4;
  color += vec3(flash);

  fragColor = vec4(color, 1.0);
}
