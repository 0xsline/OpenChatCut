#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;

uniform vec3 u_flashColor;
uniform float u_flashHold;
uniform float u_overexposure;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    float holdHalf = u_flashHold * 0.5;
    float holdStart = 0.5 - holdHalf;
    float holdEnd = 0.5 + holdHalf;

    float attack = smoothstep(0.0, holdStart, u_progress);
    float decay = 1.0 - smoothstep(holdEnd, 1.0, u_progress);

    float flashBase = min(attack, decay);
    float flashAmount = smoothstep(0.0, 1.0, flashBase);

    float texMix = step(0.5, u_progress);
    vec4 colorOut = texture(u_outgoing, v_texCoord);
    vec4 colorIn = texture(u_incoming, v_texCoord);
    vec4 baseColor = mix(colorOut, colorIn, texMix);

    vec3 exposed = baseColor.rgb * (1.0 + flashAmount * u_overexposure);
    vec3 finalColor = mix(exposed, u_flashColor, flashAmount);

    fragColor = vec4(finalColor, 1.0);
}
