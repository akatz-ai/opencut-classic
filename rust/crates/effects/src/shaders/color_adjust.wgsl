struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) tex_coord: vec2f,
}

struct EffectUniforms {
    resolution: vec2f,
    direction: vec2f,
    scalars: vec4f,
}

@group(0) @binding(0) var input_texture: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(1) @binding(0) var<uniform> uniforms: EffectUniforms;

fn to_linear(c: vec3f) -> vec3f {
    return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
}

fn to_srgb(c: vec3f) -> vec3f {
    return select(1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055,
        c * 12.92, c <= vec3f(0.0031308));
}

@fragment
fn fragment_main(input: VertexOutput) -> @location(0) vec4f {
    let source = textureSample(input_texture, input_sampler, input.tex_coord);
    // Textures are straight-alpha SDR. Leave coverage unchanged, including cutout edges.
    if (all(uniforms.scalars == vec4f(0.0, 0.0, 1.0, 0.0)) && uniforms.direction.x == 0.0) {
        return source;
    }
    var color = to_linear(source.rgb) * exp2(uniforms.scalars.x);
    // Creative warm/cool and green/magenta balance, not calibrated Kelvin or HDR grading.
    let temperature = uniforms.scalars.w;
    let tint = uniforms.direction.x;
    color *= exp2(vec3f(temperature * 0.5 + tint * 0.25, -tint * 0.5, -temperature * 0.5 + tint * 0.25));
    let luma = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    color = mix(vec3f(luma), color, uniforms.scalars.z);
    color = to_srgb(max(color, vec3f(0.0)));
    color = (color - 0.5) * exp2(uniforms.scalars.y * 2.0) + 0.5;
    return vec4f(clamp(color, vec3f(0.0), vec3f(1.0)), source.a);
}
