#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_dotSize;
uniform float u_contrast;
uniform float u_intensity;
uniform vec2 u_resolution;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_input, v_texCoord);
  float g = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  g = clamp((g - 0.5) * u_contrast + 0.5, 0.0, 1.0);
  float cell = max(u_dotSize, 2.0);
  vec2 px = v_texCoord * u_resolution;
  vec2 cellUv = mod(px, cell) - cell * 0.5;
  float dist = length(cellUv);
  float radius = (1.0 - g) * cell * 0.45;
  float dotMask = 1.0 - smoothstep(radius - 0.8, radius + 0.8, dist);
  vec3 halfTone = mix(vec3(1.0), vec3(0.05), dotMask);
  fragColor = vec4(mix(c.rgb, halfTone, clamp(u_intensity, 0.0, 1.0)), c.a);
}
