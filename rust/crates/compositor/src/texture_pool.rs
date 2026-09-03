use std::collections::HashMap;

use gpu::{GpuContext, wgpu};

type TextureKey = (u32, u32);

const BYTES_PER_PIXEL: u64 = 4;
const MAX_CACHED_TEXTURES_PER_SIZE: usize = 24;
const MAX_CACHED_TEXTURE_BYTES: u64 = 512 * 1024 * 1024;

fn texture_bytes((width, height): TextureKey) -> u64 {
    u64::from(width)
        .saturating_mul(u64::from(height))
        .saturating_mul(BYTES_PER_PIXEL)
}

fn max_cached_textures_for_size(key: TextureKey) -> usize {
    let bytes = texture_bytes(key).max(1);
    usize::try_from(MAX_CACHED_TEXTURE_BYTES / bytes)
        .unwrap_or(MAX_CACHED_TEXTURES_PER_SIZE)
        .clamp(1, MAX_CACHED_TEXTURES_PER_SIZE)
}

#[derive(Default)]
pub struct TexturePool {
    available: HashMap<TextureKey, Vec<wgpu::Texture>>,
    in_use: Vec<(TextureKey, wgpu::Texture)>,
}

impl TexturePool {
    pub fn recycle_frame(&mut self) {
        for (key, texture) in self.in_use.drain(..) {
            self.available.entry(key).or_default().push(texture);
        }

        for (key, textures) in &mut self.available {
            textures.truncate(max_cached_textures_for_size(*key));
        }
        self.available.retain(|_, textures| !textures.is_empty());

        while self.cached_texture_bytes() > MAX_CACHED_TEXTURE_BYTES {
            let Some(key) = self
                .available
                .iter()
                .filter(|(_, textures)| !textures.is_empty())
                .max_by_key(|(key, textures)| {
                    texture_bytes(**key).saturating_mul(textures.len() as u64)
                })
                .map(|(key, _)| *key)
            else {
                break;
            };

            let should_remove = self.available.get_mut(&key).is_some_and(|textures| {
                textures.pop();
                textures.is_empty()
            });
            if should_remove {
                self.available.remove(&key);
            }
        }
    }

    fn cached_texture_bytes(&self) -> u64 {
        self.available
            .iter()
            .map(|(key, textures)| texture_bytes(*key).saturating_mul(textures.len() as u64))
            .sum()
    }

    pub fn acquire(
        &mut self,
        context: &GpuContext,
        width: u32,
        height: u32,
        label: &'static str,
    ) -> wgpu::Texture {
        let key = (width, height);
        let texture = self
            .available
            .get_mut(&key)
            .and_then(Vec::pop)
            .unwrap_or_else(|| context.create_render_texture(width, height, label));
        self.in_use.push((key, texture.clone()));
        texture
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_small_textures_by_entry_count() {
        assert_eq!(max_cached_textures_for_size((1920, 1080)), 24);
    }

    #[test]
    fn limits_large_textures_by_memory_budget() {
        assert_eq!(max_cached_textures_for_size((3840, 2160)), 16);
        assert_eq!(max_cached_textures_for_size((7680, 4320)), 4);
    }

    #[test]
    fn handles_degenerate_dimensions_without_dividing_by_zero() {
        assert_eq!(max_cached_textures_for_size((0, 0)), 24);
    }
}
