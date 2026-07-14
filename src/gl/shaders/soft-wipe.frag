#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_feather;
uniform float u_parallax;

in vec2 v_texCoord;
out vec4 fragColor;

float easeInOutCubic(float t) {
    return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
}

void main() {
    float p = easeInOutCubic(u_progress);

    float f = max(u_feather, 0.001);
    float wipePos = p * (1.0 + f) - f;

    float edge0 = wipePos;
    float edge1 = wipePos + f;

    float mixVal = smoothstep(edge0, edge1, v_texCoord.x);

    vec2 uvOut = v_texCoord - vec2(p * u_parallax, 0.0);
    vec2 uvIn = v_texCoord + vec2((1.0 - p) * u_parallax, 0.0);

    vec4 colorOut = texture(u_outgoing, uvOut);
    vec4 colorIn = texture(u_incoming, uvIn);

    float shadow = 1.0 - (sin(mixVal * 3.14159265) * 0.15);

    fragColor = mix(colorIn, colorOut, mixVal);
    fragColor.rgb *= shadow;
}
