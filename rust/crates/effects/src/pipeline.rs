use std::collections::HashMap;

use bytemuck::{Pod, Zeroable};
use gpu::{FULLSCREEN_SHADER_SOURCE, GpuContext};
use thiserror::Error;
use wgpu::util::DeviceExt;

use crate::{EffectPass, UniformValue};

const GAUSSIAN_BLUR_SHADER_ID: &str = "gaussian-blur";
const GAUSSIAN_BLUR_SHADER_SOURCE: &str = include_str!("shaders/gaussian_blur.wgsl");
const COLOR_ADJUST_SHADER_ID: &str = "color-adjust";
const COLOR_ADJUST_SHADER_SOURCE: &str = include_str!("shaders/color_adjust.wgsl");

pub struct ApplyEffectsOptions<'a> {
    pub source: &'a wgpu::Texture,
    pub width: u32,
    pub height: u32,
    pub passes: &'a [EffectPass],
}

pub struct EffectPipeline {
    uniform_bind_group_layout: wgpu::BindGroupLayout,
    pipelines: HashMap<String, wgpu::RenderPipeline>,
}

#[derive(Debug, Error)]
pub enum EffectsError {
    #[error("At least one effect pass is required")]
    MissingEffectPasses,
    #[error("Unknown effect shader '{shader}'")]
    UnknownEffectShader { shader: String },
    #[error("Missing uniform '{uniform}' for shader '{shader}'")]
    MissingUniform { shader: String, uniform: String },
    #[error("Uniform '{uniform}' for shader '{shader}' must be a number")]
    InvalidNumberUniform { shader: String, uniform: String },
    #[error(
        "Uniform '{uniform}' for shader '{shader}' must be a vector of length {expected_length}"
    )]
    InvalidVectorUniform {
        shader: String,
        uniform: String,
        expected_length: usize,
    },
    #[error("Shader '{shader}' does not support uniform '{uniform}'")]
    UnsupportedUniform { shader: String, uniform: String },
}

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct EffectUniformBuffer {
    resolution: [f32; 2],
    direction: [f32; 2],
    scalars: [f32; 4],
}

impl EffectPipeline {
    pub fn new(context: &GpuContext) -> Self {
        let uniform_bind_group_layout =
            context
                .device()
                .create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                    label: Some("effects-uniform-bind-group-layout"),
                    entries: &[wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    }],
                });
        let vertex_shader_module =
            context
                .device()
                .create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: Some("effects-fullscreen-shader"),
                    source: wgpu::ShaderSource::Wgsl(FULLSCREEN_SHADER_SOURCE.into()),
                });
        let mut pipelines = HashMap::new();
        for (shader_id, shader_source) in [
            (GAUSSIAN_BLUR_SHADER_ID, GAUSSIAN_BLUR_SHADER_SOURCE),
            (COLOR_ADJUST_SHADER_ID, COLOR_ADJUST_SHADER_SOURCE),
        ] {
            let shader_module =
                context
                    .device()
                    .create_shader_module(wgpu::ShaderModuleDescriptor {
                        label: Some(shader_id),
                        source: wgpu::ShaderSource::Wgsl(shader_source.into()),
                    });
            let pipeline_layout =
                context
                    .device()
                    .create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                        label: Some("effects-pipeline-layout"),
                        bind_group_layouts: &[
                            Some(context.texture_sampler_bind_group_layout()),
                            Some(&uniform_bind_group_layout),
                        ],
                        immediate_size: 0,
                    });
            let pipeline =
                context
                    .device()
                    .create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                        label: Some(shader_id),
                        layout: Some(&pipeline_layout),
                        vertex: wgpu::VertexState {
                            module: &vertex_shader_module,
                            entry_point: Some("vertex_main"),
                            buffers: &[wgpu::VertexBufferLayout {
                                array_stride: std::mem::size_of::<[f32; 2]>() as u64,
                                step_mode: wgpu::VertexStepMode::Vertex,
                                attributes: &[wgpu::VertexAttribute {
                                    format: wgpu::VertexFormat::Float32x2,
                                    offset: 0,
                                    shader_location: 0,
                                }],
                            }],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        },
                        fragment: Some(wgpu::FragmentState {
                            module: &shader_module,
                            entry_point: Some("fragment_main"),
                            targets: &[Some(wgpu::ColorTargetState {
                                format: context.texture_format(),
                                blend: None,
                                write_mask: wgpu::ColorWrites::ALL,
                            })],
                            compilation_options: wgpu::PipelineCompilationOptions::default(),
                        }),
                        primitive: wgpu::PrimitiveState::default(),
                        depth_stencil: None,
                        multisample: wgpu::MultisampleState::default(),
                        multiview_mask: None,
                        cache: None,
                    });
            pipelines.insert(shader_id.to_string(), pipeline);
        }

        Self {
            uniform_bind_group_layout,
            pipelines,
        }
    }

    pub fn apply(
        &self,
        context: &GpuContext,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut encoder =
            context
                .device()
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("effects-command-encoder"),
                });
        let output = self.apply_with_encoder(
            context,
            &mut encoder,
            ApplyEffectsOptions {
                source,
                width,
                height,
                passes,
            },
        )?;
        context.queue().submit([encoder.finish()]);
        Ok(output)
    }

    pub fn apply_with_encoder(
        &self,
        context: &GpuContext,
        encoder: &mut wgpu::CommandEncoder,
        ApplyEffectsOptions {
            source,
            width,
            height,
            passes,
        }: ApplyEffectsOptions<'_>,
    ) -> Result<wgpu::Texture, EffectsError> {
        let mut current_texture: Option<wgpu::Texture> = None;

        for pass in passes {
            let input_texture = current_texture.as_ref().unwrap_or(source);
            let output_texture =
                context.create_render_texture(width, height, "effects-pass-output");
            let input_view = input_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let output_view = output_texture.create_view(&wgpu::TextureViewDescriptor::default());
            let texture_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-texture-bind-group"),
                        layout: context.texture_sampler_bind_group_layout(),
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&input_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(context.linear_sampler()),
                            },
                        ],
                    });
            let uniform_buffer =
                context
                    .device()
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("effects-uniform-buffer"),
                        contents: bytemuck::bytes_of(&pack_effect_uniforms(pass, width, height)?),
                        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
                    });
            let uniform_bind_group =
                context
                    .device()
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("effects-uniform-bind-group"),
                        layout: &self.uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });
            let pipeline = self.pipelines.get(&pass.shader).ok_or_else(|| {
                EffectsError::UnknownEffectShader {
                    shader: pass.shader.clone(),
                }
            })?;

            {
                let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("effects-render-pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &output_view,
                        resolve_target: None,
                        depth_slice: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                            store: wgpu::StoreOp::Store,
                        },
                    })],
                    depth_stencil_attachment: None,
                    occlusion_query_set: None,
                    timestamp_writes: None,
                    multiview_mask: None,
                });
                render_pass.set_pipeline(pipeline);
                render_pass.set_vertex_buffer(0, context.fullscreen_quad().slice(..));
                render_pass.set_bind_group(0, &texture_bind_group, &[]);
                render_pass.set_bind_group(1, &uniform_bind_group, &[]);
                render_pass.draw(0..6, 0..1);
            }

            current_texture = Some(output_texture);
        }

        current_texture.ok_or(EffectsError::MissingEffectPasses)
    }
}

fn pack_effect_uniforms(
    pass: &EffectPass,
    width: u32,
    height: u32,
) -> Result<EffectUniformBuffer, EffectsError> {
    let shader = pass.shader.as_str();
    if shader == COLOR_ADJUST_SHADER_ID {
        let names = [
            "u_exposure",
            "u_contrast",
            "u_saturation",
            "u_temperature",
            "u_tint",
        ];
        for uniform in pass.uniforms.keys() {
            if !names.contains(&uniform.as_str()) {
                return Err(EffectsError::UnsupportedUniform {
                    shader: shader.to_string(),
                    uniform: uniform.clone(),
                });
            }
        }
        // Bounds are enforced here for every frontend, including imported projects.
        return Ok(EffectUniformBuffer {
            resolution: [width as f32, height as f32],
            direction: [
                read_number_uniform(pass, "u_tint")?.clamp(-100.0, 100.0) / 100.0,
                0.0,
            ],
            scalars: [
                read_number_uniform(pass, "u_exposure")?.clamp(-4.0, 4.0),
                read_number_uniform(pass, "u_contrast")?.clamp(-100.0, 100.0) / 100.0,
                read_number_uniform(pass, "u_saturation")?.clamp(0.0, 200.0) / 100.0,
                read_number_uniform(pass, "u_temperature")?.clamp(-100.0, 100.0) / 100.0,
            ],
        });
    }
    if shader != GAUSSIAN_BLUR_SHADER_ID {
        return Err(EffectsError::UnknownEffectShader {
            shader: shader.to_string(),
        });
    }
    let sigma = read_number_uniform(pass, "u_sigma")?;
    let step = read_number_uniform(pass, "u_step")?;
    let direction = read_vec2_uniform(pass, "u_direction")?;

    for uniform in pass.uniforms.keys() {
        if uniform == "u_sigma" || uniform == "u_step" || uniform == "u_direction" {
            continue;
        }
        return Err(EffectsError::UnsupportedUniform {
            shader: shader.to_string(),
            uniform: uniform.clone(),
        });
    }

    Ok(EffectUniformBuffer {
        resolution: [width as f32, height as f32],
        direction,
        scalars: [sigma, step, 0.0, 0.0],
    })
}

fn read_number_uniform(pass: &EffectPass, uniform: &str) -> Result<f32, EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    match value {
        UniformValue::Number(value) if value.is_finite() => Ok(*value),
        _ => Err(EffectsError::InvalidNumberUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        }),
    }
}

fn read_vec2_uniform(pass: &EffectPass, uniform: &str) -> Result<[f32; 2], EffectsError> {
    let Some(value) = pass.uniforms.get(uniform) else {
        return Err(EffectsError::MissingUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
        });
    };
    let UniformValue::Vector(values) = value else {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    };
    if values.len() != 2 {
        return Err(EffectsError::InvalidVectorUniform {
            shader: pass.shader.clone(),
            uniform: uniform.to_string(),
            expected_length: 2,
        });
    }
    Ok([values[0], values[1]])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn color_pass() -> EffectPass {
        EffectPass {
            shader: COLOR_ADJUST_SHADER_ID.into(),
            uniforms: [
                ("u_exposure", 0.0),
                ("u_contrast", 0.0),
                ("u_saturation", 100.0),
                ("u_temperature", 0.0),
                ("u_tint", 0.0),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), UniformValue::Number(value)))
            .collect(),
        }
    }

    #[test]
    fn neutral_color_uniforms_are_identity() {
        let packed = pack_effect_uniforms(&color_pass(), 1920, 1080).unwrap();
        assert_eq!(packed.resolution, [1920.0, 1080.0]);
        assert_eq!(packed.scalars, [0.0, 0.0, 1.0, 0.0]);
        assert_eq!(packed.direction, [0.0, 0.0]);
    }

    #[test]
    fn imported_values_are_bounded() {
        let mut pass = color_pass();
        for key in [
            "u_exposure",
            "u_contrast",
            "u_saturation",
            "u_temperature",
            "u_tint",
        ] {
            pass.uniforms
                .insert(key.into(), UniformValue::Number(1000.0));
        }
        let packed = pack_effect_uniforms(&pass, 1, 1).unwrap();
        assert_eq!(packed.scalars, [4.0, 1.0, 2.0, 1.0]);
        assert_eq!(packed.direction, [1.0, 0.0]);
    }

    #[test]
    fn invalid_color_uniforms_fail_explicitly() {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut pass = color_pass();
            pass.uniforms
                .insert("u_exposure".into(), UniformValue::Number(value));
            assert!(matches!(
                pack_effect_uniforms(&pass, 1, 1),
                Err(EffectsError::InvalidNumberUniform { .. })
            ));
        }
        let mut pass = color_pass();
        pass.uniforms.remove("u_tint");
        assert!(matches!(
            pack_effect_uniforms(&pass, 1, 1),
            Err(EffectsError::MissingUniform { .. })
        ));
    }

    #[test]
    fn unknown_shaders_and_uniforms_fail_explicitly() {
        let mut pass = color_pass();
        pass.uniforms
            .insert("typo".into(), UniformValue::Number(0.0));
        assert!(matches!(
            pack_effect_uniforms(&pass, 1, 1),
            Err(EffectsError::UnsupportedUniform { .. })
        ));
        pass.shader = "missing".into();
        assert!(matches!(
            pack_effect_uniforms(&pass, 1, 1),
            Err(EffectsError::UnknownEffectShader { .. })
        ));
    }

    #[test]
    fn gaussian_blur_packing_is_unchanged() {
        let pass = EffectPass {
            shader: GAUSSIAN_BLUR_SHADER_ID.into(),
            uniforms: HashMap::from([
                ("u_sigma".into(), UniformValue::Number(5.0)),
                ("u_step".into(), UniformValue::Number(1.0)),
                ("u_direction".into(), UniformValue::Vector(vec![1.0, 0.0])),
            ]),
        };
        let packed = pack_effect_uniforms(&pass, 640, 360).unwrap();
        assert_eq!(packed.scalars, [5.0, 1.0, 0.0, 0.0]);
        assert_eq!(packed.direction, [1.0, 0.0]);
    }
}
