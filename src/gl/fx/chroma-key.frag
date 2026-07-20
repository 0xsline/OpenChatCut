#version 300 es
precision highp float;

// 色度键 / 绿幕抠像：YCbCr 色度距离键控 + 可调容差/羽化 + 绿色溢色抑制。
uniform sampler2D u_input;
uniform vec3 u_keyColor;    // 抠除的键色，默认纯绿 (0,1,0)
uniform float u_similarity; // 色度距离容差：越大抠除范围越大
uniform float u_smoothness; // 容差边缘的羽化宽度（软过渡，避免锯齿）
uniform float u_spill;      // 保留像素上的键色溢色抑制强度 0..1

in vec2 v_texCoord;
out vec4 fragColor;

// RGB → YCbCr（BT.601），色度键控在 Cb/Cr 平面比较，比直接比 RGB 更抗亮度变化。
vec2 chroma(vec3 rgb) {
  float cb = -0.168736 * rgb.r - 0.331264 * rgb.g + 0.5 * rgb.b;
  float cr = 0.5 * rgb.r - 0.418688 * rgb.g - 0.081312 * rgb.b;
  return vec2(cb, cr);
}

void main() {
  vec4 color = texture(u_input, v_texCoord);
  vec3 rgb = color.rgb;

  vec2 pixelCbCr = chroma(rgb);
  vec2 keyCbCr = chroma(u_keyColor);
  float dist = distance(pixelCbCr, keyCbCr);

  // dist < similarity → 判定为键色，alpha=0；往外 smoothness 宽度内软过渡到不透明
  float alpha = smoothstep(u_similarity, u_similarity + u_smoothness, dist);

  // 溢色抑制：残留在保留像素边缘的键色反光，往「去饱和后的灰」拉一点，
  // 越接近键色（低 dist）拉得越多，由 u_spill 控制强度。
  float spillAmount = (1.0 - smoothstep(u_similarity, u_similarity + u_smoothness * 3.0, dist)) * u_spill;
  float gray = dot(rgb, vec3(0.299, 0.587, 0.114));
  vec3 despilled = mix(rgb, vec3(gray), spillAmount);

  // 输出遵循管线的预乘 alpha 约定
  fragColor = vec4(despilled * alpha, alpha);
}
