#version 300 es
precision highp float;

// HSL 定向二级校色:按色相圆环选中一段(中心±宽度,外加羽化),只对选区内
// 像素做色相旋转/饱和度/明度调整;低饱和像素按饱和度淡出避免灰面误染。
uniform sampler2D u_input;
uniform float u_hueCenter;  // 0..360
uniform float u_hueWidth;   // 选区半宽(度)
uniform float u_softness;   // 羽化宽度(度)
uniform float u_hueShift;   // -60..60 度
uniform float u_satMul;     // 0..2
uniform float u_lumaMul;    // 0.5..1.5

in vec2 v_texCoord;
out vec4 fragColor;

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 hsv = rgb2hsv(c.rgb);
  float hueDeg = hsv.x * 360.0;
  float dist = abs(hueDeg - u_hueCenter);
  dist = min(dist, 360.0 - dist); // 圆环距离
  float mask = 1.0 - smoothstep(u_hueWidth, u_hueWidth + max(u_softness, 0.5), dist);
  mask *= smoothstep(0.04, 0.18, hsv.y); // 灰面淡出
  vec3 adjusted = hsv;
  adjusted.x = fract((hueDeg + u_hueShift) / 360.0 + 1.0);
  adjusted.y = clamp(hsv.y * u_satMul, 0.0, 1.0);
  adjusted.z = clamp(hsv.z * u_lumaMul, 0.0, 1.0);
  vec3 outRgb = mix(c.rgb, hsv2rgb(adjusted), mask);
  fragColor = vec4(outRgb, c.a);
}
