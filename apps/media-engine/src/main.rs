use std::{env, fs, path::PathBuf};

use anyhow::{bail, Context, Result};
use media::{
    apply_timeline_cuts, CutRange, ExportSpec, MediaEngine, ProxyOptions, RawVideoOptions,
    VideoTranscodeOptions,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = env::args().skip(1);
    let command = args.next().context("missing command")?;
    let options = parse_options(args.collect())?;
    let engine = MediaEngine::default();

    match command.as_str() {
        "health" => {
            println!("{}", serde_json::to_string(&engine.health()?)?);
        }
        "proxy" => {
            let result = engine.generate_proxy(&ProxyOptions {
                input: required_path(&options, "input")?,
                output: required_path(&options, "output")?,
                max_width: optional_u32(&options, "max-width", 1280)?,
                max_height: optional_u32(&options, "max-height", 720)?,
                max_fps: optional_u32(&options, "max-fps", 30)?,
            })?;
            println!("{}", serde_json::to_string(&result)?);
        }
        "mux-export" => {
            let video = required_path(&options, "video")?;
            let output = required_path(&options, "output")?;
            let spec = options
                .get("spec")
                .map(|path| -> Result<ExportSpec> {
                    let bytes = fs::read(path)
                        .with_context(|| format!("failed to read export spec {path}"))?;
                    serde_json::from_slice(&bytes).context("failed to parse export spec")
                })
                .transpose()?;
            let video_transcode = options
                .get("video-bitrate")
                .map(|_| -> Result<VideoTranscodeOptions> {
                    Ok(VideoTranscodeOptions {
                        fps_numerator: required_u32(&options, "fps-numerator")?,
                        fps_denominator: required_u32(&options, "fps-denominator")?,
                        bitrate: required_u64(&options, "video-bitrate")?,
                        constant_bitrate: constant_bitrate(&options)?,
                    })
                })
                .transpose()?;
            engine.mux_export(&video, &output, spec.as_ref(), video_transcode.as_ref())?;
            println!("{}", serde_json::json!({ "success": true }));
        }
        "encode-raw-video" => {
            engine.encode_raw_video(&RawVideoOptions {
                output: required_path(&options, "output")?,
                width: required_u32(&options, "width")?,
                height: required_u32(&options, "height")?,
                fps_numerator: required_u32(&options, "fps-numerator")?,
                fps_denominator: required_u32(&options, "fps-denominator")?,
                bitrate: required_u64(&options, "bitrate")?,
                constant_bitrate: constant_bitrate(&options)?,
            })?;
            println!("{}", serde_json::json!({ "success": true }));
        }
        "apply-cuts" => {
            let tracks: serde_json::Value =
                serde_json::from_slice(&fs::read(required_path(&options, "tracks")?)?)?;
            let ranges: Vec<CutRange> =
                serde_json::from_slice(&fs::read(required_path(&options, "ranges")?)?)?;
            println!(
                "{}",
                serde_json::to_string(&apply_timeline_cuts(tracks, ranges)?)?
            );
        }
        _ => bail!("unknown command: {command}"),
    }

    Ok(())
}

fn parse_options(args: Vec<String>) -> Result<std::collections::BTreeMap<String, String>> {
    let mut options = std::collections::BTreeMap::new();
    let mut iterator = args.into_iter();
    while let Some(flag) = iterator.next() {
        let key = flag
            .strip_prefix("--")
            .with_context(|| format!("expected option, got {flag}"))?;
        let value = iterator
            .next()
            .with_context(|| format!("missing value for --{key}"))?;
        options.insert(key.to_owned(), value);
    }
    Ok(options)
}

fn required_path(
    options: &std::collections::BTreeMap<String, String>,
    key: &str,
) -> Result<PathBuf> {
    options
        .get(key)
        .map(PathBuf::from)
        .with_context(|| format!("missing --{key}"))
}

fn optional_u32(
    options: &std::collections::BTreeMap<String, String>,
    key: &str,
    fallback: u32,
) -> Result<u32> {
    options
        .get(key)
        .map(|value| value.parse().with_context(|| format!("invalid --{key}")))
        .transpose()
        .map(|value| value.unwrap_or(fallback))
}

fn required_u32(options: &std::collections::BTreeMap<String, String>, key: &str) -> Result<u32> {
    options
        .get(key)
        .with_context(|| format!("missing --{key}"))?
        .parse()
        .with_context(|| format!("invalid --{key}"))
}

fn required_u64(options: &std::collections::BTreeMap<String, String>, key: &str) -> Result<u64> {
    options
        .get(key)
        .with_context(|| format!("missing --{key}"))?
        .parse()
        .with_context(|| format!("invalid --{key}"))
}

fn constant_bitrate(options: &std::collections::BTreeMap<String, String>) -> Result<bool> {
    match options.get("bitrate-mode").map(String::as_str) {
        None | Some("variable") => Ok(false),
        Some("constant") => Ok(true),
        Some(value) => bail!("invalid --bitrate-mode: {value}"),
    }
}
