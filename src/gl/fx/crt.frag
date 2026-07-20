#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_scanlineIntensity;
uniform float u_curvature;
uniform float u_noiseAmount;
uniform float u_rgbShift;
uniform float u_brightness;
uniform float u_time;
in vec2 v_texCoord;
out vec4 fragColor;
vec2 distort(vec2 uv) {
  uv -= 0.5;
  float d = dot(uv, uv);
  uv *= 1.0 + u_curvature * d;
  uv += 0.5;
  return uv;
}
float rand(vec2 co) {
  return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
}
void main() {
  vec2 uv = distort(v_texCoord);
  // Pipeline convention: FBO textures carry premultiplied RGBA. Curved-screen
  // distortion outside [0,1] and vignette corners must fade to transparent,
  // not opaque black, otherwise track-composite output blocks tracks below.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0);
    return;
  }
  float wobble = sin(uv.y * 50.0 + u_time * 5.0) * 0.001;
  vec2 uvShift = vec2(wobble, 0.0);
  float r = texture(u_input, uv + uvShift + vec2(u_rgbShift, 0.0)).r;
  float g = texture(u_input, uv + uvShift).g;
  float b = texture(u_input, uv + uvShift - vec2(u_rgbShift, 0.0)).b;
  // Carry source alpha so an opaque video stays opaque while an empty
  // (transparent) area of the scene framebuffer stays transparent.
  float srcAlpha = texture(u_input, uv + uvShift).a;
  vec3 col = vec3(r, g, b) * u_brightness;
  float scan = sin(uv.y * 800.0) * 0.5 + 0.5;
  col -= scan * u_scanlineIntensity;
  float noise = (rand(uv + fract(u_time)) - 0.5) * u_noiseAmount;
  col += noise;
  float vignette = 1.0 - length(v_texCoord - 0.5) * 1.2;
  float vignFactor = smoothstep(0.0, 0.2, vignette);
  col *= vignFactor;
  // Scale alpha by the same vignette factor so the corners fade to
  // transparent rather than to opaque black, preserving the premultiplied
  // invariant (rgb stays ≤ alpha for an opaque source).
  fragColor = vec4(col, srcAlpha * vignFactor);
}
