#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_time;
uniform float u_strength;
uniform float u_speed;
uniform float u_zoom;
uniform float u_rotation;
uniform float u_breathe;
in vec2 v_texCoord;
out vec4 fragColor;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * noise(p);
    p *= 2.0;
    a *= 0.5;
  }
  return v;
}
void main() {
  float t = u_time * u_speed;
  vec2 pos = v_texCoord - 0.5;
  float shakeX = (fbm(vec2(t, 0.0)) - 0.5) * u_strength * 0.05;
  float shakeY = (fbm(vec2(0.0, t)) - 0.5) * u_strength * 0.05;
  float angle = (fbm(vec2(t * 0.5, t * 0.5)) - 0.5) * u_rotation * 0.1;
  float breath = 1.0 + (sin(t * 0.5) * 0.02 * u_breathe);
  float zoom = u_zoom * breath;
  mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
  vec2 uv = (rot * pos) / zoom + 0.5 + vec2(shakeX, shakeY);
  // Pipeline convention is premultiplied RGBA in FBO textures. Out-of-bounds
  // pixels (when the shake offset pushes UV outside [0,1]) must be transparent
  // so tracks below can show through; opaque black would block them.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
  } else {
    fragColor = texture(u_input, uv);
  }
}
