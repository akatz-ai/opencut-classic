//! Platform-independent output dimensions and aspect-preserving export fitting.
use serde::Serialize;

#[derive(Debug, PartialEq, Serialize)]
pub struct Dimensions {
    pub width: u32,
    pub height: u32,
}

fn validate(width: f64, height: f64) -> Result<(), String> {
    if [width, height]
        .iter()
        .any(|n| !n.is_finite() || *n <= 0.0 || *n > (u32::MAX - 1) as f64)
    {
        return Err("Project dimensions must be finite positive numbers".into());
    }
    Ok(())
}

fn even(value: f64) -> u32 {
    ((value / 2.0).round() * 2.0).max(2.0) as u32
}

pub fn resolve_dimensions(width: f64, height: f64, preset: &str) -> Result<Dimensions, String> {
    validate(width, height)?;
    if preset == "project" {
        return Ok(Dimensions {
            width: even(width),
            height: even(height),
        });
    }
    let (long, fixed_short) = match preset {
        "insta_hd" => (1920, Some(1080)),
        "insta_2k" => (2560, Some(1440)),
        "insta_4k" => (3840, Some(2160)),
        "2160p" => (3840, None),
        "1440p" => (2560, None),
        "1080p" => (1920, None),
        "720p" => (1280, None),
        _ => return Err("Unknown export resolution preset".into()),
    };
    let short =
        fixed_short.unwrap_or_else(|| even(long as f64 * width.min(height) / width.max(height)));
    Ok(if width >= height {
        Dimensions {
            width: long,
            height: short,
        }
    } else {
        Dimensions {
            width: short,
            height: long,
        }
    })
}

#[derive(Debug, PartialEq, Serialize)]
pub struct ExportFrame {
    pub width: u32,
    pub height: u32,
    pub x: f64,
    pub y: f64,
}

/// Render near output resolution, then center it without stretching the project.
/// Only the final encoded frame requires even dimensions, not the compositor texture.
pub fn fit_frame(
    width: f64,
    height: f64,
    output_width: u32,
    output_height: u32,
) -> Result<ExportFrame, String> {
    validate(width, height)?;
    if output_width < 2 || output_height < 2 {
        return Err("Output dimensions must be at least two pixels".into());
    }
    let scale = (output_width as f64 / width).min(output_height as f64 / height);
    let fitted_width = (width * scale).round().max(1.0).min(output_width as f64) as u32;
    let fitted_height = (height * scale).round().max(1.0).min(output_height as f64) as u32;
    Ok(ExportFrame {
        width: fitted_width,
        height: fitted_height,
        x: (output_width - fitted_width) as f64 / 2.0,
        y: (output_height - fitted_height) as f64 / 2.0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instagram_dimensions_are_exact_in_both_orientations() {
        for (preset, long, short) in [
            ("insta_hd", 1920, 1080),
            ("insta_2k", 2560, 1440),
            ("insta_4k", 3840, 2160),
        ] {
            assert_eq!(
                resolve_dimensions(1080.0, 1920.0, preset).unwrap(),
                Dimensions {
                    width: short,
                    height: long
                }
            );
            assert_eq!(
                resolve_dimensions(1920.0, 1080.0, preset).unwrap(),
                Dimensions {
                    width: long,
                    height: short
                }
            );
            // The user's actual project is 7:4, not 16:9.
            assert_eq!(
                resolve_dimensions(2688.0, 1536.0, preset).unwrap(),
                Dimensions {
                    width: long,
                    height: short
                }
            );
        }
    }

    #[test]
    fn legacy_presets_keep_project_ratio() {
        assert_eq!(
            resolve_dimensions(2688.0, 1536.0, "2160p").unwrap(),
            Dimensions {
                width: 3840,
                height: 2194
            }
        );
        assert_eq!(
            resolve_dimensions(1001.0, 777.0, "project").unwrap(),
            Dimensions {
                width: 1002,
                height: 778
            }
        );
    }

    #[test]
    fn fit_preserves_picture_and_centers_padding() {
        assert_eq!(
            fit_frame(2688.0, 1536.0, 3840, 2160).unwrap(),
            ExportFrame {
                width: 3780,
                height: 2160,
                x: 30.0,
                y: 0.0
            }
        );
        assert_eq!(
            fit_frame(1536.0, 2688.0, 2160, 3840).unwrap(),
            ExportFrame {
                width: 2160,
                height: 3780,
                x: 0.0,
                y: 30.0
            }
        );
        assert_eq!(
            fit_frame(1080.0, 1920.0, 2160, 3840).unwrap(),
            ExportFrame {
                width: 2160,
                height: 3840,
                x: 0.0,
                y: 0.0
            }
        );
        assert_eq!(
            fit_frame(1000.0, 1000.0, 1920, 1080).unwrap(),
            ExportFrame {
                width: 1080,
                height: 1080,
                x: 420.0,
                y: 0.0
            }
        );
    }

    #[test]
    fn invalid_dimensions_and_presets_are_rejected() {
        for value in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(resolve_dimensions(value, 1920.0, "insta_hd").is_err());
            assert!(fit_frame(1080.0, value, 1080, 1920).is_err());
        }
        assert!(resolve_dimensions(1920.0, 1080.0, "unknown").is_err());
    }
}
