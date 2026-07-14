#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;

uniform float u_intensity;
uniform float u_additiveAmount;
uniform float u_threshold;

in vec2 v_texCoord;
out vec4 fragColor;

const float PI = 3.14159265359;

float luminance(vec3 color) {
    return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

void main() {
    float p = smoothstep(0.0, 1.0, u_progress);

    vec4 cOut = texture(u_outgoing, v_texCoord);
    vec4 cIn = texture(u_incoming, v_texCoord);

    float lumaOut = luminance(cOut.rgb);
    float lumaIn = luminance(cIn.rgb);

    float curve = sin(p * PI);

    float maskOut = smoothstep(u_threshold, 1.0, lumaOut);
    float maskIn = smoothstep(u_threshold, 1.0, lumaIn);

    float boostOut = 1.0 + maskOut * u_intensity * curve;
    float boostIn = 1.0 + maskIn * u_intensity * curve;

    vec3 modOut = cOut.rgb * (1.0 - p) * boostOut;
    vec3 modIn = cIn.rgb * p * boostIn;

    vec3 screenBlend = 1.0 - (1.0 - clamp(modOut, 0.0, 1.0)) * (1.0 - clamp(modIn, 0.0, 1.0));
    vec3 addBlend = clamp(modOut + modIn, 0.0, 1.0);

    vec3 finalColor = mix(screenBlend, addBlend, u_additiveAmount);

    float finalAlpha = clamp(cOut.a * (1.0 - p) + cIn.a * p, 0.0, 1.0);

    fragColor = vec4(finalColor, finalAlpha);
}
