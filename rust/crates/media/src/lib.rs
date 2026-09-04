use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

mod cuts;
pub use cuts::{apply_timeline_cuts, CutRange, CutResult};

const DEFAULT_SAMPLE_RATE: u32 = 48_000;
const DEFAULT_AUDIO_BITRATE: &str = "192k";

#[derive(Debug, Clone)]
pub struct MediaEngine {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineHealth {
    pub available: bool,
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
    pub h264_nvenc: bool,
}

#[derive(Debug, Clone)]
pub struct ProxyOptions {
    pub input: PathBuf,
    pub output: PathBuf,
    pub max_width: u32,
    pub max_height: u32,
    pub max_fps: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyResult {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
    pub size_bytes: u64,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub hardware_encoded: bool,
}

#[derive(Debug, Clone)]
pub struct RawVideoOptions {
    pub output: PathBuf,
    pub width: u32,
    pub height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub bitrate: u64,
    pub constant_bitrate: bool,
}

#[derive(Debug, Clone)]
pub struct VideoTranscodeOptions {
    pub fps_numerator: u32,
    pub fps_denominator: u32,
    pub bitrate: u64,
    pub constant_bitrate: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    pub duration_seconds: f64,
    #[serde(default = "default_sample_rate")]
    pub sample_rate: u32,
    #[serde(default)]
    pub clips: Vec<AudioClipSpec>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClipSpec {
    pub source: PathBuf,
    pub start_time: f64,
    pub duration: f64,
    pub trim_start: f64,
    #[serde(default = "default_rate")]
    pub rate: f64,
    #[serde(default)]
    pub maintain_pitch: bool,
    #[serde(default = "default_volume")]
    pub volume: f64,
}

#[derive(Debug, Deserialize)]
struct ProbeOutput {
    #[serde(default)]
    streams: Vec<ProbeStream>,
    format: Option<ProbeFormat>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}

fn default_sample_rate() -> u32 {
    DEFAULT_SAMPLE_RATE
}

fn default_rate() -> f64 {
    1.0
}

fn default_volume() -> f64 {
    1.0
}

impl Default for MediaEngine {
    fn default() -> Self {
        Self {
            ffmpeg: env::var_os("OPENCUT_FFMPEG")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("ffmpeg")),
            ffprobe: env::var_os("OPENCUT_FFPROBE")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("ffprobe")),
        }
    }
}

impl MediaEngine {
    pub fn health(&self) -> Result<EngineHealth> {
        let ffmpeg_version = first_version_line(&self.ffmpeg)?;
        let ffprobe_version = first_version_line(&self.ffprobe)?;
        let encoders = Command::new(&self.ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output()
            .with_context(|| format!("failed to run {}", self.ffmpeg.display()))?;
        let encoder_text = String::from_utf8_lossy(&encoders.stdout);

        Ok(EngineHealth {
            available: true,
            ffmpeg_version,
            ffprobe_version,
            h264_nvenc: encoder_text.contains("h264_nvenc"),
        })
    }

    pub fn generate_proxy(&self, options: &ProxyOptions) -> Result<ProxyResult> {
        validate_input_file(&options.input)?;
        if options.max_width < 2 || options.max_height < 2 || options.max_fps == 0 {
            bail!("proxy dimensions and frame rate must be positive");
        }
        if let Some(parent) = options.output.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let _ = fs::remove_file(&options.output);

        let can_use_nvenc = self
            .health()
            .map(|health| health.h264_nvenc)
            .unwrap_or(false);
        let mut hardware_encoded = false;
        if can_use_nvenc {
            let output = self.run_proxy_command(options, true)?;
            if output.status.success() {
                hardware_encoded = true;
            } else {
                let _ = fs::remove_file(&options.output);
            }
        }

        if !hardware_encoded {
            let output = self.run_proxy_command(options, false)?;
            ensure_success(&output, "FFmpeg proxy generation")?;
        }

        let probe = self.probe(&options.output)?;
        let video = probe
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("video"))
            .context("proxy output has no video stream")?;
        let audio_codec = probe
            .streams
            .iter()
            .find(|stream| stream.codec_type.as_deref() == Some("audio"))
            .and_then(|stream| stream.codec_name.clone());

        Ok(ProxyResult {
            width: video.width.context("proxy width is missing")?,
            height: video.height.context("proxy height is missing")?,
            duration_seconds: parse_probe_number(
                probe
                    .format
                    .as_ref()
                    .and_then(|format| format.duration.as_ref()),
                "duration",
            )?,
            size_bytes: parse_probe_number::<u64>(
                probe
                    .format
                    .as_ref()
                    .and_then(|format| format.size.as_ref()),
                "size",
            )?,
            video_codec: video
                .codec_name
                .clone()
                .unwrap_or_else(|| "unknown".to_owned()),
            audio_codec,
            hardware_encoded,
        })
    }

    pub fn mux_export(
        &self,
        video: &Path,
        output: &Path,
        spec: Option<&ExportSpec>,
        video_transcode: Option<&VideoTranscodeOptions>,
    ) -> Result<()> {
        validate_input_file(video)?;
        if let Some(options) = video_transcode {
            validate_video_transcode_options(options)?;
            if !self.health()?.h264_nvenc {
                bail!("h264_nvenc is unavailable");
            }
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let _ = fs::remove_file(output);

        let mut command = Command::new(&self.ffmpeg);
        command.args(["-hide_banner", "-loglevel", "error", "-y"]);
        command.arg("-i").arg(video);

        if let Some(spec) = spec.filter(|spec| spec.duration_seconds > 0.0) {
            let (sources, filter) = build_audio_filter(spec)?;
            for source in sources {
                validate_input_file(&source)?;
                command.arg("-i").arg(source);
            }
            command
                .arg("-filter_complex")
                .arg(filter)
                .args(["-map", "0:v:0", "-map", "[aout]"]);
            if let Some(options) = video_transcode {
                command.args(nvenc_video_args(options));
            } else {
                command.args(["-c:v", "copy"]);
            }
            command
                .args(["-c:a", "aac", "-b:a", DEFAULT_AUDIO_BITRATE])
                .args(["-movflags", "+faststart", "-shortest"]);
        } else {
            command.args(["-map", "0:v:0", "-map", "0:a?"]);
            if let Some(options) = video_transcode {
                command
                    .args(nvenc_video_args(options))
                    .args(["-c:a", "copy"]);
            } else {
                command.args(["-c", "copy"]);
            }
            command.args(["-movflags", "+faststart"]);
        }

        let result = command
            .arg(output)
            .output()
            .with_context(|| format!("failed to run {}", self.ffmpeg.display()))?;
        ensure_success(&result, "FFmpeg export mux")
    }

    pub fn encode_raw_video(&self, options: &RawVideoOptions) -> Result<()> {
        validate_raw_video_options(options)?;
        if !self.health()?.h264_nvenc {
            bail!("h264_nvenc is unavailable");
        }
        if let Some(parent) = options.output.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let _ = fs::remove_file(&options.output);

        let args = raw_video_args(options);
        let result = Command::new(&self.ffmpeg)
            .args(&args)
            .stdin(Stdio::inherit())
            .output()
            .with_context(|| format!("failed to run {}", self.ffmpeg.display()))?;
        ensure_success(&result, "FFmpeg NVENC export")
    }

    fn run_proxy_command(&self, options: &ProxyOptions, hardware: bool) -> Result<Output> {
        let scale = format!(
            "scale={}:{}:force_original_aspect_ratio=decrease:force_divisible_by=2",
            options.max_width, options.max_height
        );
        let mut command = Command::new(&self.ffmpeg);
        command
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&options.input)
            .args(["-map", "0:v:0", "-map", "0:a?"])
            .arg("-vf")
            .arg(scale)
            .args(["-fpsmax", &options.max_fps.to_string()])
            .args([
                "-pix_fmt",
                "yuv420p",
                "-g",
                "15",
                "-keyint_min",
                "15",
                "-sc_threshold",
                "0",
            ]);

        if hardware {
            command.args([
                "-c:v",
                "h264_nvenc",
                "-preset",
                "p4",
                "-tune",
                "ll",
                "-b:v",
                "6M",
                "-maxrate",
                "8M",
                "-bufsize",
                "12M",
            ]);
        } else {
            command.args([
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-b:v", "0",
            ]);
        }

        command
            .args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
            .arg(&options.output)
            .output()
            .with_context(|| format!("failed to run {}", self.ffmpeg.display()))
    }

    fn probe(&self, path: &Path) -> Result<ProbeOutput> {
        let output = Command::new(&self.ffprobe)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(path)
            .output()
            .with_context(|| format!("failed to run {}", self.ffprobe.display()))?;
        ensure_success(&output, "FFprobe")?;
        serde_json::from_slice(&output.stdout).context("failed to parse FFprobe JSON")
    }
}

fn validate_raw_video_options(options: &RawVideoOptions) -> Result<()> {
    if options.width < 2
        || options.height < 2
        || !options.width.is_multiple_of(2)
        || !options.height.is_multiple_of(2)
    {
        bail!("raw video dimensions must be positive even numbers");
    }
    if options.fps_numerator == 0 || options.fps_denominator == 0 {
        bail!("raw video frame rate must be positive");
    }
    if !(100_000..=200_000_000).contains(&options.bitrate) {
        bail!("raw video bitrate is outside the supported range");
    }
    Ok(())
}

fn validate_video_transcode_options(options: &VideoTranscodeOptions) -> Result<()> {
    if options.fps_numerator == 0 || options.fps_denominator == 0 {
        bail!("video transcode frame rate must be positive");
    }
    if !(100_000..=200_000_000).contains(&options.bitrate) {
        bail!("video transcode bitrate is outside the supported range");
    }
    Ok(())
}

fn raw_video_args(options: &RawVideoOptions) -> Vec<String> {
    let mut args = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pixel_format".into(),
        "bgra".into(),
        "-video_size".into(),
        format!("{}x{}", options.width, options.height),
        "-framerate".into(),
        format!("{}/{}", options.fps_numerator, options.fps_denominator),
        "-i".into(),
        "pipe:0".into(),
        "-an".into(),
    ];
    args.extend(nvenc_video_args(&VideoTranscodeOptions {
        fps_numerator: options.fps_numerator,
        fps_denominator: options.fps_denominator,
        bitrate: options.bitrate,
        constant_bitrate: options.constant_bitrate,
    }));
    args.extend([
        "-movflags".into(),
        "+faststart".into(),
        options.output.display().to_string(),
    ]);
    args
}

fn nvenc_video_args(options: &VideoTranscodeOptions) -> Vec<String> {
    let max_rate = if options.constant_bitrate {
        options.bitrate
    } else {
        options.bitrate.saturating_mul(3) / 2
    };
    let buffer_size = options.bitrate.saturating_mul(2);
    let keyframe_interval =
        (u64::from(options.fps_numerator) * 2 / u64::from(options.fps_denominator)).max(1);
    vec![
        "-c:v".into(),
        "h264_nvenc".into(),
        "-preset".into(),
        "p4".into(),
        "-tune".into(),
        "hq".into(),
        "-rc".into(),
        if options.constant_bitrate {
            "cbr"
        } else {
            "vbr"
        }
        .into(),
        "-multipass".into(),
        "qres".into(),
        "-b:v".into(),
        options.bitrate.to_string(),
        "-maxrate".into(),
        max_rate.to_string(),
        "-bufsize".into(),
        buffer_size.to_string(),
        "-g".into(),
        keyframe_interval.to_string(),
        "-bf".into(),
        "2".into(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ]
}

fn build_audio_filter(spec: &ExportSpec) -> Result<(Vec<PathBuf>, String)> {
    if !spec.duration_seconds.is_finite() || spec.duration_seconds <= 0.0 {
        bail!("export duration must be positive");
    }
    if spec.sample_rate < 8_000 || spec.sample_rate > 192_000 {
        bail!("unsupported export sample rate");
    }

    let mut source_indexes = BTreeMap::<PathBuf, usize>::new();
    for clip in &spec.clips {
        validate_clip(clip)?;
        if !source_indexes.contains_key(&clip.source) {
            let index = source_indexes.len() + 1;
            source_indexes.insert(clip.source.clone(), index);
        }
    }

    let mut filters = Vec::new();
    let mut labels = Vec::new();
    for (clip_index, clip) in spec.clips.iter().enumerate() {
        let input_index = source_indexes[&clip.source];
        let source_duration = clip.duration * clip.rate;
        let mut chain = format!(
            "[{input_index}:a:0]atrim=start={}:duration={},asetpts=PTS-STARTPTS,aresample={}",
            ff(clip.trim_start),
            ff(source_duration),
            spec.sample_rate,
        );
        if (clip.rate - 1.0).abs() > 0.000_001 {
            if clip.maintain_pitch {
                for rate in atempo_chain(clip.rate) {
                    chain.push_str(&format!(",atempo={}", ff(rate)));
                }
            } else {
                chain.push_str(&format!(
                    ",asetrate={}*{},aresample={}",
                    spec.sample_rate,
                    ff(clip.rate),
                    spec.sample_rate
                ));
            }
        }
        chain.push_str(&format!(
            ",atrim=duration={},volume={},adelay={}:all=1,aresample={},aformat=channel_layouts=stereo[a{clip_index}]",
            ff(clip.duration),
            ff(clip.volume),
            (clip.start_time * 1000.0).round() as u64,
            spec.sample_rate,
        ));
        filters.push(chain);
        labels.push(format!("[a{clip_index}]"));
    }

    if labels.is_empty() {
        filters.push(format!(
            "anullsrc=channel_layout=stereo:sample_rate={},atrim=duration={}[aout]",
            spec.sample_rate,
            ff(spec.duration_seconds)
        ));
    } else {
        filters.push(format!(
            "{}amix=inputs={}:duration=longest:normalize=0,alimiter=limit=0.98:attack=5:release=50,atrim=duration={}[aout]",
            labels.join(""),
            labels.len(),
            ff(spec.duration_seconds)
        ));
    }

    let mut sources = vec![PathBuf::new(); source_indexes.len()];
    for (source, input_index) in source_indexes {
        sources[input_index - 1] = source;
    }
    Ok((sources, filters.join(";")))
}

fn validate_clip(clip: &AudioClipSpec) -> Result<()> {
    for (label, value) in [
        ("start time", clip.start_time),
        ("duration", clip.duration),
        ("trim start", clip.trim_start),
        ("rate", clip.rate),
        ("volume", clip.volume),
    ] {
        if !value.is_finite() {
            bail!("audio clip {label} must be finite");
        }
    }
    if clip.start_time < 0.0 || clip.duration <= 0.0 || clip.trim_start < 0.0 {
        bail!("audio clip timing is invalid");
    }
    if !(0.01..=100.0).contains(&clip.rate) || clip.volume < 0.0 {
        bail!("audio clip rate or volume is invalid");
    }
    Ok(())
}

fn atempo_chain(mut rate: f64) -> Vec<f64> {
    let mut result = Vec::new();
    while rate > 2.0 {
        result.push(2.0);
        rate /= 2.0;
    }
    while rate < 0.5 {
        result.push(0.5);
        rate /= 0.5;
    }
    result.push(rate);
    result
}

fn first_version_line(binary: &Path) -> Result<String> {
    let output = Command::new(binary)
        .arg("-version")
        .output()
        .with_context(|| format!("failed to run {}", binary.display()))?;
    ensure_success(&output, "version probe")?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("unknown")
        .to_owned())
}

fn validate_input_file(path: &Path) -> Result<()> {
    let metadata =
        fs::metadata(path).with_context(|| format!("input does not exist: {}", path.display()))?;
    if !metadata.is_file() {
        bail!("input is not a file: {}", path.display());
    }
    Ok(())
}

fn ensure_success(output: &Output, operation: &str) -> Result<()> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    bail!("{operation} failed: {}", stderr.trim());
}

fn parse_probe_number<T>(value: Option<&String>, label: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::error::Error + Send + Sync + 'static,
{
    value
        .context(format!("probe {label} is missing"))?
        .parse::<T>()
        .with_context(|| format!("invalid probe {label}"))
}

fn ff(value: f64) -> String {
    format!("{value:.6}")
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atempo_rates_stay_in_ffmpeg_range() {
        for rate in [0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 16.0] {
            let chain = atempo_chain(rate);
            assert!(chain.iter().all(|part| (0.5..=2.0).contains(part)));
            let product = chain.iter().product::<f64>();
            assert!((product - rate).abs() < 0.000_001);
        }
    }

    #[test]
    fn filter_reuses_inputs_and_builds_delayed_mix() {
        let source = PathBuf::from("clip.mp4");
        let spec = ExportSpec {
            duration_seconds: 10.0,
            sample_rate: 48_000,
            clips: vec![
                AudioClipSpec {
                    source: source.clone(),
                    start_time: 0.0,
                    duration: 4.0,
                    trim_start: 1.0,
                    rate: 1.0,
                    maintain_pitch: false,
                    volume: 0.5,
                },
                AudioClipSpec {
                    source,
                    start_time: 5.0,
                    duration: 2.0,
                    trim_start: 0.0,
                    rate: 2.0,
                    maintain_pitch: true,
                    volume: 1.0,
                },
            ],
        };
        let (sources, filter) = build_audio_filter(&spec).unwrap();
        assert_eq!(sources.len(), 1);
        assert!(filter.contains("[1:a:0]atrim=start=1:duration=4"));
        assert!(filter.contains("atempo=2"));
        assert!(filter.contains("adelay=5000:all=1"));
        assert!(filter.contains("amix=inputs=2"));
        assert!(filter.ends_with("atrim=duration=10[aout]"));
    }

    #[test]
    fn raw_video_uses_bgra_nvenc_and_requested_bitrate() {
        let options = RawVideoOptions {
            output: PathBuf::from("output.mp4"),
            width: 2560,
            height: 1440,
            fps_numerator: 60,
            fps_denominator: 1,
            bitrate: 12_000_000,
            constant_bitrate: false,
        };
        let args = raw_video_args(&options);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-pixel_format", "bgra"]));
        assert!(args.windows(2).any(|pair| pair == ["-c:v", "h264_nvenc"]));
        assert!(args.windows(2).any(|pair| pair == ["-b:v", "12000000"]));
        assert!(args.windows(2).any(|pair| pair == ["-g", "120"]));
    }

    #[test]
    fn nvenc_constant_bitrate_uses_strict_target_rate() {
        let args = nvenc_video_args(&VideoTranscodeOptions {
            fps_numerator: 30,
            fps_denominator: 1,
            bitrate: 3_000_000,
            constant_bitrate: true,
        });
        assert!(args.windows(2).any(|pair| pair == ["-rc", "cbr"]));
        assert!(args.windows(2).any(|pair| pair == ["-maxrate", "3000000"]));
        assert!(args.windows(2).any(|pair| pair == ["-g", "60"]));
    }
}
