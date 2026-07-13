#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_ratio;
uniform float u_time;
uniform vec3 u_glowColor;
uniform float u_glowWidth;
uniform float u_depth;

in vec2 v_texCoord;
out vec4 fragColor;

vec2 hash2(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
}

float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

    float a = dot(hash2(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0));
    float b = dot(hash2(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
    float c = dot(hash2(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
    float d = dot(hash2(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p, float time) {
    float val = 0.0;
    float amp = 1.0;
    float freq = 1.0;
    for (int i = 0; i < 2; i++) {
        val += amp * gradientNoise(p * freq + time * 0.03);
        amp *= 0.5;
        freq *= 2.0;
    }
    return val;
}

void main() {
    float p = u_progress;
    float pr = smoothstep(0.0, 1.0, p);

    vec2 uv = v_texCoord;
    vec2 pos = uv * 2.0 - 1.0;
    pos.x *= u_ratio;

    float dist = length(pos);

    float n = fbm(pos * 0.8, u_time * 0.1);
    float shape = dist - n * u_depth;

    float maxDist = length(vec2(u_ratio, 1.0));
    float T = mix(-u_depth * 0.5, maxDist + u_depth * 0.8, pr);

    float edgeSoftness = 0.02;
    float inside = smoothstep(T + edgeSoftness, T - edgeSoftness, shape);

    float glowDist = abs(shape - T);
    float glow = smoothstep(u_glowWidth, 0.0, glowDist);
    glow = pow(glow, 1.6);

    vec4 colorOut = texture(u_outgoing, uv);
    vec4 colorIn = texture(u_incoming, uv);
    vec4 baseColor = mix(colorOut, colorIn, inside);

    float burn = smoothstep(u_glowWidth * 4.0, 0.0, shape - T);
    if (shape > T) {
        baseColor.rgb = mix(baseColor.rgb, vec3(0.0), burn * 0.4);
    }

    vec3 finalColor = baseColor.rgb + u_glowColor * glow * 2.5;

    fragColor = vec4(finalColor, 1.0);
}
