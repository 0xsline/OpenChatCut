#version 300 es
precision highp float;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_focusY;
uniform float u_focusWidth;
uniform float u_tiltAngle;
uniform float u_blurStrength;
uniform float u_blurSide;
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
    if (blurAmt < 0.5) { fragColor = texture(u_input, v_texCoord); return; }
    float goldenAngle = 2.39996323;
    vec4 color = vec4(0.0); float tot = 0.0;
    for(int i = 0; i < 16; i++) {
        float r = sqrt(float(i) + 0.5) / 4.0;
        float theta = float(i) * goldenAngle;
        vec2 offset = vec2(cos(theta), sin(theta)) * r * blurAmt / u_resolution;
        float weight = exp(-r * r * 2.0);
        color += texture(u_input, v_texCoord + offset) * weight;
        tot += weight;
    }
    fragColor = color / tot;
}
