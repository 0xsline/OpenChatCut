#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;

uniform float u_windupAmount;
uniform float u_zoomAmount;
uniform float u_incomingStartScale;

in vec2 v_texCoord;
out vec4 fragColor;

#define PI 3.14159265359

vec4 getOutgoing(vec2 uv, float stretch) {
    vec4 col = vec4(0.0);
    const int SAMPLES = 16;
    for(int i = 0; i < SAMPLES; i++) {
        float f = float(i) / float(SAMPLES - 1);
        float s = 1.0 + stretch * f;
        vec2 suv = (uv - 0.5) / s + 0.5;
        col += texture(u_outgoing, suv);
    }
    return col / float(SAMPLES);
}

void main() {
    float p = u_progress;

    float windup = p < 0.3 ? sin(p * PI / 0.3) : 0.0;
    float punch = p >= 0.3 ? pow((p - 0.3) / 0.7, 3.0) : 0.0;

    float scaleOut = 1.0 - (windup * u_windupAmount) + (punch * u_zoomAmount);
    float stretch = punch * 2.0;

    vec2 uvOut = (v_texCoord - 0.5) / scaleOut + 0.5;
    vec4 colorOut = getOutgoing(uvOut, stretch);

    float outAlpha = 1.0 - smoothstep(0.4, 0.85, p);

    float easeOut = 1.0 - pow(1.0 - p, 4.0);
    float scaleIn = mix(u_incomingStartScale, 1.0, easeOut);

    vec2 uvIn = (v_texCoord - 0.5) / scaleIn + 0.5;
    vec4 colorIn = texture(u_incoming, uvIn);

    fragColor = mix(colorIn, colorOut, outAlpha);
}
