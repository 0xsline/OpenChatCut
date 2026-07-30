#version 300 es
precision highp float;

// 三路色轮(lift/gamma/gain):暗部偏移、中间调幂次、亮部增益,均以 0.5 灰为中性。
// out = pow(clamp(in * gain + lift), gamma) 逐通道;intensity 干湿混合。
uniform sampler2D u_input;
uniform vec3 u_liftColor;   // 0.5 中性;偏离方向 = 暗部染色方向
uniform vec3 u_gammaColor;  // 0.5 中性;>0.5 提亮中间调该通道
uniform vec3 u_gainColor;   // 0.5 中性;>0.5 增益亮部该通道
uniform float u_intensity;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
  vec4 c = texture(u_input, v_texCoord);
  vec3 lift = (u_liftColor - 0.5) * 0.5;            // -0.25 .. +0.25
  vec3 gain = 0.25 + u_gainColor * 1.5;             // 0.25 .. 1.75, 0.5 -> 1
  vec3 gamma = exp2((0.5 - u_gammaColor) * 2.0);    // 0.5 -> 1;低于 0.5 压暗中间调
  vec3 graded = pow(clamp(c.rgb * gain + lift, 0.0, 1.0), gamma);
  fragColor = vec4(mix(c.rgb, graded, clamp(u_intensity, 0.0, 1.0)), c.a);
}
