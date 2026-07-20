#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_aspect;
uniform float u_blurStrength;
uniform float u_chromaticAberration;
uniform float u_contrastLoss;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    float p = u_progress;

    // Asymmetric blur curve: defocus is faster than refocus
    float peak = 0.45;
    float x = (p < peak) ? (p / peak) : ((1.0 - p) / (1.0 - peak));
    float blurAmt = smoothstep(0.0, 1.0, x);

    // Crossfade smoothly during the period of highest blur
    float mixV = smoothstep(0.35, 0.55, p);

    float maxRadius = u_blurStrength * 0.08;
    float radius = blurAmt * maxRadius;

    vec2 dir = v_texCoord - 0.5;

    // Chromatic aberration shifts (red out, blue in)
    vec2 caR = dir * u_chromaticAberration * 0.05 * blurAmt;
    vec2 caB = -dir * u_chromaticAberration * 0.05 * blurAmt;

    vec3 col = vec3(0.0);
    float tot = 0.0;

    if (mixV <= 0.0) {
        for (int i = 0; i < 48; i++) {
            float r = sqrt(float(i) + 0.5) / 6.928203;
            float theta = float(i) * 2.39996323;
            vec2 offset = vec2(cos(theta), sin(theta)) * r * radius;
            offset.y *= u_aspect;
            vec2 uvR = v_texCoord + offset + caR;
            vec2 uvG = v_texCoord + offset;
            vec2 uvB = v_texCoord + offset + caB;
            float valR = texture(u_outgoing, uvR).r;
            float valG = texture(u_outgoing, uvG).g;
            float valB = texture(u_outgoing, uvB).b;
            float weight = 1.0 + r * r * 0.5;
            col += vec3(valR, valG, valB) * weight;
            tot += weight;
        }
    } else if (mixV >= 1.0) {
        for (int i = 0; i < 48; i++) {
            float r = sqrt(float(i) + 0.5) / 6.928203;
            float theta = float(i) * 2.39996323;
            vec2 offset = vec2(cos(theta), sin(theta)) * r * radius;
            offset.y *= u_aspect;
            vec2 uvR = v_texCoord + offset + caR;
            vec2 uvG = v_texCoord + offset;
            vec2 uvB = v_texCoord + offset + caB;
            float valR = texture(u_incoming, uvR).r;
            float valG = texture(u_incoming, uvG).g;
            float valB = texture(u_incoming, uvB).b;
            float weight = 1.0 + r * r * 0.5;
            col += vec3(valR, valG, valB) * weight;
            tot += weight;
        }
    } else {
        for (int i = 0; i < 48; i++) {
            float r = sqrt(float(i) + 0.5) / 6.928203;
            float theta = float(i) * 2.39996323;
            vec2 offset = vec2(cos(theta), sin(theta)) * r * radius;
            offset.y *= u_aspect;
            vec2 uvR = v_texCoord + offset + caR;
            vec2 uvG = v_texCoord + offset;
            vec2 uvB = v_texCoord + offset + caB;
            float valR = mix(texture(u_outgoing, uvR).r, texture(u_incoming, uvR).r, mixV);
            float valG = mix(texture(u_outgoing, uvG).g, texture(u_incoming, uvG).g, mixV);
            float valB = mix(texture(u_outgoing, uvB).b, texture(u_incoming, uvB).b, mixV);
            float weight = 1.0 + r * r * 0.5;
            col += vec3(valR, valG, valB) * weight;
            tot += weight;
        }
    }

    col /= tot;

    // Veiling glare / contrast loss
    vec3 veilingColor = vec3(0.5, 0.48, 0.45);
    col = mix(col, veilingColor, u_contrastLoss * blurAmt * 0.6);

    // Optical vignette tightening
    vec2 physDir = vec2(dir.x, dir.y * u_aspect);
    float dist = length(physDir);
    float vignette = 1.0 - (dist * dist) * 1.5 * blurAmt;
    col *= clamp(vignette, 0.0, 1.0);

    // Slight exposure bump at peak blur
    col *= 1.0 + blurAmt * 0.2;

    fragColor = vec4(col, 1.0);
}
