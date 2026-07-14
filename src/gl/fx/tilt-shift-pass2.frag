#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_focusY;
uniform float u_focusWidth;
uniform float u_tiltAngle;
uniform float u_blurStrength;
uniform float u_blurSide;
uniform float u_saturation;
uniform float u_vignette;
in vec2 v_texCoord;
out vec4 fragColor;
void main() {
    float aspect = u_resolution.x / u_resolution.y;
    float dx = (v_texCoord.x - 0.5) * aspect;
    float dy = v_texCoord.y - u_focusY;
    float signed_dist = dy * cos(u_tiltAngle) - dx * sin(u_tiltAngle);
    float active_dist = abs(signed_dist);
    if (u_blurSide == 1.0) active_dist = max(0.0, signed_dist);
    else if (u_blurSide == 2.0) active_dist = max(0.0, -signed_dist);
    float maxBlur = u_blurStrength * 4.0;
    float blurAmt = min(maxBlur, max(0.0, active_dist - u_focusWidth * 0.5) * u_blurStrength * 4.0) * 0.7071;
    vec4 color = vec4(0.0);
    if (blurAmt < 0.5) {
        color = texture(u_input, v_texCoord);
    } else {
        float goldenAngle = 2.39996323; float tot = 0.0;
        for(int i = 0; i < 16; i++) {
            float r = sqrt(float(i) + 0.5) / 4.0;
            float theta = float(i) * goldenAngle + 1.570796;
            vec2 offset = vec2(cos(theta), sin(theta)) * r * blurAmt / u_resolution;
            float weight = exp(-r * r * 2.0);
            color += texture(u_input, v_texCoord + offset) * weight;
            tot += weight;
        }
        color /= tot;
    }
    float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    color.rgb = mix(vec3(lum), color.rgb, u_saturation);
    float v_rf = length(v_texCoord - 0.5);
    // Vignette: fade to transparent (scale both rgb and alpha) so the dimmed
    // corners let tracks below show through (pipeline carries premultiplied RGBA).
    float vignAmt = u_vignette * smoothstep(0.2, 0.8, v_rf);
    float vignFactor = mix(1.0, 0.1, vignAmt);
    color *= vignFactor;
    fragColor = color;
}
