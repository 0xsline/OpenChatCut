#version 300 es
precision highp float;
uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_lineWidth;
uniform vec3 u_lineColor;
in vec2 v_texCoord;
out vec4 fragColor;
// Custom bezier-like easing: slow start, fast middle, slow end with overshoot feel
float customEase(float t) {
    // Approximate cubic-bezier(0.7, 0, 0.3, 1) - fast in the middle
    float t2 = t * t;
    float t3 = t2 * t;
    // Hermite interpolation with strong acceleration in center
    return t3 * (10.0 - 15.0 * t + 6.0 * t2);
}
void main() {
    float p = customEase(u_progress);
    // Line position sweeps across the screen
    float pos = p * (1.0 + u_lineWidth * 2.0) - u_lineWidth;
    vec4 cOut = texture(u_outgoing, v_texCoord);
    vec4 cIn  = texture(u_incoming, v_texCoord);
    // Clean wipe split
    vec4 baseColor = mix(cIn, cOut, step(pos, v_texCoord.x));
    // Thin white line at the wipe edge
    float dist = abs(v_texCoord.x - pos);
    float line = smoothstep(u_lineWidth, u_lineWidth * 0.3, dist);
    vec3 finalColor = mix(baseColor.rgb, u_lineColor, line);
    fragColor = vec4(finalColor, 1.0);
}
