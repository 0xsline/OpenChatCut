export interface TransitionSourceOpacity {
  outgoing: number;
  incoming: number;
}

export const SOURCE_OPACITY_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform float u_opacity;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
  vec4 color = texture(u_input, v_texCoord);
  fragColor = vec4(color.rgb, min(color.a, u_opacity));
}`;
