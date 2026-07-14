#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;

uniform vec2 u_dir;
uniform float u_blurStrength;
uniform float u_bounceback;

in vec2 v_texCoord;
out vec4 fragColor;

const int SAMPLES = 32;

vec4 getScene(vec2 uv, float offset) {
    vec2 tapeUV = uv + u_dir * offset;
    vec2 uvA = tapeUV;
    vec2 uvB = tapeUV - u_dir;

    vec4 cA = texture(u_outgoing, uvA);
    vec4 cB = texture(u_incoming, uvB);

    float mask = 0.0;
    if (u_dir.x > 0.5) mask = smoothstep(0.99, 1.01, tapeUV.x);
    else if (u_dir.x < -0.5) mask = smoothstep(0.01, -0.01, tapeUV.x);
    else if (u_dir.y > 0.5) mask = smoothstep(0.99, 1.01, tapeUV.y);
    else if (u_dir.y < -0.5) mask = smoothstep(0.01, -0.01, tapeUV.y);

    return mix(cA, cB, mask);
}

float ease(float t, float bounce) {
    if (t < 0.5) {
        return 4.0 * t * t * t;
    } else {
        float f = (t - 1.0) * 2.0;
        float b = bounce * 5.0;
        return 1.0 + 0.5 * (f * f * ((b + 1.0) * f + b));
    }
}

void main() {
    float offset = ease(u_progress, u_bounceback);

    float offsetNext = ease(clamp(u_progress + 0.01, 0.0, 1.0), u_bounceback);
    float offsetPrev = ease(clamp(u_progress - 0.01, 0.0, 1.0), u_bounceback);
    float velocity = (offsetNext - offsetPrev) / 0.02;

    float jitter = fract(sin(dot(v_texCoord, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;

    vec4 color = vec4(0.0);
    float blurLength = velocity * u_blurStrength;

    for (int i = 0; i < SAMPLES; i++) {
        float f = (float(i) + jitter + 0.5) / float(SAMPLES);
        float sampleOffset = offset + blurLength * (f - 0.5);
        color += getScene(v_texCoord, sampleOffset);
    }

    fragColor = color / float(SAMPLES);
}
