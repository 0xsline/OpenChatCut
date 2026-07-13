#version 300 es
precision highp float;

uniform sampler2D u_outgoing;
uniform sampler2D u_incoming;
uniform float u_progress;
uniform float u_aspect;
uniform float u_radius;
uniform vec3 u_paperTint;
uniform float u_glossiness;

in vec2 v_texCoord;
out vec4 fragColor;

#define PI 3.14159265359

// Hash function for procedural noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// Value noise for paper grain
float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
}

void main() {
    // Smooth easeInOut for organic flip motion
    float p = u_progress < 0.5
        ? 2.0 * u_progress * u_progress
        : 1.0 - pow(-2.0 * u_progress + 2.0, 2.0) / 2.0;

    vec2 uv = v_texCoord;
    vec2 aspect_uv = vec2(uv.x * u_aspect, uv.y);

    // Fixed angle for a cinematic right-to-left downward flip
    float angle_rad = 15.0 * PI / 180.0;
    vec2 dir = normalize(vec2(-cos(angle_rad), sin(angle_rad)));

    // Calculate bounds to ensure shadows clear the screen
    vec2 c00 = vec2(0.0, 0.0);
    vec2 c10 = vec2(u_aspect, 0.0);
    vec2 c01 = vec2(0.0, 1.0);
    vec2 c11 = vec2(u_aspect, 1.0);

    float d00 = dot(c00, dir);
    float d10 = dot(c10, dir);
    float d01 = dot(c01, dir);
    float d11 = dot(c11, dir);

    float min_d = min(min(d00, d10), min(d01, d11));
    float max_d = max(max(d00, d10), max(d01, d11));

    // Drive the fold position across the screen
    float fold_pos = mix(min_d - u_radius * 2.5, max_d + u_radius * 2.5, p);

    // Distance of current pixel to the fold line
    float d = dot(aspect_uv, dir) - fold_pos;

    vec4 color = texture(u_incoming, uv);

    if (d > u_radius) {
        // Right of fold: flat outgoing page
        color = texture(u_outgoing, uv);

        // Soft shadow cast by the lifted page
        float shadow_out = smoothstep(u_radius, u_radius * 2.5, d);
        color.rgb *= mix(0.75, 1.0, shadow_out);

    } else if (d > 0.0) {
        // Under the curl cylinder
        float ratio = clamp(d / u_radius, 0.0, 1.0);
        float normal_z = sqrt(max(0.0, 1.0 - ratio * ratio));

        // Layer 1: Flat page at the bottom
        vec4 flat_color = texture(u_outgoing, uv);
        float ao = mix(0.25, 1.0, ratio); // Ambient occlusion near crease
        flat_color.rgb *= ao;

        // Layer 2: Bottom of curl (outgoing video bending up)
        float theta_bottom = asin(ratio);
        float L_bottom = u_radius * theta_bottom;
        vec2 aspect_uv_bottom = aspect_uv - dir * (d + L_bottom);
        vec2 uv_bottom = vec2(aspect_uv_bottom.x / u_aspect, aspect_uv_bottom.y);

        vec4 bottom_color = texture(u_outgoing, uv_bottom);

        // Cylinder normal and lighting vector for specular
        vec3 N = vec3(-ratio, 0.0, normal_z);
        vec3 L = normalize(vec3(-0.6, 0.3, 0.7));
        float ndotl = max(0.0, dot(N, L));

        float diffuse = mix(0.7, 1.1, normal_z);
        bottom_color.rgb *= diffuse;

        // Sharp glossy specular highlight
        float specular = pow(ndotl, 64.0) * u_glossiness * 1.5;
        bottom_color.rgb += specular;

        // Edge masking and thickness rim for bottom curl
        float edge_dist_b = min(min(uv_bottom.x, 1.0 - uv_bottom.x), min(uv_bottom.y, 1.0 - uv_bottom.y));
        float fw_b = max(fwidth(edge_dist_b), 0.001);
        float bottom_alpha = smoothstep(-fw_b, fw_b, edge_dist_b);

        float thickness = 0.004;
        float is_edge_b = 1.0 - smoothstep(thickness - fw_b, thickness + fw_b, edge_dist_b);
        bottom_color.rgb = mix(bottom_color.rgb, u_paperTint, is_edge_b);

        // Layer 3: Top of curl (back of the page folding over)
        float theta_top = PI - asin(ratio);
        float L_top = u_radius * theta_top;
        vec2 aspect_uv_top = aspect_uv - dir * (d + L_top);
        vec2 uv_top = vec2(aspect_uv_top.x / u_aspect, aspect_uv_top.y);

        // Procedural paper fiber texture
        float grain = noise(uv_top * 300.0) * 0.06 + noise(uv_top * 900.0) * 0.04;
        vec3 top_color_rgb = u_paperTint * (1.0 - grain);

        // Darken as it curves back down
        top_color_rgb *= mix(0.9, 0.5, normal_z);
        vec4 top_color = vec4(top_color_rgb, 1.0);

        // Edge masking and thickness rim for top curl
        float edge_dist_t = min(min(uv_top.x, 1.0 - uv_top.x), min(uv_top.y, 1.0 - uv_top.y));
        float fw_t = max(fwidth(edge_dist_t), 0.001);
        float top_alpha = smoothstep(-fw_t, fw_t, edge_dist_t);

        float is_edge_t = 1.0 - smoothstep(thickness - fw_t, thickness + fw_t, edge_dist_t);
        top_color.rgb = mix(top_color.rgb, u_paperTint * 1.1, is_edge_t); // slight highlight on paper edge

        // Composite layers back-to-front
        color = flat_color;
        if (edge_dist_b > -fw_b) color = mix(color, bottom_color, bottom_alpha);
        if (edge_dist_t > -fw_t) color = mix(color, top_color, top_alpha);

    } else {
        // Left of fold: revealed incoming video
        float dist = -d;

        // Multi-layer shadow onto the incoming clip
        float contact_shadow = smoothstep(u_radius * 0.4, 0.0, dist);
        float diffuse_shadow = smoothstep(u_radius * 3.0, 0.0, dist);

        float combined_shadow = mix(1.0, 0.2, contact_shadow * 0.75 + diffuse_shadow * 0.5);
        color.rgb *= combined_shadow;
    }

    fragColor = color;
}
